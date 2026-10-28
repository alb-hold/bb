import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi, PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import { getThread, listQueuedThreadMessages } from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
} from "@bb/domain";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it } from "vitest";
import { setPluginThreadEventEmitter } from "../../src/services/plugins/plugin-thread-events.js";
import { buildTurnFailedEvent } from "../../src/services/threads/turn-failed.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import { retryFailedTurn } from "../../src/services/threads/turn-retry.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import {
  internalAuthHeaders,
  listQueuedThreadCommands,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";

const PROVIDER_THREAD_ID = "provider-session";
const TURN_ID = "turn-1";
const RETRY_TURN_ID = "turn-retry";

interface ParentedProviderExitScenario {
  child: ReturnType<typeof seedThread>;
  parent: ReturnType<typeof seedThread>;
  sessionId: string;
  turnId: string;
}

function seedParentedProviderExitScenario(
  harness: TestAppHarness,
  attemptNumber = 1,
): ParentedProviderExitScenario {
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const parent = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    inputText: "Coordinate child work",
    providerThreadId: "parent-session",
    threadId: parent.id,
  });
  const child = seedThread(harness.deps, {
    environmentId: environment.id,
    parentThreadId: parent.id,
    projectId: project.id,
    providerId: "claude-code",
    status: "active",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    inputText: "Do the thing",
    providerThreadId: PROVIDER_THREAD_ID,
    threadId: child.id,
  });
  seedTurnStarted(harness.deps, {
    environmentId: environment.id,
    providerThreadId: PROVIDER_THREAD_ID,
    threadId: child.id,
    turnId: TURN_ID,
    sequence: 3,
  });
  if (attemptNumber >= 2) {
    const originalRequestId = encodeClientTurnRequestIdNumber({ value: 1 });
    seedEvent(harness.deps, {
      environmentId: environment.id,
      providerThreadId: PROVIDER_THREAD_ID,
      sequence: 4,
      threadId: child.id,
      type: "client/turn/requested",
      scope: threadScope(),
      data: {
        direction: "outbound",
        requestId: encodeClientTurnRequestIdNumber({ value: 2 }),
        retryOfRequestId: originalRequestId,
        retryAttempt: 2,
        source: "tell",
        initiator: "system",
        senderThreadId: null,
        input: [{ type: "text", text: "Do the thing" }],
        target: { kind: "new-turn" },
        request: { method: "turn/start", params: {} },
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          source: "client/turn/requested",
        },
      },
    });
    seedTurnStarted(harness.deps, {
      environmentId: environment.id,
      providerThreadId: PROVIDER_THREAD_ID,
      threadId: child.id,
      turnId: RETRY_TURN_ID,
      sequence: 5,
    });
  }
  return {
    child,
    parent,
    sessionId: session.id,
    turnId: attemptNumber >= 2 ? RETRY_TURN_ID : TURN_ID,
  };
}

async function createProviderRetryHost(
  harness: TestAppHarness,
  onRetry?: (result: Awaited<ReturnType<typeof retryFailedTurn>>) => void,
) {
  const retryModule = await import(
    new URL("../../../../plugins/provider-retry/server.ts", import.meta.url)
      .href
  );
  const providerRetryPlugin: (bb: BbPluginApi) => Promise<void> =
    retryModule.default;
  const retry = createFakePluginHost({
    pluginId: "provider-retry",
    sdk: {
      threads: {
        retry: async (request) => {
          const current = getThread(harness.db, request.threadId);
          if (current === null) throw new Error("expected a thread");
          const result = await retryFailedTurn(harness.deps, {
            thread: current,
            request: {
              turnRequestId: request.turnRequestId ?? null,
              sendAt: request.sendAt ?? null,
              reason: request.reason ?? "Provider process exited",
            },
          });
          onRetry?.(result);
          return result;
        },
      },
    },
  });
  await providerRetryPlugin(retry.bb);
  return retry;
}

