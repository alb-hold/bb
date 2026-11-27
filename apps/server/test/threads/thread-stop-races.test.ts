import {
  createQueuedThreadMessage,
  getThread,
  listQueuedThreadMessages,
  listQueuedThreadMessagesWaitingOnKind,
  readThreadRunState,
} from "@bb/db";
import { listEvents } from "@bb/db/testing";
import { turnScope, type ResolvedThreadExecutionOptions } from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import {
  requestThreadStopForCurrentState,
  stopThreadForCurrentState,
} from "../../src/services/threads/thread-lifecycle.js";
import {
  advanceThreadProvisioning,
  requestThreadProvision,
} from "../../src/services/threads/thread-provisioning.js";
import {
  internalAuthHeaders,
  listQueuedThreadCommands,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
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
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const EXECUTION = {
  model: "gpt-5",
  serviceTier: "default",
  reasoningLevel: "medium",
  permissionMode: "accept-edits",
  source: "client/turn/requested",
} satisfies ResolvedThreadExecutionOptions;

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function postDaemonEvent(
  harness: TestAppHarness,
  args: {
    hostId: string;
    sessionId: string;
    threadId: string;
    event:
      | { type: "turn/started"; turnId: string }
      | {
          type: "turn/completed";
          turnId: string;
          status: "completed" | "interrupted";
        };
  },
): Promise<void> {
  const { event } = args;
  const response = await harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness, { hostId: args.hostId }),
    body: JSON.stringify({
      sessionId: args.sessionId,
      eventGroups: groupHostDaemonEvents([
        {
          threadId: args.threadId,
          event:
            event.type === "turn/started"
              ? {
                  type: "turn/started",
                  threadId: args.threadId,
                  providerThreadId: "provider-stop-races",
                  scope: turnScope(event.turnId),
                }
              : {
                  type: "turn/completed",
                  threadId: args.threadId,
                  providerThreadId: "provider-stop-races",
                  scope: turnScope(event.turnId),
                  status: event.status,
                },
        },
      ]),
    }),
  });
  expect(response.status).toBe(200);
  await settle();
}

