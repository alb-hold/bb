import {
  createConnection,
  getNativeTerminalThread,
  getThread,
  isNativeTerminalThread,
  type DbConnection,
} from "@bb/db";
import {
  hostDaemonOnlineRpcResponseMessageSchema,
  hostDaemonServerWsMessageSchema,
  type HostDaemonServerWsMessage,
} from "@bb/host-daemon-contract";
import {
  apiErrorSchema,
  nativeTerminalLaunchSpecSchema,
  nativeTerminalThreadSchema,
  threadResponseSchema,
} from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { stopThreadForCurrentState } from "../../src/services/threads/thread-lifecycle.js";
import { recordNativeTerminalActivity } from "../../src/services/threads/native-terminal-activity.js";
import type { ProviderNativeTerminalActivity } from "@bb/domain";

interface NativeActivityClassifiers {
  classifyHookRecord(
    hooks: NonNullable<ProviderNativeTerminalActivity["hooks"]>,
    record: unknown,
  ): { state: "working" | "idle" | null; prompt: string | null };
  classifyTranscriptRecord(
    transcript: NonNullable<ProviderNativeTerminalActivity["transcript"]>,
    record: unknown,
  ): { state: "working" | "idle" | null; prompt: string | null };
}

const {
  classifyHookRecord,
  classifyTranscriptRecord,
}: NativeActivityClassifiers = await import(
  new URL("../../../cli/src/native-activity.ts", import.meta.url).href
);
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadIdentity,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  createTestDb,
  type TestAppHarness,
} from "../helpers/test-app.js";

interface FakeDaemonSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  sentMessages: string[];
}

interface Fixture {
  environment: ReturnType<typeof seedEnvironment>;
  harness: TestAppHarness;
  hostId: string;
  projectId: string;
  sessionId: string;
  socket: FakeDaemonSocket;
}

type DaemonMessage<TType extends HostDaemonServerWsMessage["type"]> = Extract<
  HostDaemonServerWsMessage,
  { type: TType }
>;

const SESSION_ID = "2e624c50-68af-4689-9410-06caa371eb8a";
const harnesses: TestAppHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
});

async function createFixture(db?: DbConnection): Promise<Fixture> {
  const harness = await createTestAppHarness({ db });
  harnesses.push(harness);
  const seeded = seedHostSession(harness.deps, { id: "native-mode-host" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: seeded.host.id,
    path: "/tmp/native-mode-project",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: seeded.host.id,
    path: "/tmp/native-mode-workspace",
    projectId: project.id,
    status: "ready",
  });
  const sentMessages: string[] = [];
  const socket: FakeDaemonSocket = {
    close: vi.fn(),
    send: vi.fn((data: string) => {
      sentMessages.push(data);
    }),
    sentMessages,
  };
  harness.hub.registerDaemon(seeded.session.id, seeded.host.id, socket);
  return {
    environment,
    harness,
    hostId: seeded.host.id,
    projectId: project.id,
    sessionId: seeded.session.id,
    socket,
  };
}

async function waitForDaemonMessage<
  TType extends HostDaemonServerWsMessage["type"],
>(fixture: Fixture, type: TType, skip = 0): Promise<DaemonMessage<TType>> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const matches = fixture.socket.sentMessages
      .map((message) =>
        hostDaemonServerWsMessageSchema.parse(JSON.parse(message)),
      )
      .filter(
        (message): message is DaemonMessage<TType> => message.type === type,
      );
    const match = matches[skip];
    if (match !== undefined) return match;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

function countDaemonMessages(fixture: Fixture, type: string): number {
  return fixture.socket.sentMessages.filter((message) =>
    message.includes(`"type":"${type}"`),
  ).length;
}

async function waitForThreadStop(
  fixture: Fixture,
  threadId: string,
  after: number,
) {
  for (let skip = after; ; skip += 1) {
    const request = await waitForDaemonMessage(
      fixture,
      "host-rpc.request",
      skip,
    );
    if (
      request.command.type === "thread.stop" &&
      request.command.threadId === threadId
    ) {
      return { command: request.command, requestId: request.requestId };
    }
  }
}

