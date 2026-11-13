import {
  claimQueuedThreadMessageGroup,
  getNativeTerminalThread,
  getThread,
  listNativeParentNotices,
  listQueuedThreadMessages,
  threads,
} from "@bb/db";
import {
  hostDaemonServerWsMessageSchema,
  type HostDaemonServerWsMessage,
} from "@bb/host-daemon-contract";
import {
  nativeTerminalLaunchSpecSchema,
  sendMessageResponseSchema,
  threadResponseSchema,
} from "@bb/server-contract";
import type {
  MessageDispatchHookContext,
  PluginHookName,
} from "@get-bb/plugin-sdk";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invokePluginInline,
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { runStartupRecoverySweep } from "../../src/services/system/periodic-sweeps.js";
import { recordNativeTerminalActivity } from "../../src/services/threads/native-terminal-activity.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import { readThreadProvisionContext } from "../../src/services/threads/thread-startup-store.js";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

const HOOK_PLUGIN_ID = "native-admission-test";
const AT_LIMIT_REASON = "12 of 12 running on host native-host";

interface FakeDaemonSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  sentMessages: string[];
}

type TerminalOpenMessage = Extract<
  HostDaemonServerWsMessage,
  { type: "terminal.open" }
>;

interface Fixture {
  environment: ReturnType<typeof seedEnvironment>;
  harness: TestAppHarness;
  hostId: string;
  projectId: string;
  sessionId: string;
  socket: FakeDaemonSocket;
}

type HookRegistry = {
  [K in PluginHookName]: PluginHookRegistration<K>[];
};

type HookDecision = { action: "proceed" } | { action: "wait"; reason: string };

const harnesses: TestAppHarness[] = [];

afterEach(async () => {
  setPluginHookProvider(undefined);
  for (const harness of harnesses.splice(0)) await harness.cleanup();
});

function installDispatchHook(
  decide: (context: MessageDispatchHookContext) => HookDecision,
): MessageDispatchHookContext[] {
  const seen: MessageDispatchHookContext[] = [];
  const registry: HookRegistry = {
    "experimental_thread.configure": [],
    "message.dispatch": [
      {
        pluginId: HOOK_PLUGIN_ID,
        handler: (context) => {
          seen.push(context);
          return decide(context);
        },
      },
    ],
  };
  setPluginHookProvider({
    listHooks: (hook) => registry[hook],
    invokeHook: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
  return seen;
}

function createFakeDaemonSocket(): FakeDaemonSocket {
  const sentMessages: string[] = [];
  return {
    close: vi.fn(),
    send: vi.fn((data: string) => {
      sentMessages.push(data);
    }),
    sentMessages,
  };
}

function daemonMessages(socket: FakeDaemonSocket): HostDaemonServerWsMessage[] {
  return socket.sentMessages.map((message) =>
    hostDaemonServerWsMessageSchema.parse(JSON.parse(message)),
  );
}

function terminalOpens(socket: FakeDaemonSocket): TerminalOpenMessage[] {
  return daemonMessages(socket).filter(
    (message): message is TerminalOpenMessage =>
      message.type === "terminal.open",
  );
}

function terminalInputs(socket: FakeDaemonSocket): string[] {
  return daemonMessages(socket).flatMap((message) =>
    message.type === "terminal.input"
      ? [Buffer.from(message.dataBase64, "base64").toString("utf8")]
      : [],
  );
}

async function waitForTerminalOpen(
  socket: FakeDaemonSocket,
  skip = 0,
): Promise<TerminalOpenMessage> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const open = terminalOpens(socket)[skip];
    if (open !== undefined) return open;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for terminal.open");
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function createFixture(): Promise<Fixture> {
  const harness = await createTestAppHarness({});
  harnesses.push(harness);
  const seeded = seedHostSession(harness.deps, { id: "native-host" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: seeded.host.id,
    path: "/tmp/native-admission-project",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: seeded.host.id,
    path: "/tmp/native-admission-workspace",
    projectId: project.id,
    status: "ready",
  });
  const socket = createFakeDaemonSocket();
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

async function createNativeThread(
  fixture: Fixture,
  args: { providerId: string; prompt?: string; origin?: "app" | "cli" | "sdk" },
) {
  const response = await postJson(fixture, "/threads", {
    projectId: fixture.projectId,
    providerId: args.providerId,
    origin: args.origin ?? "cli",
    input: args.prompt === undefined ? [] : textInput(args.prompt),
    environment: { type: "reuse", environmentId: fixture.environment.id },
    nativeTerminal: true,
  });
  expect(response.status).toBe(201);
  return threadResponseSchema.parse(await readJson(response));
}

function acknowledgeOpen(fixture: Fixture, open: TerminalOpenMessage): void {
  fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
    hostId: fixture.hostId,
    sessionId: fixture.sessionId,
    message: {
      type: "terminal.opened",
      requestId: open.requestId,
      terminalId: open.terminalId,
      shell: "/bin/zsh",
      title: "zsh",
      initialCwd: "/tmp/native-admission-workspace",
      cols: open.cols,
      rows: open.rows,
    },
  });
}

async function waitForThreadStatus(
  fixture: Fixture,
  threadId: string,
  status: string,
): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (getThread(fixture.harness.db, threadId)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Thread ${threadId} never reached ${status}`);
}

async function waitForBoundTerminal(
  fixture: Fixture,
  threadId: string,
  terminalId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const record = getNativeTerminalThread(fixture.harness.db, threadId);
    if (record?.terminalSessionId === terminalId) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Thread ${threadId} never bound terminal ${terminalId}`);
}