describe("repeated stops", () => {
  it("records one provisioning cancellation however often a provisioning thread is stopped", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-stop-races-1",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/stop-races-1",
        status: "provisioning",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "starting",
      });
      requestThreadProvision(harness.deps, {
        originPluginId: null,
        author: { initiator: "user", senderThreadId: null },
        thread,
        environmentIntent: { type: "reuse", environmentId: environment.id },
        execution: EXECUTION,
        fork: null,
        input: textInput("x"),
        startedOnBehalfOf: null,
        titleProvided: true,
      });
      await advanceThreadProvisioning(harness.deps, { threadId: thread.id });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        requestThreadStopForCurrentState(harness.deps, thread);
        await settle();
      }

      expect(
        listEvents(harness.db, { threadId: thread.id }).filter(
          (event) =>
            event.type === "system/thread-provisioning" &&
            JSON.parse(String(event.data)).status === "cancelled",
        ),
      ).toHaveLength(1);
    });
  });

  it("does not let a late turn start revive a thread stopped twice before its turn began", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-stop-races-2",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/stop-races-2",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/stop-races-2",
        status: "ready",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-stop-races-2",
        threadId: thread.id,
      });

      requestThreadStopForCurrentState(harness.deps, thread);
      await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      requestThreadStopForCurrentState(harness.deps, thread);
      await settle();
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            {
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-stop-races-2",
                scope: turnScope("turn-late"),
              },
            },
          ]),
        }),
      });
      expect(response.status).toBe(200);
      await settle();

      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toHaveLength(2);
    });
  });

  it("keeps a turn the provider starts by itself after a stop whose interrupted turn ended before the stop was answered", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-stop-races-4",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/stop-races-4",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/stop-races-4",
        status: "ready",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        threadId: thread.id,
        turnId: "turn-stopped",
      });
      const daemon = {
        hostId: host.id,
        sessionId: session.id,
        threadId: thread.id,
      };

      requestThreadStopForCurrentState(harness.deps, thread);
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      await postDaemonEvent(harness, {
        ...daemon,
        event: {
          type: "turn/completed",
          turnId: "turn-stopped",
          status: "interrupted",
        },
      });
      await reportQueuedCommandSuccess(harness, stop, {
        providerCheckpointId: null,
      });
      await settle();
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");

      await postDaemonEvent(harness, {
        ...daemon,
        event: { type: "turn/started", turnId: "turn-background" },
      });

      expect(getThread(harness.db, thread.id)?.status).toBe("active");
      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toEqual([]);
      expect(readThreadRunState(harness.db, thread.id).stop).toBeNull();

      await postDaemonEvent(harness, {
        ...daemon,
        event: {
          type: "turn/completed",
          turnId: "turn-background",
          status: "completed",
        },
      });
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
    });
  });

  it("dispatches a queued follow-up once a stop whose turn start was swallowed is answered as retained", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-stop-races-5",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/stop-races-5",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/stop-races-5",
        status: "ready",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-stop-races-5",
        threadId: thread.id,
      });
      createQueuedThreadMessage(harness.db, harness.deps.hub, {
        threadId: thread.id,
        content: textInput("send me after the stop"),
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        senderThreadId: null,
        waitingOn: { kind: "turn-starting" },
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: { kind: "unlabeled", subject: null },
      });

      requestThreadStopForCurrentState(harness.deps, thread);
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      await postDaemonEvent(harness, {
        hostId: host.id,
        sessionId: session.id,
        threadId: thread.id,
        event: { type: "turn/started", turnId: "turn-aimed" },
      });
      expect(getThread(harness.db, thread.id)?.status).toBe("stopping");
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([]);

      await reportQueuedCommandSuccess(harness, stop, {
        providerCheckpointId: null,
        activeTurnRetained: true,
      });
      await settle();

      expect(getThread(harness.db, thread.id)?.status).toBe("active");
      const submit = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(submit.command.type).toBe("turn.submit");
      expect(
        listQueuedThreadMessagesWaitingOnKind(harness.db, {
          kind: "turn-starting",
          threadId: thread.id,
        }),
      ).toEqual([]);
    });
  });

  it.each([
    ["after", 1],
    ["before", 0],
    ["in the same millisecond as", 0],
  ] as const)(
    "a retained stop pauses only follow-ups queued %s the stop was requested",
    async (when, expectedRequests) => {
      await withTestHarness(async (harness) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: `host-stop-races-retained-${when.replaceAll(" ", "-")}`,
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: `/tmp/stop-races-retained-${when.replaceAll(" ", "-")}`,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: `/tmp/stop-races-retained-${when.replaceAll(" ", "-")}`,
          status: "ready",
        });
        const thread = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          status: "active",
        });
        seedTurnStarted(harness.deps, {
          environmentId: environment.id,
          threadId: thread.id,
          turnId: "turn-retained",
        });
        const sendFollowUp = async (text: string) => {
          const response = await harness.app.request(
            `/api/v1/threads/${thread.id}/send`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                input: [{ type: "text", text }],
                mode: "queue-if-active",
                model: "gpt-5",
                permissionMode: "full",
                reasoningLevel: "medium",
                serviceTier: "default",
              }),
            },
          );
          expect(response.status, await response.clone().text()).toBe(200);
        };
        if (when !== "after") {
          await sendFollowUp("typed before the stop");
        }

        requestThreadStopForCurrentState(harness.deps, thread);
        const stop = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.stop" && command.threadId === thread.id,
        );
        if (when === "in the same millisecond as") {
          harness.db.$client
            .prepare(
              "update queued_thread_messages set created_at = (select max(created_at) from events where thread_id = ? and type = 'system/thread/interrupted') where thread_id = ?",
            )
            .run(thread.id, thread.id);
        }
        await reportQueuedCommandSuccess(harness, stop, {
          providerCheckpointId: null,
          activeTurnRetained: true,
        });
        await settle();
        expect(getThread(harness.db, thread.id)?.status).toBe("active");
        if (when === "after") {
          await sendFollowUp("typed after the stop");
        }
        await postDaemonEvent(harness, {
          hostId: host.id,
          sessionId: session.id,
          threadId: thread.id,
          event: {
            type: "turn/completed",
            turnId: "turn-retained",
            status: "completed",
          },
        });
        await settle();
        await settle();

        const requested = harness.db.$client
          .prepare(
            "select count(*) as n from events where thread_id = ? and type = 'client/turn/requested'",
          )
          .get(thread.id) as { n: number };
        expect(requested.n).toBe(expectedRequests);
        expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(
          1 - expectedRequests,
        );
      });
    },
  );

  it("settles an awaited stop of a live thread that has no environment", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-stop-races-3",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        status: "active",
      });

      await stopThreadForCurrentState(harness.deps, thread, null);

      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
    });
  });
});