function answerThreadStop(
  fixture: Fixture,
  requestId: string,
  outcome: "released" | "failed",
): void {
  fixture.harness.hub.recordHostOnlineRpcResponse({
    message: hostDaemonOnlineRpcResponseMessageSchema.parse(
      outcome === "released"
        ? {
            type: "host-rpc.response",
            requestId,
            commandType: "thread.stop",
            ok: true,
            result: { providerCheckpointId: null },
          }
        : {
            type: "host-rpc.response",
            requestId,
            commandType: "thread.stop",
            ok: false,
            errorCode: "test_release_failure",
            errorMessage: "Test release failure",
          },
    ),
    sessionId: fixture.sessionId,
  });
}

async function postJson(
  fixture: Fixture,
  path: string,
  body: unknown,
): Promise<Response> {
  return fixture.harness.app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function switchMode(
  fixture: Fixture,
  threadId: string,
  mode: "terminal" | "chat",
): Promise<Response> {
  return postJson(fixture, `/threads/${threadId}/native-terminal/mode`, {
    mode,
  });
}

function seedChatThread(
  fixture: Fixture,
  args: { providerId: string; providerThreadId: string | null },
) {
  const thread = seedThread(fixture.harness.deps, {
    projectId: fixture.projectId,
    environmentId: fixture.environment.id,
    providerId: args.providerId,
  });
  if (args.providerThreadId !== null) {
    seedThreadIdentity(fixture.harness.deps, {
      threadId: thread.id,
      environmentId: fixture.environment.id,
      providerThreadId: args.providerThreadId,
    });
  }
  return thread;
}

function acknowledgeOpen(
  fixture: Fixture,
  open: DaemonMessage<"terminal.open">,
): void {
  fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
    hostId: fixture.hostId,
    sessionId: fixture.sessionId,
    message: {
      type: "terminal.opened",
      requestId: open.requestId,
      terminalId: open.terminalId,
      shell: "/bin/zsh",
      title: "zsh",
      initialCwd: "/tmp/native-mode-workspace",
      cols: open.cols,
      rows: open.rows,
    },
  });
}

async function readApiErrorCode(response: Response): Promise<string> {
  return apiErrorSchema.parse(await readJson(response)).code;
}

async function enterTerminal(fixture: Fixture, threadId: string) {
  const stops = countDaemonMessages(fixture, "host-rpc.request");
  const opens = countDaemonMessages(fixture, "terminal.open");
  const switching = switchMode(fixture, threadId, "terminal");
  const stop = await waitForThreadStop(fixture, threadId, stops);
  expect(stop.command).toMatchObject({ intent: "release" });
  expect(isNativeTerminalThread(fixture.harness.db, threadId)).toBe(true);
  answerThreadStop(fixture, stop.requestId, "released");
  const open = await waitForDaemonMessage(fixture, "terminal.open", opens);
  expect(open.threadId).toBe(threadId);
  acknowledgeOpen(fixture, open);
  const response = await switching;
  expect(response.status).toBe(200);
  return {
    open,
    view: nativeTerminalThreadSchema.parse(await readJson(response)),
  };
}

