import {
  claimQueuedThreadMessageGroup,
  deleteQueuedThreadMessage,
  deleteThread,
  events,
  getQueuedThreadMessage,
  getNativeTerminalThread,
  getThread,
  insertNativeTerminalDeliveryWarning,
  listNativeParentNotices,
  listNativeTerminalDeliveryMarks,
  listNativeTerminalDeliveryWarnings,
  listQueuedThreadMessages,
  threads,
  updateTerminalSessions,
} from "@bb/db";
import { ApiError } from "../../src/errors.js";
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
import { encodeClientTurnRequestIdNumber, threadScope } from "@bb/domain";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invokePluginInline,
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import {
  runPeriodicSweeps,
  runStartupRecoverySweep,
} from "../../src/services/system/periodic-sweeps.js";
import { recordNativeTerminalActivity } from "../../src/services/threads/native-terminal-activity.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import { readThreadProvisionContext } from "../../src/services/threads/thread-startup-store.js";
import { registerTestHostRpcCapture } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedEvent,
  seedThread,
  seedThreadRuntimeState,
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
  options: {
    firstSeq?: number;
    ignoredPastes?: number;
    pastePlaceholders?: boolean;
  } = {},
): FakeCli {
  const output: { seq: number; dataBase64: string }[] = [];
  let nextSeq = options.firstSeq ?? 7;
  let handled = 0;
  let ignoredPastes = options.ignoredPastes ?? 0;
  let inputBox: string[] = [];
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
        } else if (pasted !== null && options.pastePlaceholders === true) {
          inputBox.push(`[Pasted Content ${(pasted[1] ?? "").length} chars]`);
          draw(composerScreen(inputBox.join(" ")));
        } else if (pasted !== null) {
          draw(composerScreen(pasted[1] ?? ""));
        } else if (text === "\r") {
          inputBox = [];
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
    const sender = await openRunningNativeThread(before, {
      providerId: "codex",
    });
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
      const [mark] = listNativeTerminalDeliveryMarks(after.harness.db, [
        rows[0]!.id,
      ]);
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

  it("never re-sends a message a crashed server left mid-delivery when periodic ticks reach it before recovery, and delivers the newer message behind it once", async () => {
    const before = await createFixture();
    const { open, thread } = await openRunningNativeThread(before, {
      providerId: "codex",
    });
    const cli = startFakeCli(before, open.terminalId);
    let decision: HookDecision = { action: "wait", reason: AT_LIMIT_REASON };
    installDispatchHook(() => decision);
    try {
      await sendToThread(before, thread.id, "run the tests");
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
    const afterCli = startFakeCli(after, open.terminalId, { firstSeq: 100 });
    decision = { action: "wait", reason: AT_LIMIT_REASON };
    installDispatchHook(() => decision);
    try {
      const newer = await sendToThread(after, thread.id, "then run lint");
      expect(newer.delivery).toBe("queued");
      decision = { action: "proceed" };
      await runSweeps(after);
      await settle();
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await runSweeps(after);
      await drainEverything(after);

      expect(afterCli.inputs()).toEqual([
        "\u001b[200~then run lint\u001b[201~",
        "\r",
      ]);
      const rows = queuedRows(after, thread.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: "failed_exhausted",
        failureReason: UNCERTAIN_REASON,
      });
      expect(rows[0]?.content).toEqual(textInput("run the tests"));
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

  function dropTerminalInputFrame(fixture: Fixture, frame: number): void {
    const hub = fixture.harness.hub;
    const send = hub.sendDaemonSessionMessage.bind(hub);
    let inputFrames = 0;
    vi.spyOn(hub, "sendDaemonSessionMessage").mockImplementation(
      (sessionId, message) => {
        if (message.type === "terminal.input") {
          inputFrames += 1;
          if (inputFrames === frame) return false;
        }
        return send(sessionId, message);
      },
    );
  }

  function reconnectTerminal(fixture: Fixture, terminalId: string): void {
    updateTerminalSessions(fixture.harness.db, {
      scope: { kind: "terminal", terminalId },
      update: { kind: "reconnect", daemonSessionId: fixture.sessionId },
    });
  }

  it("never re-sends a held send whose paste was cut off after part of it reached the terminal, and tells the sender", async () => {
    const fixture = await createFixture();
    const sender = await openBusySender(fixture);
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(fixture, open.terminalId);
    let decision: HookDecision = { action: "wait", reason: AT_LIMIT_REASON };
    installDispatchHook(() => decision);
    const text = "run the tests ".repeat(5_000);
    try {
      const held = await sendToThread(
        fixture,
        thread.id,
        text,
        sender.thread.id,
      );
      expect(held.delivery).toBe("queued");
      dropTerminalInputFrame(fixture, 2);
      decision = { action: "proceed" };
      await runQueuedMessageDispatch(fixture.harness.deps, {
        kind: "plugin-recheck",
      });
      await settle();
      reconnectTerminal(fixture, open.terminalId);

      await drainEverything(fixture);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await runSweeps(fixture);
      await drainEverything(fixture);

      expect(
        cli.inputs().filter((input) => input.startsWith("\u001b[200~")),
      ).toHaveLength(1);
      expect(cli.inputs()).not.toContain("\r");
      const rows = queuedRows(fixture, thread.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: "failed_exhausted",
        failureReason: UNCERTAIN_REASON,
      });
      const senderNotices = listNativeParentNotices(
        fixture.harness.db,
        sender.thread.id,
      );
      expect(senderNotices).toHaveLength(1);
      expect(senderNotices[0]?.text).toContain("may not have been delivered");
    } finally {
      cli.stop();
    }
  }, 30_000);

  function closeHostAfterTerminalInputFrame(
    fixture: Fixture,
    frame: number,
  ): void {
    const hub = fixture.harness.hub;
    const send = hub.sendDaemonSessionMessage.bind(hub);
    let inputFrames = 0;
    vi.spyOn(hub, "sendDaemonSessionMessage").mockImplementation(
      (sessionId, message) => {
        const sent = send(sessionId, message);
        if (message.type === "terminal.input") {
          inputFrames += 1;
          if (inputFrames === frame) {
            fixture.harness.deps.terminalSessions.handleDaemonSessionClosed({
              sessionId: fixture.sessionId,
            });
          }
        }
        return sent;
      },
    );
  }

  async function expectHeldSendSettledUncertainAfterOnePaste(args: {
    interrupt: (fixture: Fixture) => void;
  }): Promise<void> {
    const fixture = await createFixture();
    const sender = await openBusySender(fixture);
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(fixture, open.terminalId, {
      pastePlaceholders: true,
    });
    let decision: HookDecision = { action: "wait", reason: AT_LIMIT_REASON };
    installDispatchHook(() => decision);
    try {
      const held = await sendToThread(
        fixture,
        thread.id,
        "run the tests",
        sender.thread.id,
      );
      expect(held.delivery).toBe("queued");
      args.interrupt(fixture);
      decision = { action: "proceed" };
      await runQueuedMessageDispatch(fixture.harness.deps, {
        kind: "plugin-recheck",
      });
      await settle();
      reconnectTerminal(fixture, open.terminalId);

      await drainEverything(fixture);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await runSweeps(fixture);
      await drainEverything(fixture);

      expect(cli.inputs()).toEqual(["\u001b[200~run the tests\u001b[201~"]);
      const rows = queuedRows(fixture, thread.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: "failed_exhausted",
        failureReason: UNCERTAIN_REASON,
      });
      const senderNotices = listNativeParentNotices(
        fixture.harness.db,
        sender.thread.id,
      );
      expect(senderNotices).toHaveLength(1);
      expect(senderNotices[0]?.text).toContain("may not have been delivered");
    } finally {
      cli.stop();
    }
  }

  it("never re-sends a held send whose Enter was refused after its paste reached the terminal, and tells the sender", async () => {
    await expectHeldSendSettledUncertainAfterOnePaste({
      interrupt: (fixture) => dropTerminalInputFrame(fixture, 2),
    });
  }, 30_000);

  it("never re-sends a held send when a disconnect is thrown after its paste's last frame was written, and tells the sender", async () => {
    await expectHeldSendSettledUncertainAfterOnePaste({
      interrupt: (fixture) => {
        vi.spyOn(
          fixture.harness.pluginService.events,
          "emitTerminalInput",
        ).mockImplementationOnce(() => {
          throw new ApiError(502, "host_disconnected", "Host is not connected");
        });
      },
    });
  }, 30_000);

  it("never re-sends a held send when the host disconnects after its paste reached the terminal, and tells the sender", async () => {
    await expectHeldSendSettledUncertainAfterOnePaste({
      interrupt: (fixture) => closeHostAfterTerminalInputFrame(fixture, 1),
    });
  }, 30_000);

  it("retries a held send whose first input frame never left the server, and delivers it once", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(fixture, open.terminalId);
    let decision: HookDecision = { action: "wait", reason: AT_LIMIT_REASON };
    installDispatchHook(() => decision);
    try {
      await sendToThread(fixture, thread.id, "run the tests");
      dropTerminalInputFrame(fixture, 1);
      decision = { action: "proceed" };
      await runQueuedMessageDispatch(fixture.harness.deps, {
        kind: "plugin-recheck",
      });
      await settle();
      expect(cli.inputs()).toEqual([]);
      reconnectTerminal(fixture, open.terminalId);

      await drainEverything(fixture);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await drainEverything(fixture);

      expect(cli.inputs()).toEqual([
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

  function failNoticeWrites(fixture: Fixture): () => void {
    fixture.harness.db.$client.exec(`
      CREATE TRIGGER fault_notice_insert BEFORE INSERT ON fork_native_parent_notices
        BEGIN SELECT RAISE(ABORT, 'simulated crash before the warning was written'); END;
    `);
    return () =>
      fixture.harness.db.$client.exec("DROP TRIGGER fault_notice_insert;");
  }

  function runSweeps(fixture: Fixture): Promise<void> {
    return runPeriodicSweeps({
      ...fixture.harness.deps,
      pluginSchedules: fixture.harness.pluginService,
      plugins: fixture.harness.pluginService,
    });
  }

  async function openBusySender(fixture: Fixture) {
    const sender = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    recordNativeTerminalActivity(fixture.harness.deps, {
      confirms: false,
      state: "working",
      threadId: sender.thread.id,
    });
    return sender;
  }

  it("tells the sender exactly once when the restart that held the message could not write the warning", async () => {
    const before = await createFixture();
    const sender = await openBusySender(before);
    const { open, thread } = await openRunningNativeThread(before, {
      providerId: "codex",
    });
    const cli = startFakeCli(before, open.terminalId);
    let decision: HookDecision = { action: "wait", reason: AT_LIMIT_REASON };
    installDispatchHook(() => decision);
    try {
      await sendToThread(before, thread.id, "run the tests", sender.thread.id);
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

    const first = await restartServer(before);
    const firstCli = startFakeCli(first, open.terminalId);
    try {
      const restore = failNoticeWrites(first);
      try {
        await runStartupRecoverySweep(first.harness.deps);
      } finally {
        restore();
      }
      expect(
        listNativeParentNotices(first.harness.db, sender.thread.id),
      ).toEqual([]);
      expect(firstCli.inputs()).toEqual([]);
    } finally {
      firstCli.stop();
    }

    const second = await restartServer(first);
    const secondCli = startFakeCli(second, open.terminalId);
    try {
      await runStartupRecoverySweep(second.harness.deps);
      await drainEverything(second);
      await runStartupRecoverySweep(second.harness.deps);
      await runSweeps(second);
      await drainEverything(second);

      const notices = listNativeParentNotices(
        second.harness.db,
        sender.thread.id,
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]?.text).toContain("may not have been delivered");
      expect(secondCli.inputs()).toEqual([]);
      expect(queuedRows(second, thread.id)[0]).toMatchObject({
        state: "failed_exhausted",
        failureReason: UNCERTAIN_REASON,
      });
    } finally {
      secondCli.stop();
    }
  }, 30_000);

  it("retries a sender warning whose write failed once and sends it exactly once", async () => {
    const fixture = await createFixture();
    const sender = await openBusySender(fixture);
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(fixture, open.terminalId);
    let decision: HookDecision = { action: "wait", reason: AT_LIMIT_REASON };
    installDispatchHook(() => decision);
    try {
      await sendToThread(fixture, thread.id, "run the tests", sender.thread.id);
      const restoreDeletes = failDeletesOfClaimedQueueRows(fixture);
      decision = { action: "proceed" };
      await runQueuedMessageDispatch(fixture.harness.deps, {
        kind: "plugin-recheck",
      });
      await settle();
      restoreDeletes();

      const restoreNotices = failNoticeWrites(fixture);
      try {
        await drainEverything(fixture);
      } finally {
        restoreNotices();
      }
      expect(
        listNativeParentNotices(fixture.harness.db, sender.thread.id),
      ).toEqual([]);

      await runSweeps(fixture);
      await runSweeps(fixture);
      await drainEverything(fixture);

      const notices = listNativeParentNotices(
        fixture.harness.db,
        sender.thread.id,
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]?.text).toContain("may not have been delivered");
      expect(cli.inputs()).toEqual([
        "\u001b[200~run the tests\u001b[201~",
        "\r",
      ]);
    } finally {
      cli.stop();
    }
  }, 30_000);

  function failQueueInsertsFor(fixture: Fixture, threadId: string): () => void {
    fixture.harness.db.$client.exec(`
      CREATE TRIGGER fault_queue_insert BEFORE INSERT ON queued_thread_messages
        WHEN NEW.thread_id = '${threadId}'
        BEGIN SELECT RAISE(ABORT, 'simulated failure writing the warning'); END;
    `);
    return () =>
      fixture.harness.db.$client.exec("DROP TRIGGER fault_queue_insert;");
  }

  async function crashAfterPaste(
    before: Fixture,
    senderThreadId: string,
  ): Promise<{
    pastes: string[];
    queuedMessageId: string;
    terminalId: string;
    threadId: string;
  }> {
    const { open, thread } = await openRunningNativeThread(before, {
      providerId: "codex",
    });
    const cli = startFakeCli(before, open.terminalId);
    let decision: HookDecision = { action: "wait", reason: AT_LIMIT_REASON };
    installDispatchHook(() => decision);
    try {
      await sendToThread(before, thread.id, "run the tests", senderThreadId);
      const [held] = listQueuedThreadMessages(before.harness.db, thread.id);
      expect(held).toBeDefined();
      const restore = failWritesToClaimedQueueRows(before);
      decision = { action: "proceed" };
      await runQueuedMessageDispatch(before.harness.deps, {
        kind: "plugin-recheck",
      });
      await settle();
      restore();
      return {
        pastes: cli.inputs(),
        queuedMessageId: held!.id,
        terminalId: open.terminalId,
        threadId: thread.id,
      };
    } finally {
      cli.stop();
    }
  }

  async function sweepEverything(fixture: Fixture): Promise<void> {
    await runStartupRecoverySweep(fixture.harness.deps);
    await drainEverything(fixture);
    await runSweeps(fixture);
    await drainEverything(fixture);
    await runSweeps(fixture);
  }

  function senderWarnings(fixture: Fixture, senderThreadId: string) {
    return listNativeParentNotices(fixture.harness.db, senderThreadId).filter(
      (notice) => notice.text.includes("may not have been delivered"),
    );
  }

  const PASTED_ONCE = ["\u001b[200~run the tests\u001b[201~", "\r"];

  it("still warns the sender once when the warning write failed and the held message was then deleted", async () => {
    const before = await createFixture();
    const sender = await openBusySender(before);
    const crashed = await crashAfterPaste(before, sender.thread.id);
    expect(crashed.pastes).toEqual(PASTED_ONCE);

    const first = await restartServer(before);
    const firstCli = startFakeCli(first, crashed.terminalId);
    const second = await (async () => {
      try {
        const restore = failNoticeWrites(first);
        try {
          await runStartupRecoverySweep(first.harness.deps);
        } finally {
          restore();
        }
        expect(senderWarnings(first, sender.thread.id)).toEqual([]);
        const [held] = listQueuedThreadMessages(
          first.harness.db,
          crashed.threadId,
        );
        expect(held).toBeDefined();
        expect(
          deleteQueuedThreadMessage(
            first.harness.db,
            first.harness.hub,
            held!.id,
          ),
        ).toBe(true);
        return await restartServer(first);
      } finally {
        firstCli.stop();
      }
    })();
    const secondCli = startFakeCli(second, crashed.terminalId);
    try {
      await sweepEverything(second);
      await sweepEverything(second);
      expect(senderWarnings(second, sender.thread.id)).toHaveLength(1);
      expect(firstCli.inputs()).toEqual([]);
      expect(secondCli.inputs()).toEqual([]);
    } finally {
      secondCli.stop();
    }
  }, 30_000);

  it("warns the sender once when the row could not be deleted after the paste and the owner then deleted it", async () => {
    const fixture = await createFixture();
    const sender = await openBusySender(fixture);
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(fixture, open.terminalId);
    let decision: HookDecision = { action: "wait", reason: AT_LIMIT_REASON };
    installDispatchHook(() => decision);
    try {
      await sendToThread(fixture, thread.id, "run the tests", sender.thread.id);
      const restore = failDeletesOfClaimedQueueRows(fixture);
      decision = { action: "proceed" };
      await runQueuedMessageDispatch(fixture.harness.deps, {
        kind: "plugin-recheck",
      });
      await settle();
      restore();
      const [held] = listQueuedThreadMessages(fixture.harness.db, thread.id);
      expect(held).toBeDefined();
      expect(
        deleteQueuedThreadMessage(
          fixture.harness.db,
          fixture.harness.hub,
          held!.id,
        ),
      ).toBe(true);

      await runSweeps(fixture);
      await drainEverything(fixture);
      await runSweeps(fixture);

      expect(senderWarnings(fixture, sender.thread.id)).toHaveLength(1);
      expect(cli.inputs()).toEqual(PASTED_ONCE);
    } finally {
      cli.stop();
    }
  }, 30_000);

  it("warns the sender once when the owner deleted the stuck message after a restart, before the startup sweep", async () => {
    const before = await createFixture();
    const sender = await openBusySender(before);
    const crashed = await crashAfterPaste(before, sender.thread.id);
    expect(crashed.pastes).toEqual(PASTED_ONCE);

    const after = await restartServer(before);
    const cli = startFakeCli(after, crashed.terminalId);
    try {
      expect(
        getQueuedThreadMessage(after.harness.db, crashed.queuedMessageId)
          ?.state,
      ).toBe("claimed");
      expect(
        deleteQueuedThreadMessage(
          after.harness.db,
          after.harness.hub,
          crashed.queuedMessageId,
        ),
      ).toBe(true);
      await sweepEverything(after);
      await sweepEverything(after);
      expect(senderWarnings(after, sender.thread.id)).toHaveLength(1);
      expect(cli.inputs()).toEqual([]);
    } finally {
      cli.stop();
    }
  }, 30_000);

  it("warns the sender once when the target thread is deleted while its message is stuck mid-delivery", async () => {
    const before = await createFixture();
    const sender = await openBusySender(before);
    const crashed = await crashAfterPaste(before, sender.thread.id);
    expect(crashed.pastes).toEqual(PASTED_ONCE);

    const after = await restartServer(before);
    expect(
      deleteThread(after.harness.db, after.harness.hub, crashed.threadId),
    ).toBe(true);
    expect(
      listQueuedThreadMessages(after.harness.db, crashed.threadId),
    ).toEqual([]);
    await sweepEverything(after);
    await sweepEverything(after);
    expect(senderWarnings(after, sender.thread.id)).toHaveLength(1);
  }, 30_000);

  it("warns the sender once when the target thread is deleted while the warning is still pending", async () => {
    const before = await createFixture();
    const sender = await openBusySender(before);
    const crashed = await crashAfterPaste(before, sender.thread.id);

    const first = await restartServer(before);
    const restore = failNoticeWrites(first);
    try {
      await runStartupRecoverySweep(first.harness.deps);
    } finally {
      restore();
    }
    expect(senderWarnings(first, sender.thread.id)).toEqual([]);
    expect(
      deleteThread(first.harness.db, first.harness.hub, crashed.threadId),
    ).toBe(true);

    const second = await restartServer(first);
    await sweepEverything(second);
    await sweepEverything(second);
    expect(senderWarnings(second, sender.thread.id)).toHaveLength(1);
  }, 30_000);

  it("queues exactly one warning on a chat sender whose first warning write failed, once the periodic sweep retries", async () => {
    const before = await createFixture();
    const chatSender = seedThread(before.harness.deps, {
      projectId: before.projectId,
      environmentId: before.environment.id,
      providerId: "claude-code",
      status: "active",
      title: "Chat sender",
    });
    seedThreadRuntimeState(before.harness.deps, {
      environmentId: before.environment.id,
      inputText: "Coordinate the run",
      providerThreadId: "chat-sender-session",
      threadId: chatSender.id,
    });
    seedEvent(before.harness.deps, {
      environmentId: before.environment.id,
      providerThreadId: "chat-sender-session",
      sequence: 3,
      threadId: chatSender.id,
      type: "client/turn/requested",
      scope: threadScope(),
      data: {
        direction: "outbound",
        requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
        source: "tell",
        initiator: "system",
        senderThreadId: null,
        input: [{ type: "text", text: "Coordinate the run" }],
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
    const crashed = await crashAfterPaste(before, chatSender.id);
    expect(crashed.pastes).toEqual(PASTED_ONCE);

    const after = await restartServer(before);
    const cli = startFakeCli(after, crashed.terminalId);
    const warnings = () =>
      listQueuedThreadMessages(after.harness.db, chatSender.id).filter(
        (row) =>
          row.systemNotice !== null &&
          row.content.includes("may not have been delivered"),
      );
    try {
      const restore = failQueueInsertsFor(after, chatSender.id);
      try {
        await runStartupRecoverySweep(after.harness.deps);
      } finally {
        restore();
      }
      expect(warnings()).toEqual([]);

      await runSweeps(after);
      await drainEverything(after);
      await runSweeps(after);
      await runStartupRecoverySweep(after.harness.deps);

      expect(warnings()).toHaveLength(1);
      expect(cli.inputs()).toEqual([]);
      expect(queuedRows(after, crashed.threadId)[0]).toMatchObject({
        state: "failed_exhausted",
        failureReason: UNCERTAIN_REASON,
      });
    } finally {
      cli.stop();
    }
  }, 30_000);

  it("drops the warning without delivering it when the sender thread is deleted while it is pending", async () => {
    const before = await createFixture();
    const sender = await openBusySender(before);
    const crashed = await crashAfterPaste(before, sender.thread.id);

    const first = await restartServer(before);
    const restore = failNoticeWrites(first);
    try {
      await runStartupRecoverySweep(first.harness.deps);
    } finally {
      restore();
    }
    first.harness.db
      .update(threads)
      .set({ deletedAt: Date.now() })
      .where(eq(threads.id, sender.thread.id))
      .run();

    const second = await restartServer(first);
    const cli = startFakeCli(second, crashed.terminalId);
    try {
      await sweepEverything(second);
      expect(senderWarnings(second, sender.thread.id)).toEqual([]);
      expect(cli.inputs()).toEqual([]);
    } finally {
      cli.stop();
    }
  }, 30_000);

  it("keeps exactly one warning when the server restarts after the warning was written", async () => {
    const before = await createFixture();
    const sender = await openBusySender(before);
    const crashed = await crashAfterPaste(before, sender.thread.id);

    const first = await restartServer(before);
    await runStartupRecoverySweep(first.harness.deps);
    expect(senderWarnings(first, sender.thread.id)).toHaveLength(1);

    const second = await restartServer(first);
    const cli = startFakeCli(second, crashed.terminalId);
    try {
      await sweepEverything(second);
      expect(senderWarnings(second, sender.thread.id)).toHaveLength(1);
      expect(cli.inputs()).toEqual([]);
    } finally {
      cli.stop();
    }
  }, 30_000);

  const ROUND_3_DELIVERIES_TABLE = `
    CREATE TABLE fork_native_terminal_deliveries (
      queued_message_id TEXT PRIMARY KEY NOT NULL
        REFERENCES queued_thread_messages(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      submitting_at INTEGER NOT NULL,
      uncertain_since INTEGER
    )
  `;
  const ROUND_4_DELIVERIES_TABLE = `
    CREATE TABLE fork_native_terminal_deliveries (
      queued_message_id TEXT PRIMARY KEY NOT NULL
        REFERENCES queued_thread_messages(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      submitting_at INTEGER NOT NULL,
      uncertain_since INTEGER,
      warning_sender_thread_id TEXT
    )
  `;

  it.each([
    ["round 3", ROUND_3_DELIVERIES_TABLE],
    ["round 4", ROUND_4_DELIVERIES_TABLE],
  ])(
    "holds a pasted send, warns once and delivers a new send once on a database left with the %s delivery table",
    async (_round, oldTable) => {
      const before = await createFixture();
      before.harness.db.$client.exec(oldTable);
      const sender = await openBusySender(before);
      const crashed = await crashAfterPaste(before, sender.thread.id);
      expect(crashed.pastes).toEqual(PASTED_ONCE);

      const after = await restartServer(before);
      const cli = startFakeCli(after, crashed.terminalId, { firstSeq: 100 });
      try {
        await sweepEverything(after);
        expect(cli.inputs()).toEqual([]);
        expect(queuedRows(after, crashed.threadId)).toMatchObject([
          { state: "failed_exhausted", failureReason: UNCERTAIN_REASON },
        ]);
        expect(senderWarnings(after, sender.thread.id)).toHaveLength(1);

        let decision: HookDecision = {
          action: "wait",
          reason: AT_LIMIT_REASON,
        };
        installDispatchHook(() => decision);
        const held = await sendToThread(
          after,
          crashed.threadId,
          "check the build",
          sender.thread.id,
        );
        expect(held.delivery).toBe("queued");
        decision = { action: "proceed" };
        await runQueuedMessageDispatch(after.harness.deps, {
          kind: "plugin-recheck",
        });
        await settle();
        await sweepEverything(after);

        expect(cli.inputs()).toEqual([
          "\u001b[200~check the build\u001b[201~",
          "\r",
        ]);
        expect(queuedRows(after, crashed.threadId)).toMatchObject([
          { state: "failed_exhausted", failureReason: UNCERTAIN_REASON },
        ]);
        expect(senderWarnings(after, sender.thread.id)).toHaveLength(1);
      } finally {
        cli.stop();
      }
    },
    30_000,
  );

  it("logs one warning at startup for a delivery table left by an earlier build, leaves its row alone, pastes nothing and still recovers current marks", async () => {
    const before = await createFixture();
    const sender = await openBusySender(before);
    const crashed = await crashAfterPaste(before, sender.thread.id);
    expect(crashed.pastes).toEqual(PASTED_ONCE);
    before.harness.db.$client.exec(ROUND_4_DELIVERIES_TABLE);
    before.harness.db.$client
      .prepare(
        `INSERT INTO fork_native_terminal_deliveries
          (queued_message_id, thread_id, submitting_at, uncertain_since, warning_sender_thread_id)
          VALUES (?, ?, 1, NULL, ?)`,
      )
      .run(crashed.queuedMessageId, crashed.threadId, sender.thread.id);
    const legacyRows = () =>
      before.harness.db.$client
        .prepare("SELECT * FROM fork_native_terminal_deliveries")
        .all();
    const legacyBefore = legacyRows();

    const after = await restartServer(before);
    const warn = vi.spyOn(after.harness.deps.logger, "warn");
    const cli = startFakeCli(after, crashed.terminalId, { firstSeq: 100 });
    try {
      await sweepEverything(after);
      await runSweeps(after);

      const legacyWarnings = warn.mock.calls.filter((call) =>
        call.some(
          (part) =>
            typeof part === "string" &&
            part.includes("delivery table from an earlier build"),
        ),
      );
      expect(legacyWarnings).toHaveLength(1);
      expect(legacyRows()).toEqual(legacyBefore);
      expect(cli.inputs()).toEqual([]);
      expect(queuedRows(after, crashed.threadId)).toMatchObject([
        { state: "failed_exhausted", failureReason: UNCERTAIN_REASON },
      ]);
      expect(senderWarnings(after, sender.thread.id)).toHaveLength(1);
    } finally {
      cli.stop();
    }
  }, 30_000);

  function turnRequests(fixture: Fixture, threadId: string) {
    return fixture.harness.db
      .select()
      .from(events)
      .where(eq(events.threadId, threadId))
      .all()
      .filter((row) => row.type === "client/turn/requested");
  }

  function chatWarnings(fixture: Fixture, threadId: string) {
    return listQueuedThreadMessages(fixture.harness.db, threadId).filter(
      (row) =>
        row.systemNotice !== null &&
        row.content.includes("may not have been delivered"),
    );
  }

  it("writes exactly one warning notice on a chat sender that has never run a turn, keeps it pending, and delivers it once with the sender's own execution after its first turn", async () => {
    const before = await createFixture();
    const chatSender = seedThread(before.harness.deps, {
      projectId: before.projectId,
      environmentId: before.environment.id,
      providerId: "claude-code",
      status: "idle",
      title: "Chat sender with no turn",
    });
    const crashed = await crashAfterPaste(before, chatSender.id);
    expect(crashed.pastes).toEqual(PASTED_ONCE);

    const after = await restartServer(before);
    const cli = startFakeCli(after, crashed.terminalId);
    try {
      await sweepEverything(after);
      await sweepEverything(after);

      expect(
        listNativeTerminalDeliveryWarnings(after.harness.db, {
          afterId: 0,
          limit: 10,
        }),
      ).toEqual([]);
      const notices = chatWarnings(after, chatSender.id);
      expect(notices).toHaveLength(1);
      expect(notices[0]?.state).not.toMatch(/^failed/);
      expect(notices[0]?.failureReason).toBeNull();
      expect(turnRequests(after, chatSender.id)).toEqual([]);
      expect(cli.inputs()).toEqual([]);
      cli.stop();

      registerTestHostRpcCapture(after.harness, {
        hostId: after.hostId,
        sessionId: after.sessionId,
      });
      seedThreadRuntimeState(after.harness.deps, {
        environmentId: after.environment.id,
        inputText: "Plan the release",
        model: "claude-sonnet-5-5",
        providerThreadId: "no-turn-sender-session",
        reasoningLevel: "high",
        threadId: chatSender.id,
      });
      await runQueuedMessageDispatch(after.harness.deps, {
        kind: "retry-due",
        now: Date.now() + 3 * 60 * 60 * 1000,
      });
      await settle();
      await sweepEverything(after);

      expect(chatWarnings(after, chatSender.id)).toEqual([]);
      const delivered = turnRequests(after, chatSender.id)
        .map(
          (row) =>
            JSON.parse(row.data) as {
              execution: { model: string; reasoningLevel: string };
              input: { text?: string }[];
            },
        )
        .filter((data) =>
          data.input.some((part) =>
            part.text?.includes("may not have been delivered"),
          ),
        );
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.execution).toMatchObject({
        model: "claude-sonnet-5-5",
        reasoningLevel: "high",
      });
    } finally {
      cli.stop();
    }
  }, 30_000);

  function seedPendingWarnings(
    fixture: Fixture,
    senderThreadId: string,
    count: number,
  ): void {
    for (let index = 0; index < count; index += 1) {
      insertNativeTerminalDeliveryWarning(fixture.harness.db, {
        now: Date.now(),
        queuedMessageId: `${senderThreadId}-held-${index}`,
        senderThreadId,
        targetThreadId: "thread-target",
        text: `A message you sent may not have been delivered (${senderThreadId} ${index})`,
      });
    }
  }

  it("delivers every pending warning exactly once when more are pending than one pass reads", async () => {
    const fixture = await createFixture();
    const sender = await openBusySender(fixture);
    seedPendingWarnings(fixture, sender.thread.id, 250);

    await runSweeps(fixture);
    await runSweeps(fixture);

    const texts = senderWarnings(fixture, sender.thread.id).map(
      (notice) => notice.text,
    );
    expect(texts).toHaveLength(250);
    expect(new Set(texts).size).toBe(250);
  }, 30_000);

  it("delivers a newer warning in the same sweep while older ones keep failing, then the older ones once", async () => {
    const fixture = await createFixture();
    const stuck = seedThread(fixture.harness.deps, {
      projectId: fixture.projectId,
      environmentId: fixture.environment.id,
      providerId: "claude-code",
      status: "active",
      title: "Chat sender whose queue rejects writes",
    });
    const sender = await openBusySender(fixture);
    seedPendingWarnings(fixture, stuck.id, 150);
    seedPendingWarnings(fixture, sender.thread.id, 1);

    const restore = failQueueInsertsFor(fixture, stuck.id);
    try {
      await runSweeps(fixture);
    } finally {
      restore();
    }
    expect(senderWarnings(fixture, sender.thread.id)).toHaveLength(1);
    expect(chatWarnings(fixture, stuck.id)).toEqual([]);

    await runSweeps(fixture);
    await runSweeps(fixture);
    expect(chatWarnings(fixture, stuck.id)).toHaveLength(150);
    expect(senderWarnings(fixture, sender.thread.id)).toHaveLength(1);
  }, 30_000);
});

describe("an open question in a native terminal", () => {
  const QUESTION_ID = "install-now";
  const PASTE = "\u001b[200~use the staging host\u001b[201~";

  function openQuestion(fixture: Fixture, threadId: string): void {
    recordNativeTerminalActivity(fixture.harness.deps, {
      confirms: true,
      questions: [{ id: QUESTION_ID, prompt: "Install now?" }],
      state: "waiting",
      threadId,
    });
  }

  function openQuestions(fixture: Fixture, threadId: string) {
    return fixture.harness.deps.pendingInteractions.listPendingThreadInteractions(
      threadId,
    );
  }

  function typed(cli: FakeCli): string[] {
    return cli.inputs().filter((input) => input !== "\u001b");
  }

  const closeQuestion = {
    answered: async (fixture: Fixture, threadId: string) => {
      recordNativeTerminalActivity(fixture.harness.deps, {
        closes: [QUESTION_ID],
        confirms: true,
        state: "working",
        threadId,
      });
    },
    dismissed: async (fixture: Fixture, threadId: string) => {
      recordNativeTerminalActivity(fixture.harness.deps, {
        confirms: true,
        state: "idle",
        threadId,
      });
    },
    interrupted: async (fixture: Fixture, threadId: string) => {
      const stopped = await postJson(fixture, `/threads/${threadId}/stop`, {});
      expect(stopped.status).toBe(200);
      recordNativeTerminalActivity(fixture.harness.deps, {
        confirms: true,
        state: "idle",
        threadId,
      });
    },
  } as const;

  async function drainQueue(fixture: Fixture): Promise<void> {
    const later = Date.now() + 60 * 60 * 1000;
    await settle();
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

  function openQuestionBeforeTheWrite(
    fixture: Fixture,
    threadId: string,
  ): void {
    const terminalSessions = fixture.harness.deps.terminalSessions;
    const readTerminalOutput =
      terminalSessions.readTerminalOutput.bind(terminalSessions);
    vi.spyOn(terminalSessions, "readTerminalOutput").mockImplementationOnce(
      async (...args) => {
        openQuestion(fixture, threadId);
        return readTerminalOutput(...args);
      },
    );
  }

  it.each(["active", "idle"] as const)(
    "holds a tell to an %s thread when a question opens after admission but before the paste, and delivers it once after the question closes",
    async (status) => {
      const fixture = await createFixture();
      const { open, thread } = await openRunningNativeThread(fixture, {
        providerId: "codex",
      });
      const cli = startFakeCli(fixture, open.terminalId);
      try {
        if (status === "active") {
          recordNativeTerminalActivity(fixture.harness.deps, {
            confirms: false,
            state: "working",
            threadId: thread.id,
          });
        }
        openQuestionBeforeTheWrite(fixture, thread.id);

        const sent = await sendToThread(
          fixture,
          thread.id,
          "use the staging host",
        );
        await drainQueue(fixture);

        expect(typed(cli)).toEqual([]);
        expect(sent.delivery).toBe("queued");
        expect(openQuestions(fixture, thread.id)).toHaveLength(1);

        await closeQuestion.dismissed(fixture, thread.id);
        await drainQueue(fixture);
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        await drainQueue(fixture);

        expect(typed(cli)).toEqual([PASTE, "\r"]);
        expect(queuedRows(fixture, thread.id)).toEqual([]);
      } finally {
        cli.stop();
      }
    },
    30_000,
  );

  it("holds a drained send when a question opens after admission but before the paste, and delivers it once after the question closes", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(fixture, open.terminalId);
    let decision: HookDecision = { action: "wait", reason: AT_LIMIT_REASON };
    installDispatchHook(() => decision);
    try {
      const held = await sendToThread(
        fixture,
        thread.id,
        "use the staging host",
      );
      expect(held.delivery).toBe("queued");
      openQuestionBeforeTheWrite(fixture, thread.id);
      decision = { action: "proceed" };
      await drainQueue(fixture);

      expect(typed(cli)).toEqual([]);
      expect(openQuestions(fixture, thread.id)).toHaveLength(1);
      expect(queuedRows(fixture, thread.id)).toHaveLength(1);

      await closeQuestion.dismissed(fixture, thread.id);
      await drainQueue(fixture);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await drainQueue(fixture);

      expect(typed(cli)).toEqual([PASTE, "\r"]);
      expect(queuedRows(fixture, thread.id)).toEqual([]);
    } finally {
      cli.stop();
    }
  }, 30_000);

  function openQuestionOnPendingThread(fixture: Fixture, threadId: string) {
    const providerId = getThread(fixture.harness.db, threadId)?.providerId;
    expect(providerId).toBeDefined();
    const registered =
      fixture.harness.deps.pendingInteractions.registerPendingInteraction({
        interaction: {
          threadId,
          turnId: "native-terminal-turn",
          providerId: providerId!,
          providerThreadId: threadId,
          providerRequestId: `question:${QUESTION_ID}`,
          payload: {
            kind: "user_question",
            questions: [
              {
                id: QUESTION_ID,
                prompt: "Install now?",
                multiSelect: false,
                allowFreeText: true,
                required: true,
              },
            ],
          },
        },
      });
    expect(registered.outcome).toBe("created");
    return registered.outcome === "created" ? registered.interaction.id : "";
  }

  async function expectHeldStartLaunchesOnceAfterQuestion(
    fixture: Fixture,
    args: { interactionId: () => string; threadId: string },
  ): Promise<void> {
    await settle();
    expect(terminalOpens(fixture.socket)).toEqual([]);
    expect(getThread(fixture.harness.db, args.threadId)?.status).toBe(
      "pending",
    );
    expect(readThreadProvisionContext(fixture.harness.db, args.threadId)).toBe(
      null,
    );
    const rows = queuedRows(fixture, args.threadId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.waitingOn).toEqual({ kind: "interaction" });
    expect(rows[0]?.content).toEqual(textInput("Fix the flaky test"));
    expect(openQuestions(fixture, args.threadId)).toHaveLength(1);

    fixture.harness.deps.pendingInteractions.interruptPendingInteraction({
      interactionId: args.interactionId(),
      reason: "Dismissed",
    });
    await drainQueue(fixture);

    const open = await waitForTerminalOpen(fixture.socket);
    expect(open.threadId).toBe(args.threadId);
    acknowledgeOpen(fixture, open);
    await waitForThreadStatus(fixture, args.threadId, "idle");
    expect(queuedRows(fixture, args.threadId)).toEqual([]);
    await drainQueue(fixture);
    expect(terminalOpens(fixture.socket)).toHaveLength(1);
    expect(terminalInputs(fixture.socket)).toEqual([]);
    const first = await launchSpec(fixture, args.threadId);
    const second = await launchSpec(fixture, args.threadId);
    expect(first.initialPrompt).toBe("Fix the flaky test");
    expect(second.initialPrompt).toBeNull();
  }

  it("holds a native create when a question opens during the limit decision that admits it, and launches it once after the question closes", async () => {
    const fixture = await createFixture();
    let interactionId = "";
    installDispatchHook((context) => {
      if (interactionId === "") {
        interactionId = openQuestionOnPendingThread(fixture, context.thread.id);
      }
      return { action: "proceed" };
    });

    const created = await createNativeThread(fixture, {
      providerId: "claude-code",
      prompt: "Fix the flaky test",
    });

    await expectHeldStartLaunchesOnceAfterQuestion(fixture, {
      interactionId: () => interactionId,
      threadId: created.id,
    });
  }, 30_000);

  it("holds a held native start when a question opens during the limit decision that releases it, and launches it once after the question closes", async () => {
    const fixture = await createFixture();
    let decision: HookDecision = { action: "wait", reason: AT_LIMIT_REASON };
    let interactionId = "";
    installDispatchHook((context) => {
      if (decision.action === "proceed" && interactionId === "") {
        interactionId = openQuestionOnPendingThread(fixture, context.thread.id);
      }
      return decision;
    });

    const created = await createNativeThread(fixture, {
      providerId: "claude-code",
      prompt: "Fix the flaky test",
    });
    expect(queuedRows(fixture, created.id)[0]?.waitingOn).toMatchObject({
      kind: "plugin",
    });

    decision = { action: "proceed" };
    await runQueuedMessageDispatch(fixture.harness.deps, {
      kind: "plugin-recheck",
    });

    await expectHeldStartLaunchesOnceAfterQuestion(fixture, {
      interactionId: () => interactionId,
      threadId: created.id,
    });
  }, 30_000);

  it("holds a tell to a pending thread with a running terminal when a question opens before the paste, and delivers it once after the question closes", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(fixture, open.terminalId);
    const setStatus = (status: "pending" | "idle") =>
      fixture.harness.db
        .update(threads)
        .set({ status })
        .where(eq(threads.id, thread.id))
        .run();
    try {
      setStatus("pending");
      let interactionId = "";
      const terminalSessions = fixture.harness.deps.terminalSessions;
      const readTerminalOutput =
        terminalSessions.readTerminalOutput.bind(terminalSessions);
      vi.spyOn(terminalSessions, "readTerminalOutput").mockImplementationOnce(
        async (...args) => {
          interactionId = openQuestionOnPendingThread(fixture, thread.id);
          return readTerminalOutput(...args);
        },
      );

      const sent = await sendToThread(
        fixture,
        thread.id,
        "use the staging host",
      );
      await settle();

      expect(typed(cli)).toEqual([]);
      expect(sent.delivery).toBe("queued");
      const rows = queuedRows(fixture, thread.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.waitingOn).toEqual({ kind: "interaction" });

      setStatus("idle");
      fixture.harness.deps.pendingInteractions.interruptPendingInteraction({
        interactionId,
        reason: "Dismissed",
      });
      await drainQueue(fixture);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await drainQueue(fixture);

      expect(typed(cli)).toEqual([PASTE, "\r"]);
      expect(queuedRows(fixture, thread.id)).toEqual([]);
    } finally {
      cli.stop();
    }
  }, 30_000);

  it.each(["answered", "dismissed", "interrupted"] as const)(
    "holds a tell while a question is open, leaves the question pending, and delivers the tell once after it is %s",
    async (how) => {
      const fixture = await createFixture();
      const { open, thread } = await openRunningNativeThread(fixture, {
        providerId: "codex",
      });
      const cli = startFakeCli(fixture, open.terminalId);
      try {
        openQuestion(fixture, thread.id);
        expect(openQuestions(fixture, thread.id)).toHaveLength(1);

        const sent = await sendToThread(
          fixture,
          thread.id,
          "use the staging host",
        );
        await drainQueue(fixture);

        expect(typed(cli)).toEqual([]);
        expect(sent.delivery).toBe("queued");
        expect(
          sent.delivery === "queued" ? sent.queuedMessage.waitingOn : null,
        ).toEqual({ kind: "interaction" });
        expect(openQuestions(fixture, thread.id)).toHaveLength(1);

        await closeQuestion[how](fixture, thread.id);
        await drainQueue(fixture);
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        await drainQueue(fixture);

        expect(typed(cli)).toEqual([PASTE, "\r"]);
        expect(queuedRows(fixture, thread.id)).toEqual([]);
      } finally {
        cli.stop();
      }
    },
    30_000,
  );

  it("keeps a held send from pasting when a question opened while it waited, then delivers it once after the question closes", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(fixture, open.terminalId);
    let decision: HookDecision = { action: "wait", reason: AT_LIMIT_REASON };
    installDispatchHook(() => decision);
    try {
      const held = await sendToThread(
        fixture,
        thread.id,
        "use the staging host",
      );
      expect(held.delivery).toBe("queued");
      openQuestion(fixture, thread.id);

      decision = { action: "proceed" };
      await drainQueue(fixture);

      expect(typed(cli)).toEqual([]);
      expect(openQuestions(fixture, thread.id)).toHaveLength(1);
      expect(queuedRows(fixture, thread.id)).toHaveLength(1);

      await closeQuestion.dismissed(fixture, thread.id);
      await drainQueue(fixture);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await drainQueue(fixture);

      expect(typed(cli)).toEqual([PASTE, "\r"]);
      expect(queuedRows(fixture, thread.id)).toEqual([]);
    } finally {
      cli.stop();
    }
  }, 30_000);

  it("refuses an explicit send-now while a question is open and keeps the message queued", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningNativeThread(fixture, {
      providerId: "codex",
    });
    const cli = startFakeCli(fixture, open.terminalId);
    let decision: HookDecision = { action: "wait", reason: AT_LIMIT_REASON };
    installDispatchHook(() => decision);
    try {
      const held = await sendToThread(
        fixture,
        thread.id,
        "use the staging host",
      );
      expect(held.delivery).toBe("queued");
      const queuedMessageId =
        held.delivery === "queued" ? held.queuedMessage.id : "";
      openQuestion(fixture, thread.id);
      decision = { action: "proceed" };

      const sendNow = await postJson(
        fixture,
        `/threads/${thread.id}/queued-messages/${queuedMessageId}/send`,
        { mode: "auto" },
      );
      await settle();

      expect(sendNow.status).toBe(409);
      expect(typed(cli)).toEqual([]);
      expect(openQuestions(fixture, thread.id)).toHaveLength(1);
      expect(queuedRows(fixture, thread.id)).toHaveLength(1);
    } finally {
      cli.stop();
    }
  }, 30_000);
});
