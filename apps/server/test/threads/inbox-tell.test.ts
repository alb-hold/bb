import {
  archiveThread,
  getThread,
  listEvents,
  listQueuedThreadMessages,
} from "@bb/db";
import {
  isInboxQueuedMessageWait,
  QUEUED_MESSAGE_INBOX_HOLD_LIMIT_MS,
  turnRequestEventDataSchema,
  turnScope,
  type TurnRequestEventData,
} from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import {
  parseStockStoredWaitingOn,
  stockQueuedMessageWaitingOnSchema,
  stockThreadParentNotificationsSchema,
  stockTimeWaitIsDue,
} from "../helpers/stock-queued-message-wait.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { queueParentSystemMessage } from "../../src/services/threads/parent-system-messages.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import {
  internalAuthHeaders,
  listQueuedThreadCommands,
} from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  withTestHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

const WORKSPACE_PATH = "/tmp/inbox-tell-project";
const CLOCK_SLACK_MS = 10_000;

function seedReceiver(
  harness: TestAppHarness,
  args: { hostId: string; status: "idle" | "active" },
) {
  const { host, session } = seedHostSession(harness.deps, { id: args.hostId });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: WORKSPACE_PATH,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: WORKSPACE_PATH,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: args.status,
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-${args.hostId}`,
    threadId: thread.id,
  });
  if (args.status === "active") {
    seedTurnStarted(harness.deps, {
      environmentId: environment.id,
      threadId: thread.id,
      turnId: `turn-${args.hostId}`,
      providerThreadId: `provider-${args.hostId}`,
    });
  }
  const sender = seedThread(harness.deps, {
    projectId: project.id,
    title: "Sender",
  });
  return { environment, project, sender, sessionId: session.id, thread };
}

function turnRequests(
  harness: TestAppHarness,
  threadId: string,
): TurnRequestEventData[] {
  return listEvents(harness.db, { threadId })
    .filter((event) => event.type === "client/turn/requested")
    .map((event) => turnRequestEventDataSchema.parse(JSON.parse(event.data)));
}

function queuedRows(harness: TestAppHarness, threadId: string) {
  return listQueuedThreadMessages(harness.db, threadId).map(
    toThreadQueuedMessage,
  );
}

async function postTurnStarted(
  harness: TestAppHarness,
  args: {
    providerThreadId: string;
    sessionId: string;
    threadId: string;
    turnId: string;
  },
) {
  const response = await harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness),
    body: JSON.stringify({
      sessionId: args.sessionId,
      eventGroups: groupHostDaemonEvents([
        {
          threadId: args.threadId,
          event: {
            type: "turn/started",
            threadId: args.threadId,
            providerThreadId: args.providerThreadId,
            scope: turnScope(args.turnId),
          },
        },
      ]),
    }),
  });
  expect(response.status).toBe(200);
}

function storedWaitingOn(harness: TestAppHarness, threadId: string): string[] {
  return listQueuedThreadMessages(harness.db, threadId).flatMap((row) =>
    row.waitingOn === null ? [] : [row.waitingOn],
  );
}

function tell(
  harness: TestAppHarness,
  args: {
    thread: Parameters<typeof acceptThreadSendRequest>[1]["thread"];
    senderThreadId: string;
    text: string;
    mode?: "inbox" | "queue-if-active";
    deliverBy?: number;
  },
) {
  return acceptThreadSendRequest(harness.deps, {
    payload: {
      input: textInput(args.text),
      mode: args.mode ?? "inbox",
      senderThreadId: args.senderThreadId,
      ...(args.deliverBy === undefined ? {} : { deliverBy: args.deliverBy }),
    },
    thread: args.thread,
  });
}

describe("inbox tell to an idle thread", () => {
  it("is held for the next turn, starts no turn, and stays held at every earlier wake", async () => {
    await withTestHarness(async (harness) => {
      const { sender, thread } = seedReceiver(harness, {
        hostId: "host-inbox-idle",
        status: "idle",
      });
      const before = Date.now();

      const response = await tell(harness, {
        thread,
        senderThreadId: sender.id,
        text: "status ping",
      });

      expect(response).toMatchObject({
        delivery: "queued",
        queuedMessage: { waitingOn: { kind: "time", inbox: true } },
      });
      const [row] = queuedRows(harness, thread.id);
      expect(row?.sendAt).toBeGreaterThanOrEqual(
        before + QUEUED_MESSAGE_INBOX_HOLD_LIMIT_MS,
      );
      expect(row?.sendAt).toBeLessThanOrEqual(
        Date.now() + QUEUED_MESSAGE_INBOX_HOLD_LIMIT_MS,
      );
      expect(turnRequests(harness, thread.id)).toHaveLength(0);
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");

      await runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: Date.now() + 60 * 60 * 1000,
      });
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      await runQueuedMessageDispatch(harness.deps, {
        kind: "plugin-recheck",
      });

      expect(turnRequests(harness, thread.id)).toHaveLength(0);
      expect(queuedRows(harness, thread.id)).toHaveLength(1);
      expect(queuedRows(harness, thread.id)[0]?.waitingOn).toEqual({
        kind: "time",
        inbox: true,
      });
    });
  });

  it("is delivered in send order with the sender envelope when the next turn starts", async () => {
    await withTestHarness(async (harness) => {
      const { sender, sessionId, thread } = seedReceiver(harness, {
        hostId: "host-inbox-release",
        status: "idle",
      });
      await tell(harness, {
        thread,
        senderThreadId: sender.id,
        text: "first held note",
      });
      await tell(harness, {
        thread,
        senderThreadId: sender.id,
        text: "second held note",
      });
      expect(queuedRows(harness, thread.id)).toHaveLength(2);

      await postTurnStarted(harness, {
        providerThreadId: "provider-host-inbox-release",
        sessionId,
        threadId: thread.id,
        turnId: "turn-real",
      });
      await vi.waitFor(() => {
        expect(
          listQueuedThreadCommands(harness, "turn.submit", thread.id).length,
        ).toBeGreaterThan(0);
      });

      const commands = JSON.stringify(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      );
      const first = commands.indexOf("first held note");
      const second = commands.indexOf("second held note");
      expect(first).toBeGreaterThan(-1);
      expect(second).toBeGreaterThan(first);
      expect(commands).toContain(`bb message from thread:${sender.id}`);
      expect(commands).toContain("turn-real");
      expect(queuedRows(harness, thread.id)).toHaveLength(0);
    });
  });

  it("starts a normal turn when the hold limit passes", async () => {
    await withTestHarness(async (harness) => {
      const { sender, thread } = seedReceiver(harness, {
        hostId: "host-inbox-limit",
        status: "idle",
      });
      await tell(harness, {
        thread,
        senderThreadId: sender.id,
        text: "overdue note",
      });
      const [row] = queuedRows(harness, thread.id);
      expect(turnRequests(harness, thread.id)).toHaveLength(0);

      await runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: (row?.sendAt ?? 0) + 1,
      });

      const requests = turnRequests(harness, thread.id);
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0]?.input)).toContain("overdue note");
      expect(queuedRows(harness, thread.id)).toHaveLength(0);
    });
  });

  it("clamps the hold to deliverBy and never beyond the limit", async () => {
    await withTestHarness(async (harness) => {
      const { sender, thread } = seedReceiver(harness, {
        hostId: "host-inbox-clamp",
        status: "idle",
      });
      const soon = Date.now() + 60_000;
      await tell(harness, {
        thread,
        senderThreadId: sender.id,
        text: "soon",
        deliverBy: soon,
      });
      await tell(harness, {
        thread,
        senderThreadId: sender.id,
        text: "far",
        deliverBy: Date.now() + 10 * QUEUED_MESSAGE_INBOX_HOLD_LIMIT_MS,
      });

      const [soonRow, farRow] = queuedRows(harness, thread.id);
      expect(soonRow?.sendAt).toBe(soon);
      expect(farRow?.sendAt).toBeLessThanOrEqual(
        Date.now() + QUEUED_MESSAGE_INBOX_HOLD_LIMIT_MS,
      );
      expect(farRow?.sendAt).toBeGreaterThan(
        Date.now() + QUEUED_MESSAGE_INBOX_HOLD_LIMIT_MS - CLOCK_SLACK_MS,
      );
    });
  });

  it("is not held when deliverBy has already passed", async () => {
    await withTestHarness(async (harness) => {
      const { sender, thread } = seedReceiver(harness, {
        hostId: "host-inbox-past",
        status: "idle",
      });

      await tell(harness, {
        thread,
        senderThreadId: sender.id,
        text: "too late to hold",
        deliverBy: Date.now() - 1_000,
      });

      expect(turnRequests(harness, thread.id)).toHaveLength(1);
      expect(queuedRows(harness, thread.id)).toHaveLength(0);
    });
  });

  it("is refused for an archived receiver", async () => {
    await withTestHarness(async (harness) => {
      const { sender, thread } = seedReceiver(harness, {
        hostId: "host-inbox-archived",
        status: "idle",
      });
      archiveThread(harness.db, harness.hub, thread.id);
      const archived = getThread(harness.db, thread.id)!;

      await expect(
        tell(harness, {
          thread: archived,
          senderThreadId: sender.id,
          text: "to an archived thread",
        }),
      ).rejects.toThrow(/archived/i);
      expect(queuedRows(harness, thread.id)).toHaveLength(0);
    });
  });
});

describe("inbox tell to a live turn", () => {
  it("waits exactly like a queue tell", async () => {
    await withTestHarness(async (harness) => {
      const { sender, thread } = seedReceiver(harness, {
        hostId: "host-inbox-live",
        status: "active",
      });

      await tell(harness, {
        thread,
        senderThreadId: sender.id,
        text: "via queue",
        mode: "queue-if-active",
      });
      await tell(harness, {
        thread,
        senderThreadId: sender.id,
        text: "via inbox",
      });

      const [viaQueue, viaInbox] = queuedRows(harness, thread.id);
      expect(viaInbox?.waitingOn).toEqual(viaQueue?.waitingOn);
      expect(isInboxQueuedMessageWait(viaInbox?.waitingOn ?? null)).toBe(false);
      expect(viaInbox?.sendAt).toBeNull();
    });
  });
});

describe("parent notice under parentNotifications inbox", () => {
  it("stores the inbox choice where a stock parse of parent_notifications still succeeds", async () => {
    await withTestHarness(async (harness) => {
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: seedHostSession(harness.deps, { id: "host-inbox-stock-column" })
          .host.id,
        path: WORKSPACE_PATH,
      });
      const child = seedThread(harness.deps, {
        projectId: project.id,
        parentNotifications: "inbox",
      });

      const row = harness.db.$client
        .prepare<
          [string],
          { stored: string; hold: number | null }
        >("SELECT parent_notifications AS stored, parent_notifications_hold_while_idle AS hold FROM threads WHERE id = ?")
        .get(child.id);
      expect(stockThreadParentNotificationsSchema.parse(row?.stored)).toBe(
        "auto",
      );
      expect(row?.hold).toBe(1);
      expect(stockThreadParentNotificationsSchema.safeParse("inbox").success).toBe(
        false,
      );
    });
  });

  const subject = {
    kind: "thread",
    threadId: "child-held",
    threadName: "Child",
  } as const;

  it("holds a completed-turn notice while the parent is idle", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedReceiver(harness, {
        hostId: "host-inbox-notice-held",
        status: "idle",
      });

      await expect(
        queueParentSystemMessage(harness.deps, {
          holdWhileIdle: true,
          input: textInput("A child finished its work."),
          parentThreadId: thread.id,
          systemMessageKind: "child-completed",
          systemMessageSubject: subject,
        }),
      ).resolves.toBe(true);

      expect(turnRequests(harness, thread.id)).toHaveLength(0);
      expect(queuedRows(harness, thread.id)).toHaveLength(1);
      expect(queuedRows(harness, thread.id)[0]?.waitingOn).toEqual({
        kind: "time",
        inbox: true,
      });
    });
  });

  it("delivers the same notice at once when it is not held", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedReceiver(harness, {
        hostId: "host-inbox-notice-live",
        status: "idle",
      });

      await queueParentSystemMessage(harness.deps, {
        input: textInput("A child finished its work."),
        parentThreadId: thread.id,
        systemMessageKind: "child-completed",
        systemMessageSubject: subject,
      });

      expect(turnRequests(harness, thread.id)).toHaveLength(1);
      expect(queuedRows(harness, thread.id)).toHaveLength(0);
    });
  });
});

describe("inbox tell stored shape and restart", () => {
  it("stores a held row that a stock build parses as a plain time wait and releases at its column time", async () => {
    await withTestHarness(async (harness) => {
      const { sender, thread } = seedReceiver(harness, {
        hostId: "host-inbox-stock",
        status: "idle",
      });
      await tell(harness, {
        thread,
        senderThreadId: sender.id,
        text: "held for stock",
      });

      const [stored] = listQueuedThreadMessages(harness.db, thread.id);
      expect(stored?.waitingOn).not.toBeNull();
      expect(JSON.parse(stored?.waitingOn ?? "null")).toEqual({
        kind: "time",
        inbox: true,
      });
      const stockParsed = parseStockStoredWaitingOn(stored?.waitingOn ?? "");
      expect(stockParsed).toEqual({ kind: "time" });
      expect(stored?.sendAt).not.toBeNull();
      const sendAt = stored?.sendAt ?? 0;
      expect(
        stockTimeWaitIsDue({
          waitingOn: stockParsed,
          sendAt: stored?.sendAt ?? null,
          now: sendAt - 1,
        }),
      ).toBe(false);
      expect(
        stockTimeWaitIsDue({
          waitingOn: stockParsed,
          sendAt: stored?.sendAt ?? null,
          now: sendAt,
        }),
      ).toBe(true);

      await runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: sendAt,
      });
      expect(turnRequests(harness, thread.id)).toHaveLength(1);
      expect(queuedRows(harness, thread.id)).toHaveLength(0);
    });
  });

  it("is refused by a stock parse when a wait is stored with the retired inbox kind", () => {
    expect(
      stockQueuedMessageWaitingOnSchema.safeParse({ kind: "inbox" }).success,
    ).toBe(false);
    expect(() =>
      parseStockStoredWaitingOn(JSON.stringify({ kind: "inbox" })),
    ).toThrow();
  });

  it("leaves a plain scheduled message alone when the next turn starts", async () => {
    await withTestHarness(async (harness) => {
      const { sender, sessionId, thread } = seedReceiver(harness, {
        hostId: "host-inbox-scheduled",
        status: "idle",
      });
      await acceptThreadSendRequest(harness.deps, {
        payload: {
          input: textInput("scheduled note"),
          mode: "queue-if-active",
          senderThreadId: sender.id,
          sendAt: Date.now() + 60 * 60 * 1000,
        },
        thread,
      });
      expect(storedWaitingOn(harness, thread.id)).toEqual([
        JSON.stringify({ kind: "time" }),
      ]);

      await postTurnStarted(harness, {
        providerThreadId: "provider-host-inbox-scheduled",
        sessionId,
        threadId: thread.id,
        turnId: "turn-scheduled",
      });
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });

      expect(queuedRows(harness, thread.id)).toHaveLength(1);
      expect(
        JSON.stringify(
          listQueuedThreadCommands(harness, "turn.submit", thread.id),
        ),
      ).not.toContain("scheduled note");
    });
  });

  it("keeps a held message across a server restart and releases it at the next turn start", async () => {
    await withTestHarness(async (first) => {
      const { sender, sessionId, thread } = seedReceiver(first, {
        hostId: "host-inbox-restart",
        status: "idle",
      });
      await tell(first, {
        thread,
        senderThreadId: sender.id,
        text: "survives restart",
      });
      const heldBefore = storedWaitingOn(first, thread.id);
      expect(heldBefore).toHaveLength(1);

      const restarted = await createTestAppHarness({ db: first.db });
      try {
        expect(storedWaitingOn(restarted, thread.id)).toEqual(heldBefore);
        expect(queuedRows(restarted, thread.id)).toHaveLength(1);

        await runQueuedMessageDispatch(restarted.deps, {
          kind: "thread-ready",
          threadId: thread.id,
        });
        await runQueuedMessageDispatch(restarted.deps, {
          kind: "plugin-recheck",
        });
        expect(turnRequests(restarted, thread.id)).toHaveLength(0);
        expect(queuedRows(restarted, thread.id)).toHaveLength(1);

        await postTurnStarted(restarted, {
          providerThreadId: "provider-host-inbox-restart",
          sessionId,
          threadId: thread.id,
          turnId: "turn-after-restart",
        });
        await vi.waitFor(() => {
          expect(
            JSON.stringify(
              listQueuedThreadCommands(restarted, "turn.submit", thread.id),
            ),
          ).toContain("survives restart");
        });
        expect(queuedRows(restarted, thread.id)).toHaveLength(0);
      } finally {
        await restarted.cleanup();
      }
    });
  });
});