describe("switching a chat thread to its native terminal", () => {
  it("resumes the chat's session in the terminal and returns to chat on it", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });

    const { open, view } = await enterTerminal(fixture, thread.id);
    expect(view).toMatchObject({
      threadId: thread.id,
      providerId: "claude-code",
      nativeSessionId: SESSION_ID,
      canReturnToChat: true,
    });
    expect(view.terminal?.id).toBe(open.terminalId);
    const launch = nativeTerminalLaunchSpecSchema.parse(
      await readJson(
        await postJson(
          fixture,
          `/threads/${thread.id}/native-terminal/launch`,
          {},
        ),
      ),
    );
    expect(launch).toMatchObject({
      nativeSessionId: SESSION_ID,
      initialPrompt: null,
    });

    const again = await switchMode(fixture, thread.id, "terminal");
    expect(again.status).toBe(200);
    expect(
      nativeTerminalThreadSchema.parse(await readJson(again)).terminal?.id,
    ).toBe(open.terminalId);

    const leaving = switchMode(fixture, thread.id, "chat");
    const close = await waitForDaemonMessage(fixture, "terminal.close");
    expect(close.terminalId).toBe(open.terminalId);
    expect(isNativeTerminalThread(fixture.harness.db, thread.id)).toBe(true);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: open.terminalId,
        exitCode: 0,
        closeReason: "user",
      },
    });
    const left = await leaving;
    expect(left.status).toBe(200);
    expect(await readJson(left)).toBeNull();
    expect(getNativeTerminalThread(fixture.harness.db, thread.id)).toBeNull();

    const reentered = await enterTerminal(fixture, thread.id);
    expect(reentered.view.nativeSessionId).toBe(SESSION_ID);
  });

  it("waits for a reopen in flight before returning to chat", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    const { open } = await enterTerminal(fixture, thread.id);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: open.terminalId,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });

    const opens = countDaemonMessages(fixture, "terminal.open");
    const reopening = postJson(
      fixture,
      `/threads/${thread.id}/native-terminal/open`,
      {},
    );
    const reopen = await waitForDaemonMessage(fixture, "terminal.open", opens);
    const leaving = switchMode(fixture, thread.id, "chat");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(countDaemonMessages(fixture, "terminal.close")).toBe(0);
    acknowledgeOpen(fixture, reopen);
    expect((await reopening).status).toBe(200);

    const close = await waitForDaemonMessage(fixture, "terminal.close");
    expect(close.terminalId).toBe(reopen.terminalId);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: reopen.terminalId,
        exitCode: 0,
        closeReason: "user",
      },
    });
    const left = await leaving;
    expect(left.status).toBe(200);
    expect(getNativeTerminalThread(fixture.harness.db, thread.id)).toBeNull();
  });

  it("keeps the thread in chat when the agent cannot be stopped", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    const switching = switchMode(fixture, thread.id, "terminal");
    const stop = await waitForThreadStop(fixture, thread.id, 0);
    answerThreadStop(fixture, stop.requestId, "failed");
    const response = await switching;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(isNativeTerminalThread(fixture.harness.db, thread.id)).toBe(false);
    expect(
      fixture.socket.sentMessages.some((message) =>
        message.includes('"terminal.open"'),
      ),
    ).toBe(false);
  });

  it("refuses threads it cannot resume in a terminal", async () => {
    const fixture = await createFixture();
    const noCli = seedChatThread(fixture, {
      providerId: "fake",
      providerThreadId: "fake-session",
    });
    const unsupported = await switchMode(fixture, noCli.id, "terminal");
    expect(unsupported.status).toBe(409);
    expect(await readApiErrorCode(unsupported)).toBe(
      "native_terminal_unsupported",
    );

    const fresh = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: null,
    });
    const noSession = await switchMode(fixture, fresh.id, "terminal");
    expect(noSession.status).toBe(409);
    expect(await readApiErrorCode(noSession)).toBe(
      "native_terminal_no_session",
    );

    const chat = await switchMode(fixture, fresh.id, "chat");
    expect(chat.status).toBe(200);
    expect(await readJson(chat)).toBeNull();

    for (const thread of [noCli, fresh]) {
      expect(isNativeTerminalThread(fixture.harness.db, thread.id)).toBe(false);
    }
  });

  it("keeps a thread born in the terminal there", async () => {
    const fixture = await createFixture();
    const created = await postJson(fixture, "/threads", {
      projectId: fixture.projectId,
      providerId: "claude-code",
      origin: "cli",
      input: [],
      environment: { type: "reuse", environmentId: fixture.environment.id },
      nativeTerminal: true,
    });
    expect(created.status).toBe(201);
    const thread = threadResponseSchema.parse(await readJson(created));
    const view = nativeTerminalThreadSchema.parse(
      await readJson(
        await fixture.harness.app.request(
          `/api/v1/threads/${thread.id}/native-terminal`,
        ),
      ),
    );
    expect(view.canReturnToChat).toBe(false);
    const chat = await switchMode(fixture, thread.id, "chat");
    expect(chat.status).toBe(409);
    expect(await readApiErrorCode(chat)).toBe(
      "native_terminal_no_chat_session",
    );
    expect(isNativeTerminalThread(fixture.harness.db, thread.id)).toBe(true);
  });
});

function reportActivity(
  fixture: Fixture,
  threadId: string,
  body: { state: "working" | "idle"; prompt?: string },
): Promise<Response> {
  return postJson(
    fixture,
    `/threads/${threadId}/native-terminal/activity`,
    body,
  );
}

function threadStatus(fixture: Fixture, threadId: string) {
  return getThread(fixture.harness.db, threadId)?.status;
}