function failureEvents(args: {
  errorCode: string;
  threadId: string;
  turnId: string;
}): HostDaemonEventEnvelope[] {
  const message = 'Provider "claude-code" exited unexpectedly with code -1';
  return [
    {
      threadId: args.threadId,
      event: {
        type: "turn/completed",
        threadId: args.threadId,
        providerThreadId: PROVIDER_THREAD_ID,
        scope: turnScope(args.turnId),
        status: "failed",
        error: { message },
      },
    },
    {
      threadId: args.threadId,
      event: {
        type: "system/error",
        threadId: args.threadId,
        scope: turnScope(args.turnId),
        code: args.errorCode,
        message,
      },
    },
  ];
}

async function postEvents(
  harness: TestAppHarness,
  sessionId: string,
  events: HostDaemonEventEnvelope[],
): Promise<Response> {
  return harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness),
    body: JSON.stringify({
      sessionId,
      eventGroups: groupHostDaemonEvents(events),
    }),
  });
}

afterEach(() => {
  setPluginThreadEventEmitter(undefined);
});

function captureTurnFailed(
  build: (threadId: string) => PluginTurnFailedEvent | null,
  onFailure?: (failure: PluginTurnFailedEvent) => Promise<void>,
): PluginTurnFailedEvent[] {
  const failures: PluginTurnFailedEvent[] = [];
  setPluginThreadEventEmitter({
    emitThreadEvents: () => {},
    emitTerminalInput: () => {},
    emitHostDeleted: () => {},
    emitEnvironmentRemoved: () => {},
    emitThreadCreated: () => {},
    emitThreadActive: () => {},
    emitThreadIdle: () => {},
    emitThreadFailed: () => {},
    emitThreadArchived: () => {},
    emitThreadDeleted: () => {},
    emitInteractionPending: () => {},
    emitMessageQueued: () => {},
    emitMessageDispatched: () => {},
    emitMessageCancelled: () => {},
    emitThreadUnarchived: () => {},
    emitThreadParentChanged: () => {},
    emitTurnFailed: async (threadId) => {
      const failure = build(threadId);
      if (failure === null) return;
      failures.push(failure);
      await onFailure?.(failure);
    },
  });
  return failures;
}

