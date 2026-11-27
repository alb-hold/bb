import { threadTimelineResponseSchema } from "@bb/server-contract";
import { turnScope } from "@bb/domain";
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

const PROVIDER_THREAD_ID = "provider-late-echo";
const TURN_ID = "turn-late-echo";
const MESSAGE_TEXT = "look at this screenshot";
const IMAGE_PATH = "/tmp/late-echo/shot.png";

type EchoTiming = "before the turn ended" | "after the turn ended";

async function postDaemonEvents(
  harness: TestAppHarness,
  args: { hostId: string; sessionId: string; events: readonly object[] },
): Promise<void> {
  const response = await harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness, { hostId: args.hostId }),
    body: JSON.stringify({
      sessionId: args.sessionId,
      eventGroups: groupHostDaemonEvents(
        args.events.map((event) => ({
          threadId: (event as { threadId: string }).threadId,
          event: event as never,
        })),
      ),
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function readUserRequestStatuses(
  harness: TestAppHarness,
  threadId: string,
): Promise<string[]> {
  const timeline = threadTimelineResponseSchema.parse(
    await (
      await harness.app.request(`/api/v1/threads/${threadId}/timeline`)
    ).json(),
  );
  return timeline.rows
    .flatMap((row) =>
      row.kind === "conversation" &&
      row.role === "user" &&
      row.text.includes(MESSAGE_TEXT) &&
      row.turnRequest
        ? [row.turnRequest.status]
        : [],
    );
}

describe("a CLI echo that arrives after the interrupt", () => {
  it.each(["before the turn ended", "after the turn ended"] as const)(
    "takes a text and image message back from undelivered when the echo lands %s",
    async (timing: EchoTiming) => {
      await withTestHarness(async (harness) => {
        const slug = timing.replaceAll(" ", "-");
        const { host, session } = seedHostSession(harness.deps, {
          id: `host-late-echo-${slug}`,
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: `/tmp/late-echo-${slug}`,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: `/tmp/late-echo-${slug}`,
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
        const send = await harness.app.request(
          `/api/v1/threads/${thread.id}/send`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              mode: "auto",
              input: [
                { type: "text", text: MESSAGE_TEXT },
                { type: "localImage", path: IMAGE_PATH },
              ],
              model: "gpt-5",
              permissionMode: "full",
              reasoningLevel: "medium",
              serviceTier: "default",
            }),
          },
        );
        expect(send.status, await send.clone().text()).toBe(200);

        const requested = harness.db.$client
          .prepare(
            "select json_extract(data, '$.requestId') as id from events where thread_id = ? and type = 'client/turn/requested' and json_extract(data, '$.input[0].text') = 'look at this screenshot'",
          )
          .all(thread.id) as { id: string | null }[];
        expect(requested).toHaveLength(1);
        const clientRequestId = requested[0]?.id;
        expect(clientRequestId).toBeTruthy();

        await postDaemonEvents(harness, {
          hostId: host.id,
          sessionId: session.id,
          events: [
            {
              type: "turn/started",
              threadId: thread.id,
              providerThreadId: PROVIDER_THREAD_ID,
              scope: turnScope(TURN_ID),
            },
          ],
        });
        const base = {
          threadId: thread.id,
          providerThreadId: PROVIDER_THREAD_ID,
          scope: turnScope(TURN_ID),
        };
        const echo = {
          ...base,
          type: "item/completed",
          item: {
            type: "userMessage",
            id: "echo-item",
            content: [{ type: "text", text: MESSAGE_TEXT }],
            clientRequestId,
          },
        };
        const accepted = {
          ...base,
          type: "turn/input/accepted",
          clientRequestId,
        };
        const interrupted = {
          ...base,
          type: "turn/completed",
          status: "interrupted",
        };

        requestThreadStopForCurrentState(harness.deps, thread);
        await postDaemonEvents(harness, {
          hostId: host.id,
          sessionId: session.id,
          events: [accepted],
        });
        if (timing === "before the turn ended") {
          await postDaemonEvents(harness, {
            hostId: host.id,
            sessionId: session.id,
            events: [echo, interrupted],
          });
        } else {
          await postDaemonEvents(harness, {
            hostId: host.id,
            sessionId: session.id,
            events: [interrupted],
          });
          expect(await readUserRequestStatuses(harness, thread.id)).toEqual([
            "undelivered",
          ]);
          await postDaemonEvents(harness, {
            hostId: host.id,
            sessionId: session.id,
            events: [echo],
          });
        }

        expect(await readUserRequestStatuses(harness, thread.id)).toEqual([
          "accepted",
        ]);
        const submissions = harness.db.$client
          .prepare(
            "select count(*) as n from events where thread_id = ? and type = 'client/turn/requested' and json_extract(data, '$.input[0].text') = 'look at this screenshot'",
          )
          .get(thread.id) as { n: number };
        expect(submissions.n).toBe(1);
      });
    },
  );
});
