import {
  createConnection,
  createNativeTerminalThread,
  createTerminalSession,
  getThread,
  migrate,
  setNativeTerminalThreadTerminal,
  setNativeTerminalToolCredential,
  terminalSessions,
  threads,
} from "@bb/db";
import { createHash } from "node:crypto";
import { createNodeBbSdk } from "@bb/sdk/node";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { recordNativeTerminalActivity } from "../../../src/services/threads/native-terminal-activity.js";
import {
  NATIVE_TOOL_CREDENTIAL_ENV,
  openNativeTerminal,
  reopenNativeTerminalsAfterDaemonReconnect,
} from "../../../src/services/threads/native-terminal-threads.js";
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

const reporterModule = await import(
  new URL("../../../../cli/src/native-activity-reporter.ts", import.meta.url)
    .href
);

const cases = [
  { provider: "claude-code", tool: "AskUserQuestion" },
  { provider: "claude-code", tool: "ExitPlanMode" },
  { provider: "claude-code", tool: "Bash" },
  { provider: "codex", tool: "request_user_input" },
].flatMap((flow) =>
  [false, true].map((answeredDuringOutage) => ({
    ...flow,
    answeredDuringOutage,
  })),
);

describe("unanswered native questions across holder reattachment", () => {
  it.each(cases)(
    "$provider $tool, answered during outage: $answeredDuringOutage",
    async ({ provider, tool, answeredDuringOutage }) => {
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
        let credential = "synthetic-reattach-test-credential";
        setNativeTerminalToolCredential(db, {
          threadId: thread.id,
          terminalSessionId: terminal.id,
          credentialHash: createHash("sha256").update(credential).digest("hex"),
        });
        let connected = true;
        const sdk = createNodeBbSdk({
          baseUrl: "http://127.0.0.1:3000",
          fetch: async (input, init) => {
            if (!connected) {
              throw new TypeError("fetch failed", {
                cause: Object.assign(new Error("connect ECONNREFUSED"), {
                  code: "ECONNREFUSED",
                }),
              });
            }
            return h.app.fetch(new Request(input, init));
          },
        });
        const reporter = reporterModule.createNativeActivityReporter({
          currentCredential: () => credential,
          send: (
            args: Parameters<typeof sdk.nativeTerminals.reportActivity>[0],
          ) => sdk.nativeTerminals.reportActivity(args),
          threadId: thread.id,
        });
        const report = async (next: ReturnType<typeof tracker.apply>) => {
          reporter.report(next);
          await reporter.settled();
        };
        await report(waiting);
        const listedThread = async () => {
          const response = await h.app.request(
            `/api/v1/threads?projectId=${project.id}`,
          );
          expect(response.status).toBe(200);
          const body = await response.json();
          return body.find((entry: { id: string }) => entry.id === thread.id);
        };
        expect(await listedThread()).toMatchObject({
          hasPendingInteraction: true,
          listIndicator: "needs-input",
          runtime: { displayStatus: "active" },
        });
        const pending =
          h.deps.pendingInteractions.listPendingThreadInteractions(thread.id);
        expect(pending).toHaveLength(1);
        db.update(terminalSessions)
          .set({ status: "disconnected" })
          .where(eq(terminalSessions.id, terminal.id))
          .run();
        vi.spyOn(h.deps.terminalSessions, "createTerminal").mockImplementation(
          async (args) => {
            const nextCredential = args.extraContributedEnv?.find(
              (entry) => entry.name === NATIVE_TOOL_CREDENTIAL_ENV,
            )?.value;
            if (nextCredential === undefined)
              throw new Error("missing credential");
            credential = nextCredential;
            return createTerminalSession(db, {
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
          },
        );
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
        if (answeredDuringOutage) {
          connected = false;
          const answered = tracker.apply(closing);
          expect(answered?.state).toBe("working");
          await report(answered);
          expect(
            h.deps.pendingInteractions.listPendingThreadInteractions(thread.id),
          ).toHaveLength(1);
        }
        db.update(threads)
          .set({ status: "error" })
          .where(eq(threads.id, thread.id))
          .run();
        await reopenNativeTerminalsAfterDaemonReconnect(h.deps, {
          hostId: host.id,
          threadIds: [thread.id],
        });
        expect(
          h.deps.pendingInteractions
            .listPendingThreadInteractions(thread.id)
            .map((row) => row.id),
        ).toEqual(pending.map((row) => row.id));
        expect(await listedThread()).toMatchObject({
          hasPendingInteraction: true,
          listIndicator: "needs-input",
          runtime: { displayStatus: "idle" },
        });
        connected = true;
        if (answeredDuringOutage) {
          reporter.retry();
          await reporter.settled();
        } else {
          await report(tracker.heartbeat());
          expect(await listedThread()).toMatchObject({
            hasPendingInteraction: true,
            listIndicator: "needs-input",
            runtime: {
              displayStatus: "active",
              nativeActivity: {
                confirmation: "confirmed",
                evidenceKind: "holder-report",
              },
            },
          });
          const answered = tracker.apply(closing);
          expect(answered?.state).toBe("working");
          await report(answered);
        }
        expect(
          h.deps.pendingInteractions.listPendingThreadInteractions(thread.id),
        ).toEqual([]);
        expect(await listedThread()).toMatchObject({
          hasPendingInteraction: false,
          listIndicator: "working",
          runtime: { displayStatus: "active" },
        });
        expect(getThread(db, thread.id)?.status).toBe("active");
        recordNativeTerminalActivity(h.deps, {
          state: "waiting",
          questions: [{ id: "replacement-question", prompt: "Choose again" }],
          confirms: true,
          threadId: thread.id,
        });
        expect((await listedThread()).listIndicator).toBe("needs-input");
        db.update(terminalSessions)
          .set({ status: "exited", closeReason: "process-exit" })
          .where(eq(terminalSessions.threadId, thread.id))
          .run();
        await openNativeTerminal(h.deps, {
          threadId: thread.id,
          request: {},
        });
        expect(
          h.deps.pendingInteractions.listPendingThreadInteractions(thread.id),
        ).toEqual([]);
        expect((await listedThread()).listIndicator).not.toBe("needs-input");
      });
    },
  );
});