async function openRunningNativeThread(
  fixture: Fixture,
  args: { providerId: string; prompt?: string },
) {
  const opened = terminalOpens(fixture.socket).length;
  const thread = await createNativeThread(fixture, args);
  const open = await waitForTerminalOpen(fixture.socket, opened);
  acknowledgeOpen(fixture, open);
  await waitForThreadStatus(fixture, thread.id, "idle");
  await waitForBoundTerminal(fixture, thread.id, open.terminalId);
  return { open, thread };
}

interface FakeCli {
  inputs(): string[];
  stop(): void;
}

function composerScreen(pasted: string): string {
  const words = pasted.split(" ");
  return `\u001b[2K\u001b[1G› ${words.join("\u001b[1C")}\u001b[0m`;
}

function startFakeCli(
  fixture: Fixture,
  terminalId: string,
  options: { ignoredPastes?: number } = {},
): FakeCli {
  const output: { seq: number; dataBase64: string }[] = [];
  let nextSeq = 7;
  let handled = 0;
  let ignoredPastes = options.ignoredPastes ?? 0;
  const draw = (text: string) => {
    output.push({
      seq: nextSeq,
      dataBase64: Buffer.from(text, "utf8").toString("base64"),
    });
    nextSeq += 1;
  };
  const timer = setInterval(() => {
    const messages = daemonMessages(fixture.socket);
    for (const message of messages.slice(handled)) {
      if (message.type === "terminal.input") {
        if (message.terminalId !== terminalId) continue;
        const text = Buffer.from(message.dataBase64, "base64").toString("utf8");
        const pasted = /^\u001b\[200~([\s\S]*)\u001b\[201~$/u.exec(text);
        if (pasted !== null && ignoredPastes > 0) {
          ignoredPastes -= 1;
        } else if (pasted !== null) {
          draw(composerScreen(pasted[1] ?? ""));
        } else if (text === "\r") {
          draw("\u001b[2K\u001b[1G› \u001b[0m");
        }
      }
      if (message.type === "terminal.attach") {
        if (message.terminalId !== terminalId) continue;
        fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
          hostId: fixture.hostId,
          sessionId: fixture.sessionId,
          message: {
            type: "terminal.replay",
            requestId: message.requestId,
            terminalId,
            chunks: output.filter((chunk) => chunk.seq >= message.sinceSeq),
            replayStartSeq: message.sinceSeq,
            nextSeq,
          },
        });
      }
    }
    handled = messages.length;
  }, 5);
  return {
    inputs: () =>
      daemonMessages(fixture.socket).flatMap((message) =>
        message.type === "terminal.input" && message.terminalId === terminalId
          ? [Buffer.from(message.dataBase64, "base64").toString("utf8")]
          : [],
      ),
    stop: () => clearInterval(timer),
  };
}

