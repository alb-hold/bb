import { sendMessageResponseSchema } from "@bb/server-contract";
import {
  clientTurnRequestIdSchema,
  turnScope,
  type ClientTurnRequestId,
  type ThreadEvent,
} from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { requestThreadStopForCurrentState } from "../../src/services/threads/thread-lifecycle.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const PROVIDER_THREAD_ID = "provider-retry-of";
const TURN_ID = "turn-retry-of";
const MESSAGE_TEXT = "send me once";

async function postDaemonEvents(
  harness: TestAppHarness,
  args: {
    hostId: string;
    sessionId: string;
    events: readonly ThreadEvent[];
  },
): Promise<void> {
  const response = await harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness, { hostId: args.hostId }),
    body: JSON.stringify({
      sessionId: args.sessionId,
      eventGroups: groupHostDaemonEvents(
        args.events.map((event) => ({ threadId: event.threadId, event })),
      ),
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function sendMessage(
  harness: TestAppHarness,
  threadId: string,
  retryOfClientRequestId?: ClientTurnRequestId,
  text: string = MESSAGE_TEXT,
) {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/send`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "auto",
        input: [{ type: "text", text }],
        model: "gpt-5",
        permissionMode: "full",
        reasoningLevel: "medium",
        serviceTier: "default",
        ...(retryOfClientRequestId === undefined
          ? {}
          : { retryOfClientRequestId }),
      }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return sendMessageResponseSchema.parse(await response.json());
}

async function echoOriginal(
  harness: TestAppHarness,
  original: Awaited<ReturnType<typeof interruptedRequest>>,
): Promise<void> {
  await postDaemonEvents(harness, {
    hostId: original.hostId,
    sessionId: original.sessionId,
    events: [
      {
        type: "item/completed",
        threadId: original.threadId,
        providerThreadId: PROVIDER_THREAD_ID,
        scope: turnScope(TURN_ID),
        item: {
          type: "userMessage",
          id: "echo-item",
          content: [{ type: "text", text: MESSAGE_TEXT }],
          clientRequestId: original.clientRequestId,
        },
      },
    ],
  });
}

function queuedRows(
  harness: TestAppHarness,
  threadId: string,
): {
  content: string;
  resendOf: string | null;
  state: string;
  claimToken: string | null;
}[] {
  return harness.db.$client
    .prepare(
      "select content, resend_of_client_request_id as resendOf, state, claim_token as claimToken from queued_thread_messages where thread_id = ? order by created_at, id",
    )
    .all(threadId) as {
    content: string;
    resendOf: string | null;
    state: string;
    claimToken: string | null;
  }[];
}

function countSubmissions(harness: TestAppHarness, threadId: string): number {
  const row = harness.db.$client
    .prepare(
      "select count(*) as n from events where thread_id = ? and type = 'client/turn/requested' and json_extract(data, '$.input[0].text') = ?",
    )
    .get(threadId, MESSAGE_TEXT) as { n: number };
  return row.n;
}

async function interruptedRequest(
  harness: TestAppHarness,
  slug: string,
): Promise<{
  clientRequestId: ClientTurnRequestId;
  hostId: string;
  sessionId: string;
  threadId: string;
}> {
  const { host, session } = seedHostSession(harness.deps, {
    id: `host-retry-of-${slug}`,
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/retry-of-${slug}`,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/retry-of-${slug}`,
    status: "ready",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: PROVIDER_THREAD_ID,
    threadId: thread.id,
  });
  await sendMessage(harness, thread.id);
  const requested = harness.db.$client
    .prepare(
      "select json_extract(data, '$.requestId') as id from events where thread_id = ? and type = 'client/turn/requested' and json_extract(data, '$.input[0].text') = ?",
    )
    .all(thread.id, MESSAGE_TEXT) as { id: string | null }[];
  expect(requested).toHaveLength(1);
  const clientRequestId = clientTurnRequestIdSchema.parse(requested[0]?.id);
  const base = {
    threadId: thread.id,
    providerThreadId: PROVIDER_THREAD_ID,
    scope: turnScope(TURN_ID),
  };
  await postDaemonEvents(harness, {
    hostId: host.id,
    sessionId: session.id,
    events: [{ ...base, type: "turn/started" }],
  });
  requestThreadStopForCurrentState(harness.deps, thread);
  await postDaemonEvents(harness, {
    hostId: host.id,
    sessionId: session.id,
    events: [{ ...base, type: "turn/completed", status: "interrupted" }],
  });
  return {
    clientRequestId,
    hostId: host.id,
    sessionId: session.id,
    threadId: thread.id,
  };
}

describe("a re-send that names the request it retries", () => {
  it("is dropped when the original request's echo arrived after the turn closed", async () => {
    await withTestHarness(async (harness) => {
      const original = await interruptedRequest(harness, "delivered");
      await postDaemonEvents(harness, {
        hostId: original.hostId,
        sessionId: original.sessionId,
        events: [
          {
            type: "item/completed",
            threadId: original.threadId,
            providerThreadId: PROVIDER_THREAD_ID,
            scope: turnScope(TURN_ID),
            item: {
              type: "userMessage",
              id: "echo-item",
              content: [{ type: "text", text: MESSAGE_TEXT }],
              clientRequestId: original.clientRequestId,
            },
          },
        ],
      });

      const retry = await sendMessage(
        harness,
        original.threadId,
        original.clientRequestId,
      );

      expect(retry).toEqual({ ok: true, delivery: "alreadyDelivered" });
      expect(countSubmissions(harness, original.threadId)).toBe(1);
      const queued = harness.db.$client
        .prepare(
          "select count(*) as n from queued_thread_messages where thread_id = ?",
        )
        .get(original.threadId) as { n: number };
      expect(queued.n).toBe(0);
    });
  });

  it("is dispatched when the original request never got an echo", async () => {
    await withTestHarness(async (harness) => {
      const original = await interruptedRequest(harness, "undelivered");

      const retry = await sendMessage(
        harness,
        original.threadId,
        original.clientRequestId,
      );

      expect(retry.delivery).toBe("queued");
      expect(countSubmissions(harness, original.threadId)).toBe(1);
    });
  });

  it("is dispatched when the original request was accepted but never echoed", async () => {
    await withTestHarness(async (harness) => {
      const original = await interruptedRequest(harness, "accepted-no-echo");
      await postDaemonEvents(harness, {
        hostId: original.hostId,
        sessionId: original.sessionId,
        events: [
          {
            type: "turn/input/accepted",
            threadId: original.threadId,
            providerThreadId: PROVIDER_THREAD_ID,
            scope: turnScope(TURN_ID),
            clientRequestId: original.clientRequestId,
          },
        ],
      });

      const retry = await sendMessage(
        harness,
        original.threadId,
        original.clientRequestId,
      );

      expect(retry.delivery).not.toBe("alreadyDelivered");
      expect(retry.delivery).toBe("queued");
    });
  });

  it("stays queued when the original never got an echo and the queue is drained", async () => {
    await withTestHarness(async (harness) => {
      const original = await interruptedRequest(harness, "queued-undelivered");
      const retry = await sendMessage(
        harness,
        original.threadId,
        original.clientRequestId,
      );
      if (retry.delivery !== "queued") {
        throw new Error(`expected the retry to queue, got ${retry.delivery}`);
      }

      const drained = await harness.app.request(
        `/api/v1/threads/${original.threadId}/queued-messages/${retry.queuedMessage.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "auto" }),
        },
      );
      expect(drained.status, await drained.clone().text()).toBe(200);
      const remaining = harness.db.$client
        .prepare(
          "select resend_of_client_request_id as resendOf from queued_thread_messages where thread_id = ?",
        )
        .all(original.threadId) as { resendOf: string | null }[];
      expect(remaining).toEqual([{ resendOf: original.clientRequestId }]);
    });
  });

  it("is dropped from the queue when the original echo lands before the retry dispatches", async () => {
    await withTestHarness(async (harness) => {
      const original = await interruptedRequest(harness, "queued");
      const retry = await sendMessage(
        harness,
        original.threadId,
        original.clientRequestId,
      );
      if (retry.delivery !== "queued") {
        throw new Error(`expected the retry to queue, got ${retry.delivery}`);
      }
      await postDaemonEvents(harness, {
        hostId: original.hostId,
        sessionId: original.sessionId,
        events: [
          {
            type: "item/completed",
            threadId: original.threadId,
            providerThreadId: PROVIDER_THREAD_ID,
            scope: turnScope(TURN_ID),
            item: {
              type: "userMessage",
              id: "echo-item",
              content: [{ type: "text", text: MESSAGE_TEXT }],
              clientRequestId: original.clientRequestId,
            },
          },
        ],
      });

      const drained = await harness.app.request(
        `/api/v1/threads/${original.threadId}/queued-messages/${retry.queuedMessage.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "auto" }),
        },
      );
      expect(drained.status, await drained.clone().text()).toBe(200);

      const remaining = harness.db.$client
        .prepare(
          "select count(*) as n from queued_thread_messages where thread_id = ?",
        )
        .get(original.threadId) as { n: number };
      expect(remaining.n).toBe(0);
      expect(countSubmissions(harness, original.threadId)).toBe(1);
    });
  });

  it("removes only the echoed retry and keeps a distinct follow-up claimed with it, unclaimed and intact", async () => {
    await withTestHarness(async (harness) => {
      const original = await interruptedRequest(harness, "mixed");
      const retry = await sendMessage(
        harness,
        original.threadId,
        original.clientRequestId,
      );
      if (retry.delivery !== "queued") {
        throw new Error(`expected the retry to queue, got ${retry.delivery}`);
      }
      const followUp = await sendMessage(
        harness,
        original.threadId,
        undefined,
        "a distinct follow-up",
      );
      if (followUp.delivery !== "queued") {
        throw new Error(
          `expected the follow-up to queue, got ${followUp.delivery}`,
        );
      }
      harness.db.$client
        .prepare(
          "update queued_thread_messages set group_with_next = 1 where id = ?",
        )
        .run(retry.queuedMessage.id);
      const followUpState = queuedRows(harness, original.threadId)[1]?.state;
      await echoOriginal(harness, original);

      const drained = await harness.app.request(
        `/api/v1/threads/${original.threadId}/queued-messages/${retry.queuedMessage.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "auto" }),
        },
      );
      expect(drained.status, await drained.clone().text()).toBe(200);

      expect(countSubmissions(harness, original.threadId)).toBe(1);
      const rows = queuedRows(harness, original.threadId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.content).toContain("a distinct follow-up");
      expect(rows[0]?.resendOf).toBeNull();
      expect(rows[0]?.claimToken).toBeNull();
      expect(rows[0]?.state).toBe(followUpState);
    });
  });

  it("keeps a queued retry whose payload differs from the echoed original instead of dropping it", async () => {
    await withTestHarness(async (harness) => {
      const original = await interruptedRequest(harness, "changed-queued");
      const retry = await sendMessage(
        harness,
        original.threadId,
        original.clientRequestId,
        "the merged and edited text",
      );
      if (retry.delivery !== "queued") {
        throw new Error(`expected the retry to queue, got ${retry.delivery}`);
      }
      await echoOriginal(harness, original);

      const drained = await harness.app.request(
        `/api/v1/threads/${original.threadId}/queued-messages/${retry.queuedMessage.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "auto" }),
        },
      );
      expect(drained.status, await drained.clone().text()).toBe(200);
      const rows = queuedRows(harness, original.threadId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.content).toContain("the merged and edited text");
    });
  });

  it("queues a send normally, without the retry id, when it names a delivered request but the payload differs", async () => {
    await withTestHarness(async (harness) => {
      const original = await interruptedRequest(harness, "changed-direct");
      await echoOriginal(harness, original);
      const response = await sendMessage(
        harness,
        original.threadId,
        original.clientRequestId,
        "the merged and edited text",
      );
      expect(response.delivery).not.toBe("alreadyDelivered");
      const rows = queuedRows(harness, original.threadId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.content).toContain("the merged and edited text");
      expect(rows[0]?.resendOf).toBeNull();
    });
  });
});
