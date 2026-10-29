import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getThread, listQueuedThreadMessages, threads } from "@bb/db";
import { eq } from "drizzle-orm";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
} from "@bb/domain";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import { getLastThreadErrorMessage } from "../../src/services/threads/thread-data.js";
import { retryFailedTurn } from "../../src/services/threads/turn-retry.js";
import {
  internalAuthHeaders,
  listQueuedThreadCommands,
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
const FIRST_TURN_ID = "turn-1";
const RETRY_TURN_ID = "turn-2";
const UNAUTHORIZED_DETAIL =
  "Failed to authenticate. API Error: 401 Invalid Account Pooler bearer token.";
const NOTICE_SETTLE_MS = 2_600;

interface Scenario {
  child: ReturnType<typeof seedThread>;
  parent: ReturnType<typeof seedThread>;
  sessionId: string;
}

function seedScenario(harness: TestAppHarness): Scenario {
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
  seedEvent(harness.deps, {
    environmentId: environment.id,
    providerThreadId: PROVIDER_THREAD_ID,
    sequence: 3,
    threadId: child.id,
    type: "client/turn/requested",
    scope: threadScope(),
    data: {
      direction: "outbound",
      requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
      source: "tell",
      initiator: "system",
      senderThreadId: null,
      input: [{ type: "text", text: "Do the thing" }],
      target: { kind: "new-turn" },
      request: { method: "turn/start", params: {} },
      execution: {
        model: "claude-sonnet-5-5",
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
    turnId: FIRST_TURN_ID,
    sequence: 4,
  });
  return { child, parent, sessionId: session.id };
}

function unauthorizedFailureEvents(args: {
  threadId: string;
  turnId: string;
  category?: "unauthorized" | "internal";
  trailingCategory?: "unauthorized" | "internal";
}): HostDaemonEventEnvelope[] {
  const scope = turnScope(args.turnId);
  const base = {
    threadId: args.threadId,
    providerThreadId: PROVIDER_THREAD_ID,
    scope,
  };
  const events: HostDaemonEventEnvelope[] = [
    {
      threadId: args.threadId,
      event: {
        ...base,
        type: "provider/error",
        message: "Provider error",
        detail: "Claude Code API retry 1/10 after 597ms: HTTP 401",
        willRetry: true,
      },
    },
    {
      threadId: args.threadId,
      event: {
        ...base,
        type: "provider/error",
        message: "Provider error",
        detail: UNAUTHORIZED_DETAIL,
        errorInfo: {
          category: args.category ?? "unauthorized",
          providerCode: null,
          httpStatusCode: 401,
        },
      },
    },
  ];
  if (args.trailingCategory !== undefined) {
    events.push({
      threadId: args.threadId,
      event: {
        ...base,
        type: "provider/error",
        message: "Provider error",
        detail: "Provider failed after retrying the unauthorized request",
        errorInfo: {
          category: args.trailingCategory,
          providerCode: null,
          httpStatusCode: null,
        },
      },
    });
  }
  events.push({
    threadId: args.threadId,
    event: { ...base, type: "turn/completed", status: "failed" },
  });
  return events;
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

function parentNoticeTexts(
  harness: TestAppHarness,
  parentThreadId: string,
): string[] {
  const dispatched = listQueuedThreadCommands(
    harness,
    "turn.submit",
    parentThreadId,
  ).flatMap((command) =>
    command.type === "turn.submit"
      ? command.input.flatMap((block) =>
          block.type === "text" ? [block.text] : [],
        )
      : [],
  );
  const queued = listQueuedThreadMessages(harness.db, parentThreadId).flatMap(
    (row) =>
      toThreadQueuedMessage(row).content.flatMap((block) =>
        block.type === "text" ? [block.text] : [],
      ),
  );
  return [...dispatched, ...queued];
}

async function failFirstTurn(
  harness: TestAppHarness,
  scenario: Scenario,
): Promise<void> {
  const response = await postEvents(
    harness,
    scenario.sessionId,
    unauthorizedFailureEvents({
      threadId: scenario.child.id,
      turnId: FIRST_TURN_ID,
    }),
  );
  expect(response.status).toBe(200);
  expect(getThread(harness.db, scenario.child.id)?.status).toBe("error");
  await new Promise((resolve) => setTimeout(resolve, NOTICE_SETTLE_MS));
}

describe("a child whose turn fails with a non-retryable error and is retried by hand", () => {
  it("does not mark an archived in-flight turn failed after its credential is revoked", async () => {
    await withTestHarness(async (harness) => {
      const scenario = seedScenario(harness);
      await new Promise((resolve) => setTimeout(resolve, 10));
      harness.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, scenario.child.id))
        .run();
      await new Promise((resolve) => setTimeout(resolve, 10));

      const response = await postEvents(
        harness,
        scenario.sessionId,
        unauthorizedFailureEvents({
          threadId: scenario.child.id,
          turnId: FIRST_TURN_ID,
        }),
      );
      expect(response.status).toBe(200);
      expect(getThread(harness.db, scenario.child.id)?.status).not.toBe(
        "error",
      );
      await new Promise((resolve) => setTimeout(resolve, NOTICE_SETTLE_MS));
      expect(
        parentNoticeTexts(harness, scenario.parent.id).filter((text) =>
          text.includes("failed."),
        ),
      ).toHaveLength(0);
    });
  }, 20_000);

  it("keeps an archived turn failed and notifies its parent for non-auth failures", async () => {
    await withTestHarness(async (harness) => {
      const scenario = seedScenario(harness);
      harness.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, scenario.child.id))
        .run();
      const response = await postEvents(
        harness,
        scenario.sessionId,
        unauthorizedFailureEvents({
          threadId: scenario.child.id,
          turnId: FIRST_TURN_ID,
          category: "internal",
        }),
      );
      expect(response.status).toBe(200);
      expect(getThread(harness.db, scenario.child.id)?.status).toBe("error");
      await new Promise((resolve) => setTimeout(resolve, NOTICE_SETTLE_MS));
      expect(
        parentNoticeTexts(harness, scenario.parent.id).filter((text) =>
          text.includes("failed."),
        ),
      ).toHaveLength(1);
    });
  }, 20_000);

  it("keeps a non-archived auth failure failed and notifies its parent", async () => {
    await withTestHarness(async (harness) => {
      const scenario = seedScenario(harness);
      const response = await postEvents(
        harness,
        scenario.sessionId,
        unauthorizedFailureEvents({
          threadId: scenario.child.id,
          turnId: FIRST_TURN_ID,
        }),
      );
      expect(response.status).toBe(200);
      expect(getThread(harness.db, scenario.child.id)?.status).toBe("error");
      await new Promise((resolve) => setTimeout(resolve, NOTICE_SETTLE_MS));
      expect(
        parentNoticeTexts(harness, scenario.parent.id).filter((text) =>
          text.includes("failed."),
        ),
      ).toHaveLength(1);
    });
  }, 20_000);

  it("keeps an auth failure failed when the thread was archived before the turn started", async () => {
    await withTestHarness(async (harness) => {
      const scenario = seedScenario(harness);
      harness.db
        .update(threads)
        .set({ archivedAt: Date.now() - 30_000 })
        .where(eq(threads.id, scenario.child.id))
        .run();
      const response = await postEvents(
        harness,
        scenario.sessionId,
        unauthorizedFailureEvents({
          threadId: scenario.child.id,
          turnId: FIRST_TURN_ID,
        }),
      );
      expect(response.status).toBe(200);
      expect(getThread(harness.db, scenario.child.id)?.status).toBe("error");
      await new Promise((resolve) => setTimeout(resolve, NOTICE_SETTLE_MS));
      expect(
        parentNoticeTexts(harness, scenario.parent.id).filter((text) =>
          text.includes("failed."),
        ),
      ).toHaveLength(1);
    });
  }, 20_000);

  it("keeps the archived turn failed when a later non-auth error caused completion", async () => {
    await withTestHarness(async (harness) => {
      const scenario = seedScenario(harness);
      await new Promise((resolve) => setTimeout(resolve, 10));
      harness.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, scenario.child.id))
        .run();
      const archivedAt = getThread(harness.db, scenario.child.id)?.archivedAt;
      if (archivedAt === null || archivedAt === undefined)
        throw new Error("expected archive timestamp");
      seedEvent(harness.deps, {
        threadId: scenario.child.id,
        environmentId: scenario.child.environmentId,
        providerThreadId: PROVIDER_THREAD_ID,
        sequence: 5,
        type: "provider/error",
        scope: turnScope(FIRST_TURN_ID),
        createdAt: archivedAt + 1,
        data: {
          message: "Provider error",
          detail: UNAUTHORIZED_DETAIL,
          errorInfo: {
            category: "unauthorized",
            providerCode: null,
            httpStatusCode: 401,
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: scenario.child.id,
        environmentId: scenario.child.environmentId,
        providerThreadId: PROVIDER_THREAD_ID,
        sequence: 6,
        type: "provider/error",
        scope: turnScope(FIRST_TURN_ID),
        createdAt: archivedAt + 2,
        data: {
          message: "Provider error",
          detail: "Provider failed after retrying the unauthorized request",
          errorInfo: {
            category: "internal",
            providerCode: null,
            httpStatusCode: null,
          },
        },
      });
      const response = await postEvents(harness, scenario.sessionId, [
        {
          threadId: scenario.child.id,
          event: {
            threadId: scenario.child.id,
            providerThreadId: PROVIDER_THREAD_ID,
            scope: turnScope(FIRST_TURN_ID),
            type: "turn/completed",
            status: "failed",
          },
        },
      ]);
      expect(response.status).toBe(200);
      expect(getThread(harness.db, scenario.child.id)?.status).toBe("error");
      await new Promise((resolve) => setTimeout(resolve, NOTICE_SETTLE_MS));
      expect(
        parentNoticeTexts(harness, scenario.parent.id).filter((text) =>
          text.includes("failed."),
        ),
      ).toHaveLength(1);
    });
  }, 20_000);

  it("keeps retryable archived auth failures failed when the turn later fails without another provider error", async () => {
    await withTestHarness(async (harness) => {
      const scenario = seedScenario(harness);
      await new Promise((resolve) => setTimeout(resolve, 10));
      harness.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, scenario.child.id))
        .run();
      const archivedAt = getThread(harness.db, scenario.child.id)?.archivedAt;
      if (archivedAt === null || archivedAt === undefined)
        throw new Error("expected archive timestamp");
      seedEvent(harness.deps, {
        threadId: scenario.child.id,
        environmentId: scenario.child.environmentId,
        providerThreadId: PROVIDER_THREAD_ID,
        sequence: 5,
        type: "provider/error",
        scope: turnScope(FIRST_TURN_ID),
        createdAt: archivedAt + 1,
        data: {
          message: "Provider error",
          detail: UNAUTHORIZED_DETAIL,
          willRetry: true,
          errorInfo: {
            category: "unauthorized",
            providerCode: null,
            httpStatusCode: 401,
          },
        },
      });
      const response = await postEvents(harness, scenario.sessionId, [
        {
          threadId: scenario.child.id,
          event: {
            threadId: scenario.child.id,
            providerThreadId: PROVIDER_THREAD_ID,
            scope: turnScope(FIRST_TURN_ID),
            type: "turn/completed",
            status: "failed",
          },
        },
      ]);
      expect(response.status).toBe(200);
      expect(getThread(harness.db, scenario.child.id)?.status).toBe("error");
      await new Promise((resolve) => setTimeout(resolve, NOTICE_SETTLE_MS));
      expect(
        parentNoticeTexts(harness, scenario.parent.id).filter((text) =>
          text.includes("failed."),
        ),
      ).toHaveLength(1);
    });
  }, 20_000);

  it("tells the parent about the first failure once and about the final failure once", async () => {
    await withTestHarness(async (harness) => {
      const scenario = seedScenario(harness);

      await failFirstTurn(harness, scenario);
      const afterFirstFailure = parentNoticeTexts(harness, scenario.parent.id);
      expect(afterFirstFailure).toHaveLength(1);
      expect(afterFirstFailure[0]).toContain("failed.");

      const child = getThread(harness.db, scenario.child.id);
      if (child === null) throw new Error("expected the child thread");
      const retry = await retryFailedTurn(harness.deps, {
        thread: child,
        request: {
          turnRequestId: null,
          sendAt: null,
          reason: "Retried by hand",
        },
      });
      expect(retry).toMatchObject({ delivery: "sent", attempt: 2 });
      seedTurnStarted(harness.deps, {
        environmentId: child.environmentId,
        providerThreadId: PROVIDER_THREAD_ID,
        threadId: scenario.child.id,
        turnId: RETRY_TURN_ID,
      });

      const response = await postEvents(
        harness,
        scenario.sessionId,
        unauthorizedFailureEvents({
          threadId: scenario.child.id,
          turnId: RETRY_TURN_ID,
        }),
      );
      expect(response.status).toBe(200);
      expect(getThread(harness.db, scenario.child.id)?.status).toBe("error");
      await new Promise((resolve) => setTimeout(resolve, NOTICE_SETTLE_MS));

      const afterFinalFailure = parentNoticeTexts(harness, scenario.parent.id);
      expect(afterFinalFailure).toHaveLength(2);
      expect(
        afterFinalFailure.filter((text) => text.includes("failed.")),
      ).toHaveLength(2);
    });
  }, 20_000);

  it("hands plugins the provider's error text on thread.failed", async () => {
    await withTestHarness(async (harness) => {
      const scenario = seedScenario(harness);
      const pluginDirectory = await mkdtemp(
        join(tmpdir(), "bb-thread-failed-error-text-"),
      );
      const globals = globalThis as Record<string, unknown>;
      const errors: Array<string | null> = [];
      globals.__threadFailedErrors = errors;
      try {
        const pluginRoot = join(pluginDirectory, "observer");
        await mkdir(pluginRoot, { recursive: true });
        await writeFile(
          join(pluginRoot, "package.json"),
          JSON.stringify({
            name: "bb-plugin-thread-failed-observer",
            version: "0.1.0",
            bb: {
              name: "Thread failed observer",
              description: "Records the error text of failed threads.",
              branding: { icon: "Zap" },
              server: "./server.ts",
            },
          }),
        );
        await writeFile(
          join(pluginRoot, "server.ts"),
          `export default function plugin(bb: any) {
            bb.events.on("thread.failed", (event: any) => {
              (globalThis as any).__threadFailedErrors.push(event.error);
            });
          }`,
        );
        const entry = await harness.pluginService.installPath(pluginRoot);
        expect(entry.status).toBe("running");

        const response = await postEvents(
          harness,
          scenario.sessionId,
          unauthorizedFailureEvents({
            threadId: scenario.child.id,
            turnId: FIRST_TURN_ID,
          }),
        );
        expect(response.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 500));

        expect(errors).toEqual([UNAUTHORIZED_DETAIL]);
      } finally {
        delete globals.__threadFailedErrors;
        await rm(pluginDirectory, { recursive: true, force: true });
      }
    });
  }, 20_000);

  it("reports no error text for a failure whose own turn recorded none", async () => {
    await withTestHarness(async (harness) => {
      const scenario = seedScenario(harness);
      const environmentId = scenario.child.environmentId;
      const providerError = (args: {
        sequence: number;
        turnId: string;
        willRetry?: boolean;
      }) =>
        seedEvent(harness.deps, {
          environmentId,
          providerThreadId: PROVIDER_THREAD_ID,
          sequence: args.sequence,
          threadId: scenario.child.id,
          type: "provider/error",
          scope: turnScope(args.turnId),
          data: {
            providerThreadId: PROVIDER_THREAD_ID,
            message: "Provider error",
            detail: UNAUTHORIZED_DETAIL,
            ...(args.willRetry ? { willRetry: true } : {}),
          },
        });

      providerError({ sequence: 5, turnId: FIRST_TURN_ID, willRetry: true });
      expect(
        getLastThreadErrorMessage(harness.db, scenario.child.id),
      ).toBeNull();

      providerError({ sequence: 6, turnId: FIRST_TURN_ID });
      expect(getLastThreadErrorMessage(harness.db, scenario.child.id)).toBe(
        UNAUTHORIZED_DETAIL,
      );

      seedEvent(harness.deps, {
        environmentId,
        providerThreadId: PROVIDER_THREAD_ID,
        sequence: 7,
        threadId: scenario.child.id,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 2 }),
          source: "tell",
          initiator: "system",
          senderThreadId: null,
          input: [{ type: "text", text: "Do the thing" }],
          target: { kind: "new-turn" },
          request: { method: "turn/start", params: {} },
          execution: {
            model: "claude-sonnet-5-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
        },
      });
      expect(
        getLastThreadErrorMessage(harness.db, scenario.child.id),
      ).toBeNull();
    });
  });
});