function queuedRows(fixture: Fixture, threadId: string) {
  return listQueuedThreadMessages(fixture.harness.db, threadId).map(
    toThreadQueuedMessage,
  );
}

async function sendToThread(
  fixture: Fixture,
  threadId: string,
  text: string,
  senderThreadId?: string,
) {
  const response = await postJson(fixture, `/threads/${threadId}/send`, {
    input: textInput(text),
    mode: "auto",
    ...(senderThreadId === undefined ? {} : { senderThreadId }),
  });
  expect(response.status).toBe(200);
  return sendMessageResponseSchema.parse(await readJson(response));
}

async function launchSpec(fixture: Fixture, threadId: string) {
  return nativeTerminalLaunchSpecSchema.parse(
    await readJson(
      await postJson(
        fixture,
        `/threads/${threadId}/native-terminal/launch`,
        {},
      ),
    ),
  );
}

describe("the concurrency cap on native terminal threads", () => {
  it("holds a bb send to an idle native thread at the limit and delivers it once a slot frees", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(fixture, open.terminalId);
    try {
      let decision: HookDecision = { action: "wait", reason: AT_LIMIT_REASON };
      const seen = installDispatchHook(() => decision);

      const held = await sendToThread(fixture, thread.id, "run the tests");

      expect(held.delivery).toBe("queued");
      expect(cli.inputs()).toEqual([]);
      expect(seen.map((context) => context.thread.id)).toEqual([thread.id]);
      expect(seen[0]?.attempt).toBe("start-turn");
      const rows = queuedRows(fixture, thread.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: "waiting",
        waitingOn: {
          kind: "plugin",
          pluginId: HOOK_PLUGIN_ID,
          reason: AT_LIMIT_REASON,
        },
      });
      expect(rows[0]?.content).toEqual(textInput("run the tests"));

      decision = { action: "proceed" };
      await runQueuedMessageDispatch(fixture.harness.deps, {
        kind: "plugin-recheck",
      });

      expect(cli.inputs()).toEqual([
        "\u001b[200~run the tests\u001b[201~",
        "\r",
      ]);
      expect(queuedRows(fixture, thread.id)).toEqual([]);

      await runQueuedMessageDispatch(fixture.harness.deps, {
        kind: "plugin-recheck",
      });
      expect(cli.inputs()).toEqual([
        "\u001b[200~run the tests\u001b[201~",
        "\r",
      ]);
    } finally {
      cli.stop();
    }
  });

  it("holds a native create with an initial prompt at the limit without starting its runtime, then launches it once", async () => {
    const fixture = await createFixture();
    let decision: HookDecision = { action: "wait", reason: AT_LIMIT_REASON };
    const seen = installDispatchHook(() => decision);

    const created = await createNativeThread(fixture, {
      providerId: "claude-code",
      prompt: "Fix the flaky test",
    });

    expect(getThread(fixture.harness.db, created.id)?.status).toBe("pending");
    expect(readThreadProvisionContext(fixture.harness.db, created.id)).toBe(
      null,
    );
    expect(seen.map((context) => context.thread.id)).toEqual([created.id]);
    expect(seen[0]?.host?.id).toBe(fixture.hostId);
    const rows = queuedRows(fixture, created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      waitingOn: {
        kind: "plugin",
        pluginId: HOOK_PLUGIN_ID,
        reason: AT_LIMIT_REASON,
      },
    });
    expect(rows[0]?.content).toEqual(textInput("Fix the flaky test"));
    await settle();
    expect(terminalOpens(fixture.socket)).toEqual([]);
    expect(getThread(fixture.harness.db, created.id)?.status).toBe("pending");

    decision = { action: "proceed" };
    await runQueuedMessageDispatch(fixture.harness.deps, {
      kind: "plugin-recheck",
    });

    const open = await waitForTerminalOpen(fixture.socket);
    expect(open.threadId).toBe(created.id);
    acknowledgeOpen(fixture, open);
    await waitForThreadStatus(fixture, created.id, "idle");
    expect(queuedRows(fixture, created.id)).toEqual([]);

    await runQueuedMessageDispatch(fixture.harness.deps, {
      kind: "plugin-recheck",
    });
    await settle();
    expect(terminalOpens(fixture.socket)).toHaveLength(1);
    expect(terminalInputs(fixture.socket)).toEqual([]);
    const first = await launchSpec(fixture, created.id);
    const second = await launchSpec(fixture, created.id);
    expect(first.initialPrompt).toBe("Fix the flaky test");
    expect(second.initialPrompt).toBeNull();
  });

  it("holds an empty native spawn from bb at the limit without starting its runtime, then starts it once", async () => {
    const fixture = await createFixture();
    let decision: HookDecision = { action: "wait", reason: AT_LIMIT_REASON };
    const seen = installDispatchHook(() => decision);

    const created = await createNativeThread(fixture, {
      providerId: "claude-code",
      origin: "sdk",
    });

    expect(getThread(fixture.harness.db, created.id)?.status).toBe("pending");
    expect(readThreadProvisionContext(fixture.harness.db, created.id)).toBe(
      null,
    );
    expect(seen.map((context) => context.thread.id)).toEqual([created.id]);
    const rows = queuedRows(fixture, created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.waitingOn).toMatchObject({
      kind: "plugin",
      reason: AT_LIMIT_REASON,
    });
    await settle();
    expect(terminalOpens(fixture.socket)).toEqual([]);

    decision = { action: "proceed" };
    await runQueuedMessageDispatch(fixture.harness.deps, {
      kind: "plugin-recheck",
    });

    const open = await waitForTerminalOpen(fixture.socket);
    expect(open.threadId).toBe(created.id);
    acknowledgeOpen(fixture, open);
    await waitForThreadStatus(fixture, created.id, "idle");
    expect(queuedRows(fixture, created.id)).toEqual([]);
    await runQueuedMessageDispatch(fixture.harness.deps, {
      kind: "plugin-recheck",
    });
    await settle();
    expect(terminalOpens(fixture.socket)).toHaveLength(1);
    expect(terminalInputs(fixture.socket)).toEqual([]);
    expect((await launchSpec(fixture, created.id)).initialPrompt).toBeNull();
  });

  it("starts an empty native session the owner opens at once, even at the limit", async () => {
    const fixture = await createFixture();
    const seen = installDispatchHook(() => ({
      action: "wait",
      reason: AT_LIMIT_REASON,
    }));

    const created = await createNativeThread(fixture, {
      providerId: "claude-code",
      origin: "app",
    });

    const open = await waitForTerminalOpen(fixture.socket);
    expect(open.threadId).toBe(created.id);
    acknowledgeOpen(fixture, open);
    await waitForThreadStatus(fixture, created.id, "idle");
    expect(seen).toEqual([]);
    expect(queuedRows(fixture, created.id)).toEqual([]);
  });

  it("queues a send behind a held native start and delivers both once, the initial prompt first", async () => {
    const fixture = await createFixture();
    let decision: HookDecision = { action: "wait", reason: AT_LIMIT_REASON };
    installDispatchHook(() => decision);

    const created = await createNativeThread(fixture, {
      providerId: "codex",
      prompt: "Fix the flaky test",
    });
    const followUp = await sendToThread(fixture, created.id, "then run lint");

    expect(followUp.delivery).toBe("queued");
    expect(getThread(fixture.harness.db, created.id)?.status).toBe("pending");
    expect(queuedRows(fixture, created.id).map((row) => row.content)).toEqual([
      textInput("Fix the flaky test"),
      textInput("then run lint"),
    ]);

    decision = { action: "proceed" };
    await runQueuedMessageDispatch(fixture.harness.deps, {
      kind: "plugin-recheck",
    });

    const open = await waitForTerminalOpen(fixture.socket);
    const cli = startFakeCli(fixture, open.terminalId);
    try {
      acknowledgeOpen(fixture, open);
      await waitForThreadStatus(fixture, created.id, "idle");
      for (let attempt = 0; attempt < 600; attempt += 1) {
        if (cli.inputs().length >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await settle();
      expect(cli.inputs()).toEqual([
        "\u001b[200~then run lint\u001b[201~",
        "\r",
      ]);
      expect(queuedRows(fixture, created.id)).toEqual([]);
      expect((await launchSpec(fixture, created.id)).initialPrompt).toBe(
        "Fix the flaky test",
      );
      await runQueuedMessageDispatch(fixture.harness.deps, {
        kind: "plugin-recheck",
      });
      await settle();
      expect(cli.inputs()).toHaveLength(2);
      expect(terminalOpens(fixture.socket)).toHaveLength(1);
    } finally {
      cli.stop();
    }
  });

  it("lets a native send and a native create through at once below the limit", async () => {
    const fixture = await createFixture();
    const seen = installDispatchHook(() => ({ action: "proceed" }));

    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
      prompt: "Start here",
    });
    expect(seen.map((context) => context.thread.id)).toEqual([thread.id]);
    expect(queuedRows(fixture, thread.id)).toEqual([]);

    const cli = startFakeCli(fixture, open.terminalId);
    try {
      const sent = await sendToThread(fixture, thread.id, "run the tests");
      expect(sent.delivery).toBe("sent");
      expect(cli.inputs()).toEqual([
        "\u001b[200~run the tests\u001b[201~",
        "\r",
      ]);
      expect(seen.map((context) => context.thread.id)).toEqual([
        thread.id,
        thread.id,
      ]);
      expect(queuedRows(fixture, thread.id)).toEqual([]);
    } finally {
      cli.stop();
    }
  });

  it("never holds a send to a native thread that is already running a turn", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    fixture.harness.db
      .update(threads)
      .set({ status: "active" })
      .where(eq(threads.id, thread.id))
      .run();
    const cli = startFakeCli(fixture, open.terminalId);
    try {
      installDispatchHook(() => ({ action: "wait", reason: AT_LIMIT_REASON }));

      const sent = await sendToThread(fixture, thread.id, "and the lint");

      expect(sent.delivery).toBe("sent");
      expect(cli.inputs()).toEqual([
        "\u001b[200~and the lint\u001b[201~",
        "\r",
      ]);
      expect(queuedRows(fixture, thread.id)).toEqual([]);
    } finally {
      cli.stop();
    }
  });

  it("never holds what the owner types into the native terminal", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const seen = installDispatchHook(() => ({
      action: "wait",
      reason: AT_LIMIT_REASON,
    }));

    const typed = Buffer.from("ls\r", "utf8").toString("base64");
    const response = await postJson(
      fixture,
      `/terminals/${open.terminalId}/input`,
      { dataBase64: typed },
    );

    expect(response.status).toBe(200);
    expect(terminalInputs(fixture.socket)).toEqual(["ls\r"]);
    expect(seen).toEqual([]);
    expect(queuedRows(fixture, thread.id)).toEqual([]);
  });
});

