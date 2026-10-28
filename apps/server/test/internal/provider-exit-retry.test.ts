import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi, PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import { getThread, listQueuedThreadMessages } from "@bb/db";
import { threadScope, turnScope } from "@bb/domain";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it } from "vitest";
import { setPluginThreadEventEmitter } from "../../src/services/plugins/plugin-thread-events.js";
import { buildTurnFailedEvent } from "../../src/services/threads/turn-failed.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import { retryFailedTurn } from "../../src/services/threads/turn-retry.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const PROVIDER_THREAD_ID = "provider-session";
const TURN_ID = "turn-1";

afterEach(() => {
  setPluginThreadEventEmitter(undefined);
});

function captureTurnFailed(
  build: (threadId: string) => PluginTurnFailedEvent | null,
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
    emitTurnFailed: (threadId) => {
      const failure = build(threadId);
      if (failure !== null) failures.push(failure);
    },
  });
  return failures;
}

describe("a provider process that exits under a running turn", () => {
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
                  reason: request.reason ?? "Provider unavailable",
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
});
