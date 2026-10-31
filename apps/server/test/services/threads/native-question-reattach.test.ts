import {
  createConnection,
  createNativeTerminalThread,
  createTerminalSession,
  getThread,
  migrate,
  setNativeTerminalThreadTerminal,
  terminalSessions,
} from "@bb/db";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { recordNativeTerminalActivity } from "../../../src/services/threads/native-terminal-activity.js";
import { reopenNativeTerminalsAfterDaemonReconnect } from "../../../src/services/threads/native-terminal-threads.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import { withTestHarness } from "../../helpers/test-app.js";

const activity = await import(
  new URL("../../../../cli/src/native-activity.ts", import.meta.url).href
);

const cases = [
  { provider: "claude-code", tool: "AskUserQuestion" },
  { provider: "claude-code", tool: "ExitPlanMode" },
  { provider: "claude-code", tool: "Bash" },
  { provider: "codex", tool: "request_user_input" },
];

describe("unanswered native questions across holder reattachment", () => {
  it.each(cases)(
    "preserves $provider $tool until its answer",
    async ({ provider, tool }) => {
      const db = createConnection(":memory:");
      migrate(db);
      await withTestHarness({ db }, async (h) => {
        const { host, session } = seedHostSession(h.deps);
        const { project } = seedProjectWithSource(h.deps, { hostId: host.id });
        const environment = seedEnvironment(h.deps, {
          hostId: host.id,
          projectId: project.id,
          status: "ready",
        });
        const thread = seedThread(h.deps, {
          environmentId: environment.id,
          projectId: project.id,
          providerId: provider,
        });
        createNativeTerminalThread(db, {
          threadId: thread.id,
          providerId: provider,
          nativeSessionId: "session-question",
          initialPrompt: null,
          initialImages: [],
          model: null,
        });
        const terminal = createTerminalSession(db, {
          threadId: thread.id,
          environmentId: environment.id,
          hostId: host.id,
          daemonSessionId: session.id,
          title: provider,
          initialCwd: "/tmp",
          cols: 80,
          rows: 24,
          status: "running",
        });
        setNativeTerminalThreadTerminal(db, {
          threadId: thread.id,
          terminalSessionId: terminal.id,
        });
        const cli = h.deps.providerRegistry.get(provider)?.nativeTerminal;
        if (!cli?.activity?.transcript)
          throw new Error("missing activity declaration");
        const tracker = new activity.NativeActivityTracker("reattach-test");
        const opening =
          tool === "Bash"
            ? activity.classifyHookRecord(cli.activity.hooks, {
                hook_event_name: "PermissionRequest",
                session_id: "session-question",
                tool_name: tool,
                tool_use_id: "call-question",
                tool_input: { command: "pwd" },
              })
            : activity.classifyTranscriptRecord(
                cli.activity.transcript,
                provider === "codex"
                  ? {
                      type: "response_item",
                      payload: {
                        type: "function_call",
                        name: tool,
                        call_id: "call-question",
                        arguments: "{}",
                      },
                    }
                  : {
                      type: "assistant",
                      message: {
                        content: [
                          {
                            type: "tool_use",
                            name: tool,
                            id: "call-question",
                            input: {
                              questions: [{ question: "Choose a schedule" }],
                            },
                          },
                        ],
                      },
                    },
              );
        const waiting = tracker.apply(opening);
        expect(waiting?.state).toBe("waiting");
        recordNativeTerminalActivity(h.deps, {
          ...waiting,
          confirms: true,
          threadId: thread.id,
        });
        const indicator = async () => {
          const response = await h.app.request(
            `/api/v1/threads?projectId=${project.id}`,
          );
          const body = await response.json();
          return body.find((entry: { id: string }) => entry.id === thread.id)
            ?.listIndicator;
        };
        expect(await indicator()).toBe("needs-input");
        const pending =
          h.deps.pendingInteractions.listPendingThreadInteractions(thread.id);
        expect(pending).toHaveLength(1);
        db.update(terminalSessions)
          .set({ status: "disconnected" })
          .where(eq(terminalSessions.id, terminal.id))
          .run();
        vi.spyOn(h.deps.terminalSessions, "createTerminal").mockImplementation(
          async () =>
            createTerminalSession(db, {
              threadId: thread.id,
              environmentId: environment.id,
              hostId: host.id,
              daemonSessionId: session.id,
              title: provider,
              initialCwd: "/tmp",
              cols: 80,
              rows: 24,
              status: "running",
            }),
        );
        await reopenNativeTerminalsAfterDaemonReconnect(h.deps, {
          hostId: host.id,
          threadIds: [thread.id],
        });
        expect(
          h.deps.pendingInteractions
            .listPendingThreadInteractions(thread.id)
            .map((row) => row.id),
        ).toEqual(pending.map((row) => row.id));
        recordNativeTerminalActivity(h.deps, {
          ...tracker.heartbeat(),
          confirms: true,
          threadId: thread.id,
        });
        expect(await indicator()).toBe("needs-input");
        const closing =
          tool === "Bash"
            ? activity.classifyHookRecord(cli.activity.hooks, {
                hook_event_name: "PostToolUse",
                session_id: "session-question",
                tool_name: tool,
                tool_use_id: "call-question",
                tool_input: { command: "pwd" },
              })
            : activity.classifyTranscriptRecord(
                cli.activity.transcript,
                provider === "codex"
                  ? {
                      type: "response_item",
                      payload: {
                        type: "function_call_output",
                        call_id: "call-question",
                        output: "Weekly",
                      },
                    }
                  : {
                      type: "user",
                      message: {
                        content: [
                          {
                            type: "tool_result",
                            tool_use_id: "call-question",
                            content: "Weekly",
                          },
                        ],
                      },
                    },
              );
        const answered = tracker.apply(closing);
        expect(answered?.state).toBe("working");
        recordNativeTerminalActivity(h.deps, {
          ...answered,
          closes: waiting.questions.map(
            (question: { id: string }) => question.id,
          ),
          confirms: true,
          threadId: thread.id,
        });
        expect(
          h.deps.pendingInteractions.listPendingThreadInteractions(thread.id),
        ).toEqual([]);
        expect(await indicator()).toBe("working");
        expect(getThread(db, thread.id)?.status).toBe("active");
      });
    },
  );
});