describe("native terminal delivery across a crash", () => {
  const UNCERTAIN_REASON =
    "Delivery uncertain after a restart: send again or delete";

  function failWritesToClaimedQueueRows(fixture: Fixture): () => void {
    fixture.harness.db.$client.exec(`
      CREATE TRIGGER fault_claimed_queue_delete BEFORE DELETE ON queued_thread_messages
        WHEN OLD.state = 'claimed'
        BEGIN SELECT RAISE(ABORT, 'simulated crash after the paste'); END;
      CREATE TRIGGER fault_claimed_queue_update BEFORE UPDATE ON queued_thread_messages
        WHEN OLD.state = 'claimed'
        BEGIN SELECT RAISE(ABORT, 'simulated crash after the paste'); END;
    `);
    return () =>
      fixture.harness.db.$client.exec(`
        DROP TRIGGER fault_claimed_queue_delete;
        DROP TRIGGER fault_claimed_queue_update;
      `);
  }

  function failDeletesOfClaimedQueueRows(fixture: Fixture): () => void {
    fixture.harness.db.$client.exec(`
      CREATE TRIGGER fault_claimed_queue_delete BEFORE DELETE ON queued_thread_messages
        WHEN OLD.state = 'claimed'
        BEGIN SELECT RAISE(ABORT, 'simulated failure after the paste'); END;
    `);
    return () =>
      fixture.harness.db.$client.exec(
        "DROP TRIGGER fault_claimed_queue_delete;",
      );
  }

  async function restartServer(fixture: Fixture): Promise<Fixture> {
    const harness = await createTestAppHarness({ db: fixture.harness.db });
    harnesses.push(harness);
    const socket = createFakeDaemonSocket();
    harness.hub.registerDaemon(fixture.sessionId, fixture.hostId, socket);
    return { ...fixture, harness, socket };
  }

  async function drainEverything(fixture: Fixture): Promise<void> {
    const later = Date.now() + 60 * 60 * 1000;
    await runQueuedMessageDispatch(fixture.harness.deps, {
      kind: "plugin-recheck",
    });
    await runQueuedMessageDispatch(fixture.harness.deps, {
      kind: "retry-due",
      now: later,
    });
    await runQueuedMessageDispatch(fixture.harness.deps, {
      kind: "idle-recovery",
      now: later,
    });
    await settle();
  }

  it("never re-sends a held send that a crashed server pasted before deleting its row, and tells the sender", async () => {
    const before = await createFixture();
    const sender = await openRunningNativeThread(before, { providerId: "codex" });
    recordNativeTerminalActivity(before.harness.deps, {
      confirms: false,
      state: "working",
      threadId: sender.thread.id,
    });
    const { open, thread } = await openRunningNativeThread(before, {
      providerId: "codex",
    });
    const cli = startFakeCli(before, open.terminalId);
    let decision: HookDecision = { action: "wait", reason: AT_LIMIT_REASON };
    installDispatchHook(() => decision);
    try {
      const held = await sendToThread(
        before,
        thread.id,
        "run the tests",
        sender.thread.id,
      );
      expect(held.delivery).toBe("queued");

      const restore = failWritesToClaimedQueueRows(before);
      decision = { action: "proceed" };
      await runQueuedMessageDispatch(before.harness.deps, {
        kind: "plugin-recheck",
      });
      await settle();
      restore();
      expect(cli.inputs()).toEqual([
        "\u001b[200~run the tests\u001b[201~",
        "\r",
      ]);
    } finally {
      cli.stop();
    }

    const after = await restartServer(before);
    const afterCli = startFakeCli(after, open.terminalId);
    try {
      await runStartupRecoverySweep(after.harness.deps);
      await drainEverything(after);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await drainEverything(after);

      expect(afterCli.inputs()).toEqual([]);
      const rows = queuedRows(after, thread.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: "failed_exhausted",
        failureReason: UNCERTAIN_REASON,
      });
      expect(rows[0]?.content).toEqual(textInput("run the tests"));
      const senderNotices = listNativeParentNotices(
        after.harness.db,
        sender.thread.id,
      );
      expect(senderNotices).toHaveLength(1);
      expect(senderNotices[0]?.text).toContain("may not have been delivered");
      expect(senderNotices[0]?.text).toContain(thread.id);
      const [mark] = after.harness.db.$client
        .prepare(
          "SELECT submitting_at AS submittingAt FROM fork_native_terminal_deliveries WHERE queued_message_id = ?",
        )
        .all(rows[0]?.id) as { submittingAt: number }[];
      expect(typeof mark?.submittingAt).toBe("number");

      await runStartupRecoverySweep(after.harness.deps);
      await drainEverything(after);
      expect(afterCli.inputs()).toEqual([]);
      expect(
        listNativeParentNotices(after.harness.db, sender.thread.id),
      ).toHaveLength(1);
    } finally {
      afterCli.stop();
    }
  }, 30_000);

  it("never re-sends a held send whose row could not be deleted after the paste", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(fixture, open.terminalId);
    let decision: HookDecision = { action: "wait", reason: AT_LIMIT_REASON };
    installDispatchHook(() => decision);
    try {
      await sendToThread(fixture, thread.id, "run the tests");
      const restore = failDeletesOfClaimedQueueRows(fixture);
      decision = { action: "proceed" };
      await runQueuedMessageDispatch(fixture.harness.deps, {
        kind: "plugin-recheck",
      });
      await settle();
      restore();

      await drainEverything(fixture);
      await drainEverything(fixture);

      expect(cli.inputs()).toEqual([
        "\u001b[200~run the tests\u001b[201~",
        "\r",
      ]);
      const rows = queuedRows(fixture, thread.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: "failed_exhausted",
        failureReason: UNCERTAIN_REASON,
      });
    } finally {
      cli.stop();
    }
  }, 30_000);

  it("puts a held send back when its paste fails and delivers it once on a later drain", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(fixture, open.terminalId, { ignoredPastes: 1 });
    let decision: HookDecision = { action: "wait", reason: AT_LIMIT_REASON };
    installDispatchHook(() => decision);
    try {
      await sendToThread(fixture, thread.id, "run the tests");
      decision = { action: "proceed" };
      await runQueuedMessageDispatch(fixture.harness.deps, {
        kind: "plugin-recheck",
      });

      expect(cli.inputs()).toEqual(["\u001b[200~run the tests\u001b[201~"]);
      const failed = queuedRows(fixture, thread.id);
      expect(failed).toHaveLength(1);
      expect(failed[0]?.state).not.toBe("claimed");
      expect(failed[0]?.state).not.toBe("failed_exhausted");

      await drainEverything(fixture);
      await drainEverything(fixture);

      expect(cli.inputs()).toEqual([
        "\u001b[200~run the tests\u001b[201~",
        "\u001b[200~run the tests\u001b[201~",
        "\r",
      ]);
      expect(queuedRows(fixture, thread.id)).toEqual([]);
    } finally {
      cli.stop();
    }
  }, 30_000);

  it("delivers a held send once when the server crashed after claiming it but before marking it", async () => {
    const before = await createFixture();
    const { open, thread } = await openRunningNativeThread(before, {
      providerId: "codex",
    });
    installDispatchHook(() => ({ action: "wait", reason: AT_LIMIT_REASON }));
    await sendToThread(before, thread.id, "run the tests");
    const [row] = listQueuedThreadMessages(before.harness.db, thread.id);
    expect(row).toBeDefined();
    const claimed = claimQueuedThreadMessageGroup(
      before.harness.db,
      before.harness.hub,
      row!.id,
      { kind: "explicit-send" },
    );
    expect(claimed).toHaveLength(1);

    const after = await restartServer(before);
    const cli = startFakeCli(after, open.terminalId);
    installDispatchHook(() => ({ action: "proceed" }));
    try {
      await runStartupRecoverySweep(after.harness.deps);
      await drainEverything(after);
      await drainEverything(after);

      expect(cli.inputs()).toEqual([
        "\u001b[200~run the tests\u001b[201~",
        "\r",
      ]);
      expect(queuedRows(after, thread.id)).toEqual([]);
    } finally {
      cli.stop();
    }
  }, 30_000);
});