describe("a provider process that exits under a running turn", () => {
  it("does not notify a parent while its retry decision is pending", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const parent = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        inputText: "Coordinate child work",
        providerThreadId: "parent-session",
        threadId: parent.id,
      });
      const child = seedThread(harness.deps, {
        environmentId: environment.id,
        parentThreadId: parent.id,
        projectId: project.id,
        providerId: "claude-code",
        status: "active",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        inputText: "Do the thing",
        providerThreadId: PROVIDER_THREAD_ID,
        threadId: child.id,
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: PROVIDER_THREAD_ID,
        threadId: child.id,
        turnId: TURN_ID,
      });
      let startRetryDecision!: () => void;
      const retryDecisionGate = new Promise<void>((resolve) => {
        startRetryDecision = resolve;
      });
      let markRetryDecisionPending!: () => void;
      const retryDecisionPending = new Promise<void>((resolve) => {
        markRetryDecisionPending = resolve;
      });
      let markRetryQueued!: (delivery: string) => void;
      const retryQueued = new Promise<string>((resolve) => {
        markRetryQueued = resolve;
      });
      const retryErrors: string[] = [];
      const retryModule = await import(
        new URL("../../../../plugins/provider-retry/server.ts", import.meta.url)
          .href
      );
      const providerRetryPlugin: (bb: BbPluginApi) => Promise<void> =
        retryModule.default;
      const retry = createFakePluginHost({
        pluginId: "provider-retry",
        sdk: {
          threads: {
            retry: async (request) => {
              const current = getThread(harness.db, request.threadId);
              if (current === null) throw new Error("expected a thread");
              const result = await retryFailedTurn(harness.deps, {
                thread: current,
                request: {
                  turnRequestId: request.turnRequestId ?? null,
                  sendAt: request.sendAt ?? null,
                  reason: request.reason ?? "Provider process exited",
                },
              });
              markRetryQueued(result.delivery);
              return result;
            },
          },
        },
      });
      try {
        await providerRetryPlugin(retry.bb);
        captureTurnFailed(
          (threadId) => buildTurnFailedEvent(harness.db, threadId),
          async (failure) => {
            markRetryDecisionPending();
            await retryDecisionGate;
            const emitted = await retry.harness.behavior.emitThreadEvent(
              "turn.failed",
              failure,
            );
            retryErrors.push(...emitted.errors.map(String));
          },
        );
        const message =
          'Provider "claude-code" exited unexpectedly with code -1';
        const events: HostDaemonEventEnvelope[] = [
          {
            threadId: child.id,
            event: {
              type: "turn/completed",
              threadId: child.id,
              providerThreadId: PROVIDER_THREAD_ID,
              scope: turnScope(TURN_ID),
              status: "failed",
              error: { message },
            },
          },
          {
            threadId: child.id,
            event: {
              type: "system/error",
              threadId: child.id,
              scope: turnScope(TURN_ID),
              code: "provider_process_exited",
              message,
            },
          },
        ];
        const response = await harness.app.request("/internal/session/events", {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            eventGroups: groupHostDaemonEvents(events),
          }),
        });

        expect(response.status).toBe(200);
        await retryDecisionPending;
        expect(getThread(harness.db, child.id)?.status).toBe("error");
        const earlyFailure = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "turn.submit" && command.threadId === parent.id,
          2_500,
        ).catch(() => null);
        expect(earlyFailure).toBeNull();
        startRetryDecision();
        await expect(retryQueued).resolves.toBe("queued");
        expect(retryErrors).toEqual([]);
        expect(getThread(harness.db, child.id)?.status).toBe("error");
        const laterFailure = listQueuedThreadCommands(
          harness,
          "turn.submit",
          parent.id,
        );
        expect(laterFailure).toEqual([]);
      } finally {
        startRetryDecision();
        await retry.harness.dispose();
      }
    });
  });

  it.each([
    {
      attemptNumber: 2,
      errorCode: "provider_process_exited",
      caseName: "exhausted retry",
    },
    {
      attemptNumber: 1,
      errorCode: "provider_unknown_error",
      caseName: "non-retryable failure",
    },
  ])(
    "notifies a parent once for a $caseName",
    async ({ attemptNumber, errorCode }) => {
      await withTestHarness(async (harness) => {
        const scenario = seedParentedProviderExitScenario(
          harness,
          attemptNumber,
        );
        const retry = await createProviderRetryHost(harness);
        const retryErrors: string[] = [];
        captureTurnFailed(
          (threadId) => buildTurnFailedEvent(harness.db, threadId),
          async (failure) => {
            const emitted = await retry.harness.behavior.emitThreadEvent(
              "turn.failed",
              failure,
            );
            retryErrors.push(...emitted.errors.map(String));
          },
        );
        try {
          const response = await postEvents(
            harness,
            scenario.sessionId,
            failureEvents({
              errorCode,
              threadId: scenario.child.id,
              turnId: scenario.turnId,
            }),
          );

          expect(response.status).toBe(200);
          expect(getThread(harness.db, scenario.child.id)?.status).toBe(
            "error",
          );
          expect(
            listQueuedThreadMessages(harness.db, scenario.child.id),
          ).toEqual([]);
          const parentFailure = await waitForQueuedCommand(
            harness,
            ({ command }) =>
              command.type === "turn.submit" &&
              command.threadId === scenario.parent.id,
            3_000,
          );
          if (parentFailure.command.type !== "turn.submit") {
            throw new Error("expected a parent turn submission");
          }
          const [input] = parentFailure.command.input;
          expect(input?.type).toBe("text");
          if (input?.type !== "text") {
            throw new Error("expected a parent failure notification");
          }
          expect(input.text).toContain("failed.");
          expect(input.text).toContain(
            "Review the thread before deciding next steps.",
          );
          await new Promise((resolve) => setTimeout(resolve, 2_100));
          expect(
            listQueuedThreadCommands(
              harness,
              "turn.submit",
              scenario.parent.id,
            ),
          ).toHaveLength(1);
          expect(retryErrors).toEqual([]);
        } finally {
          await retry.harness.dispose();
        }
      });
    },
    10_000,
  );

  it("notifies the parent of the successful retry without its earlier failure", async () => {
    await withTestHarness(async (harness) => {
      const scenario = seedParentedProviderExitScenario(harness);
      let resolveRetry!: (
        result: Awaited<ReturnType<typeof retryFailedTurn>>,
      ) => void;
      const retryResult = new Promise<
        Awaited<ReturnType<typeof retryFailedTurn>>
      >((resolve) => {
        resolveRetry = resolve;
      });
      const retry = await createProviderRetryHost(harness, resolveRetry);
      const retryErrors: string[] = [];
      captureTurnFailed(
        (threadId) => buildTurnFailedEvent(harness.db, threadId),
        async (failure) => {
          const emitted = await retry.harness.behavior.emitThreadEvent(
            "turn.failed",
            failure,
          );
          retryErrors.push(...emitted.errors.map(String));
        },
      );
      try {
        const response = await postEvents(
          harness,
          scenario.sessionId,
          failureEvents({
            errorCode: "provider_process_exited",
            threadId: scenario.child.id,
            turnId: scenario.turnId,
          }),
        );

        expect(response.status).toBe(200);
        expect(getThread(harness.db, scenario.child.id)?.status).toBe("error");
        await expect(retryResult).resolves.toMatchObject({
          delivery: "queued",
        });
        const queuedRetry = listQueuedThreadMessages(
          harness.db,
          scenario.child.id,
        )[0];
        if (queuedRetry === undefined) throw new Error("expected a retry row");
        await runQueuedMessageDispatch(harness.deps, {
          kind: "time-reached",
          now: (queuedRetry.sendAt ?? Date.now()) + 1,
        });
        const retriedChild = getThread(harness.db, scenario.child.id);
        if (retriedChild === null) throw new Error("expected the child thread");
        seedTurnStarted(harness.deps, {
          environmentId: retriedChild.environmentId,
          providerThreadId: PROVIDER_THREAD_ID,
          threadId: scenario.child.id,
          turnId: RETRY_TURN_ID,
        });
        const completion = await postEvents(harness, scenario.sessionId, [
          {
            threadId: scenario.child.id,
            event: {
              type: "turn/completed",
              threadId: scenario.child.id,
              providerThreadId: PROVIDER_THREAD_ID,
              scope: turnScope(RETRY_TURN_ID),
              status: "completed",
            },
          },
        ]);

        expect(completion.status).toBe(200);
        expect(getThread(harness.db, scenario.child.id)?.status).toBe("idle");
        const parentCompletion = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "turn.submit" &&
            command.threadId === scenario.parent.id,
          3_000,
        );
        if (parentCompletion.command.type !== "turn.submit") {
          throw new Error("expected a parent turn submission");
        }
        const [input] = parentCompletion.command.input;
        expect(input?.type).toBe("text");
        if (input?.type !== "text") {
          throw new Error("expected a parent completion notification");
        }
        expect(input.text).toContain("completed:");
        expect(input.text).not.toContain("failed.");
        expect(input.text).not.toContain(
          "Review the thread before deciding next steps.",
        );
        expect(
          listQueuedThreadCommands(harness, "turn.submit", scenario.parent.id),
        ).toHaveLength(1);
        expect(retryErrors).toEqual([]);
      } finally {
        await retry.harness.dispose();
      }
    });
  });

  it("is announced as a failure the retry plugin re-queues once", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "claude-code",
        status: "active",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        inputText: "Do the thing",
        providerThreadId: PROVIDER_THREAD_ID,
        threadId: thread.id,
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: PROVIDER_THREAD_ID,
        threadId: thread.id,
        turnId: TURN_ID,
      });
      const failures = captureTurnFailed((threadId) =>
        buildTurnFailedEvent(harness.db, threadId),
      );
      const message = 'Provider "claude-code" exited unexpectedly with code -1';
      const events: HostDaemonEventEnvelope[] = [
        {
          threadId: thread.id,
          event: {
            type: "turn/completed",
            threadId: thread.id,
            providerThreadId: PROVIDER_THREAD_ID,
            scope: turnScope(TURN_ID),
            status: "failed",
            error: { message },
          },
        },
        {
          threadId: thread.id,
          event: {
            type: "system/error",
            threadId: thread.id,
            scope: turnScope(TURN_ID),
            code: "provider_process_exited",
            message,
          },
        },
      ];

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents(events),
        }),
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.status).toBe("error");
      const failure = failures.at(-1);
      if (failure === undefined) throw new Error("expected a turn.failed");

      const retryModule = await import(
        new URL("../../../../plugins/provider-retry/server.ts", import.meta.url)
          .href
      );
      const providerRetryPlugin: (bb: BbPluginApi) => Promise<void> =
        retryModule.default;
      const retry = createFakePluginHost({
        pluginId: "provider-retry",
        sdk: {
          threads: {
            retry: async (request) => {
              const current = getThread(harness.db, request.threadId);
              if (current === null) throw new Error("expected a thread");
              return retryFailedTurn(harness.deps, {
                thread: current,
                request: {
                  turnRequestId: request.turnRequestId ?? null,
                  sendAt: request.sendAt ?? null,
                  reason: request.reason ?? "Provider process exited",
                },
              });
            },
          },
        },
      });
      try {
        await providerRetryPlugin(retry.bb);
        expect(
          (await retry.harness.behavior.emitThreadEvent("turn.failed", failure))
            .errors,
        ).toEqual([]);
        const queued = listQueuedThreadMessages(harness.db, thread.id);
        expect(queued).toHaveLength(1);
        expect(toThreadQueuedMessage(queued[0]!).payload).toMatchObject({
          kind: "retry",
          retryOfTurnRequestId: failure.requestId,
          attempt: 2,
          reason: "Provider process exited",
        });
        expect(failure.errorInfo).toEqual({
          category: "internal",
          providerCode: "provider_process_exited",
          httpStatusCode: null,
        });
      } finally {
        await retry.harness.dispose();
      }
    });
  });

  it("is not classified when the thread-level error is some other code", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "claude-code",
        status: "active",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        inputText: "Do the thing",
        providerThreadId: PROVIDER_THREAD_ID,
        threadId: thread.id,
      });
      const events: HostDaemonEventEnvelope[] = [
        {
          threadId: thread.id,
          event: {
            type: "system/error",
            threadId: thread.id,
            scope: threadScope(),
            code: "thread_command_failed",
            message: "Command failed",
          },
        },
      ];
      await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents(events),
        }),
      });

      expect(buildTurnFailedEvent(harness.db, thread.id)?.errorInfo).toBeNull();
    });
  });

  it("does not classify a thread-scoped process exit after a failed turn", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "claude-code",
        status: "active",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        inputText: "Do the thing",
        providerThreadId: PROVIDER_THREAD_ID,
        threadId: thread.id,
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: PROVIDER_THREAD_ID,
        threadId: thread.id,
        turnId: TURN_ID,
      });
      const message = 'Provider "claude-code" exited unexpectedly with code -1';
      const events: HostDaemonEventEnvelope[] = [
        {
          threadId: thread.id,
          event: {
            type: "turn/completed",
            threadId: thread.id,
            providerThreadId: PROVIDER_THREAD_ID,
            scope: turnScope(TURN_ID),
            status: "failed",
            error: { message },
          },
        },
        {
          threadId: thread.id,
          event: {
            type: "system/error",
            threadId: thread.id,
            scope: threadScope(),
            code: "provider_process_exited",
            message,
          },
        },
      ];

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents(events),
        }),
      });

      expect(response.status).toBe(200);
      const failure = buildTurnFailedEvent(harness.db, thread.id);
      if (failure === null) throw new Error("expected a turn.failed");
      expect(failure.errorInfo).toBeNull();
      const retryPolicy = await import(
        new URL(
          "../../../../plugins/provider-retry/src/retry-policy.ts",
          import.meta.url,
        ).href
      );
      expect(
        retryPolicy.decideRetry({
          availability: { kind: "not-routed" },
          failure,
          maximumWaitMs: null,
          now: Date.now(),
          random: 0,
        }),
      ).toEqual({ kind: "decline", reason: "not-retryable" });
    });
  });
});