describe("native terminal activity", () => {
  it("recovers working after a blocked Claude Stop and before the next tool", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    const hooks =
      fixture.harness.deps.providerRegistry.get("claude-code")!.nativeTerminal!
        .activity!.hooks!;
    for (const [hook_event_name, expected] of [
      ["UserPromptSubmit", "active"],
      ["Stop", "idle"],
      ["PreToolUse", "active"],
    ] as const) {
      const signal = classifyHookRecord(hooks, { hook_event_name });
      if (signal.state !== null) {
        await reportActivity(fixture, thread.id, { state: signal.state });
      }
      expect(threadStatus(fixture, thread.id)).toBe(expected);
    }
  });

  it.each([false, true])(
    "settles the real Claude Stop after continuation (stop_hook_active=%s)",
    async (stop_hook_active) => {
      const fixture = await createFixture();
      const thread = seedChatThread(fixture, {
        providerId: "claude-code",
        providerThreadId: SESSION_ID,
      });
      await enterTerminal(fixture, thread.id);
      const hooks =
        fixture.harness.deps.providerRegistry.get("claude-code")!
          .nativeTerminal!.activity!.hooks!;
      for (const hook_event_name of [
        "UserPromptSubmit",
        "Stop",
        "PreToolUse",
      ]) {
        const signal = classifyHookRecord(hooks, { hook_event_name });
        if (signal.state !== null) {
          await reportActivity(fixture, thread.id, { state: signal.state });
        }
      }
      expect(threadStatus(fixture, thread.id)).toBe("active");
      const signal = classifyHookRecord(hooks, {
        hook_event_name: "Stop",
        stop_hook_active,
      });
      expect(signal.state).toBe("idle");
      await reportActivity(fixture, thread.id, { state: "idle" });
      expect(threadStatus(fixture, thread.id)).toBe("idle");
    },
  );

  it("does no database work, event append or broadcast for repeated working signals", async () => {
    const queries = vi.fn();
    const template = createTestDb();
    const db = createConnection(template.$client.serialize(), {
      slowQueryLogger: { info: queries },
      slowQueryThresholdMs: 0,
    });
    template.$client.close();
    const fixture = await createFixture(db);
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    recordNativeTerminalActivity(fixture.harness.deps, {
      threadId: thread.id,
      state: "working",
    });
    const changes = fixture.harness.db.$client
      .prepare("SELECT total_changes()")
      .pluck();
    const before = changes.get();
    queries.mockClear();
    const notify = vi.spyOn(fixture.harness.hub, "notifyThread");
    try {
      for (let i = 0; i < 100; i += 1) {
        recordNativeTerminalActivity(fixture.harness.deps, {
          threadId: thread.id,
          state: "working",
        });
      }
      expect(queries).not.toHaveBeenCalled();
      expect(changes.get()).toBe(before);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      notify.mockRestore();
    }
    await reportActivity(fixture, thread.id, { state: "idle" });
    await reportActivity(fixture, thread.id, { state: "working" });
    expect(threadStatus(fixture, thread.id)).toBe("active");
  });

  it("keeps Codex tool and assistant entries working until task_complete, then handles another task and abort", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "codex",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    const transcript =
      fixture.harness.deps.providerRegistry.get("codex")!.nativeTerminal!
        .activity!.transcript!;
    for (const [record, expected] of [
      [{ type: "event_msg", payload: { type: "task_started" } }, "active"],
      [
        {
          type: "event_msg",
          payload: { type: "agent_message", message: "done" },
        },
        "active",
      ],
      [
        {
          type: "response_item",
          payload: { type: "function_call", name: "exec_command" },
        },
        "active",
      ],
      [{ type: "event_msg", payload: { type: "task_complete" } }, "idle"],
      [{ type: "event_msg", payload: { type: "task_started" } }, "active"],
      [{ type: "event_msg", payload: { type: "turn_aborted" } }, "idle"],
    ] as const) {
      const signal = classifyTranscriptRecord(transcript, record);
      if (signal.state !== null)
        await reportActivity(fixture, thread.id, { state: signal.state });
      expect(threadStatus(fixture, thread.id)).toBe(expected);
    }
  });

  it("shows a converted thread working while its CLI runs a turn, then done", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    expect(threadStatus(fixture, thread.id)).toBe("idle");
    const before = getThread(fixture.harness.db, thread.id)!.latestAttentionAt;

    for (const _ of [1, 2]) {
      const working = await reportActivity(fixture, thread.id, {
        state: "working",
      });
      expect(working.status).toBe(200);
      expect(threadStatus(fixture, thread.id)).toBe("active");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
    for (const _ of [1, 2]) {
      const idle = await reportActivity(fixture, thread.id, { state: "idle" });
      expect(idle.status).toBe(200);
      expect(threadStatus(fixture, thread.id)).toBe("idle");
    }
    expect(
      getThread(fixture.harness.db, thread.id)!.latestAttentionAt,
    ).toBeGreaterThan(before);
  });

  it("shows the turn working again after a daemon restart marked it failed", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    await reportActivity(fixture, thread.id, { state: "working" });
    applyLoggedThreadLifecycleEvent(fixture.harness.deps, {
      event: { type: "run.failed" },
      threadId: thread.id,
    });
    expect(threadStatus(fixture, thread.id)).toBe("error");

    await reportActivity(fixture, thread.id, { state: "working" });
    expect(threadStatus(fixture, thread.id)).toBe("active");
    await reportActivity(fixture, thread.id, { state: "idle" });
    expect(threadStatus(fixture, thread.id)).toBe("idle");
  });

  it("lets a host-wide stop settle a working native thread like an idle agent", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    await enterTerminal(fixture, thread.id);
    await reportActivity(fixture, thread.id, { state: "working" });
    const working = getThread(fixture.harness.db, thread.id)!;
    expect(working.status).toBe("active");
    const requests = countDaemonMessages(fixture, "host-rpc.request");

    const stopping = stopThreadForCurrentState(
      fixture.harness.deps,
      working,
      { id: fixture.environment.id, hostId: fixture.hostId },
      { requireStopped: true },
    );
    for (let answered = requests; ; answered += 1) {
      const settled = await Promise.race([
        stopping.then(() => true),
        waitForThreadStop(fixture, thread.id, answered).then((stop) => {
          answerThreadStop(fixture, stop.requestId, "released");
          return false;
        }),
      ]);
      if (settled) break;
    }
    await stopping;
    expect(threadStatus(fixture, thread.id)).toBe("idle");
    expect(isNativeTerminalThread(fixture.harness.db, thread.id)).toBe(true);
  });

  it("refuses activity for a thread that is not in its terminal", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    const response = await reportActivity(fixture, thread.id, {
      state: "working",
    });
    expect(response.status).toBe(404);
    expect(await readApiErrorCode(response)).toBe(
      "native_terminal_thread_not_found",
    );
    expect(threadStatus(fixture, thread.id)).toBe("idle");
  });

  it("stops a native turn by pressing Esc in the CLI, not by stopping an agent", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    const { open } = await enterTerminal(fixture, thread.id);
    await reportActivity(fixture, thread.id, { state: "working" });
    const stops = countDaemonMessages(fixture, "host-rpc.request");

    const stopped = await postJson(fixture, `/threads/${thread.id}/stop`, {});
    expect(stopped.status).toBe(200);
    const input = await waitForDaemonMessage(fixture, "terminal.input");
    expect(input).toMatchObject({
      terminalId: open.terminalId,
      dataBase64: Buffer.from("\u001b").toString("base64"),
    });
    expect(countDaemonMessages(fixture, "host-rpc.request")).toBe(stops);
  });

  it("settles a working thread when it goes back to chat", async () => {
    const fixture = await createFixture();
    const thread = seedChatThread(fixture, {
      providerId: "claude-code",
      providerThreadId: SESSION_ID,
    });
    const { open } = await enterTerminal(fixture, thread.id);
    await reportActivity(fixture, thread.id, { state: "working" });
    expect(threadStatus(fixture, thread.id)).toBe("active");

    const leaving = switchMode(fixture, thread.id, "chat");
    await waitForDaemonMessage(fixture, "terminal.close");
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: open.terminalId,
        exitCode: 0,
        closeReason: "user",
      },
    });
    expect((await leaving).status).toBe(200);
    expect(threadStatus(fixture, thread.id)).toBe("idle");
    expect(
      (await reportActivity(fixture, thread.id, { state: "working" })).status,
    ).toBe(404);
    expect(threadStatus(fixture, thread.id)).toBe("idle");
  });
});
