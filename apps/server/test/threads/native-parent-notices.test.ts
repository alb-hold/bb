import {
  createNativeTerminalThread,
  getNativeParentNoticeDeliveredAt,
  getNativeTerminalThread,
  getThread,
  listNativeParentNotices,
} from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
} from "@bb/domain";
import {
  groupHostDaemonEvents,
  hostDaemonServerWsMessageSchema,
  type HostDaemonEventEnvelope,
  type HostDaemonServerWsMessage,
} from "@bb/host-daemon-contract";
import { threadResponseSchema } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPeriodicSweeps } from "../../src/services/system/periodic-sweeps.js";
import { enqueueNativeParentNotice } from "../../src/services/threads/native-parent-notices.js";
import { recordNativeTerminalActivity } from "../../src/services/threads/native-terminal-activity.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

type TerminalOpenMessage = Extract<
  HostDaemonServerWsMessage,
  { type: "terminal.open" }
>;

interface FakeDaemonSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  sentMessages: string[];
}

interface Fixture {
  environmentId: string;
  harness: TestAppHarness;
  hostId: string;
  projectId: string;
  sessionId: string;
  socket: FakeDaemonSocket;
}

interface FakeClaudeTui {
  draw(text: string): void;
  inputs(): string[];
  pastes(): string[];
  stop(): void;
}

const BORDER = "\u2500".repeat(40);
const EMPTY_PROMPT_SCREEN = `\u001b[2J\u001b[1;1H\u23fa ok\r\n${BORDER}\r\n\u276f\u00a0\r\n${BORDER}\r\n  Sonnet 5.5`;
const TYPED_PROMPT_SCREEN = `\u001b[3;1H\u001b[2K\u276f owner is typing`;
const UNAUTHORIZED_DETAIL =
  "Failed to authenticate. API Error: 401 Invalid bearer token.";
const NOTICE_TAIL = /-- bb, \d\d:\d\d:\d\d$/u;

const harnesses: TestAppHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(20);
  }
  throw new Error("Timed out waiting for condition");
}

function daemonMessages(socket: FakeDaemonSocket): HostDaemonServerWsMessage[] {
  return socket.sentMessages.map((message) =>
    hostDaemonServerWsMessageSchema.parse(JSON.parse(message)),
  );
}

async function createFixture(): Promise<Fixture> {
  const harness = await createTestAppHarness({});
  harnesses.push(harness);
  const seeded = seedHostSession(harness.deps, { id: "native-host" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: seeded.host.id,
    path: "/tmp/native-project",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: seeded.host.id,
    path: "/tmp/native-workspace",
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
    environmentId: environment.id,
    harness,
    hostId: seeded.host.id,
    projectId: project.id,
    sessionId: seeded.session.id,
    socket,
  };
}

async function waitForTerminalOpen(
  socket: FakeDaemonSocket,
): Promise<TerminalOpenMessage> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const open = daemonMessages(socket).find(
      (message): message is TerminalOpenMessage =>
        message.type === "terminal.open",
    );
    if (open !== undefined) return open;
    await sleep(5);
  }
  throw new Error("Timed out waiting for terminal.open");
}

async function openRunningClaudeParent(fixture: Fixture) {
  const response = await fixture.harness.app.request("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: fixture.projectId,
      providerId: "claude-code",
      origin: "cli",
      input: [{ type: "text", text: "Coordinate the child threads" }],
      environment: { type: "reuse", environmentId: fixture.environmentId },
      nativeTerminal: true,
    }),
  });
  expect(response.status).toBe(201);
  const thread = threadResponseSchema.parse(await readJson(response));
  const open = await waitForTerminalOpen(fixture.socket);
  fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
    hostId: fixture.hostId,
    sessionId: fixture.sessionId,
    message: {
      type: "terminal.opened",
      requestId: open.requestId,
      terminalId: open.terminalId,
      shell: "/bin/zsh",
      title: "zsh",
      initialCwd: "/tmp/native-workspace",
      cols: open.cols,
      rows: open.rows,
    },
  });
  await waitFor(
    () =>
      getThread(fixture.harness.db, thread.id)?.status === "idle" &&
      getNativeTerminalThread(fixture.harness.db, thread.id)
        ?.terminalSessionId === open.terminalId,
    3_000,
  );
  return { open, thread };
}

function startFakeClaudeTui(
  fixture: Fixture,
  terminalId: string,
  initialScreen: string,
): FakeClaudeTui {
  let nextSeq = 1;
  let handled = 0;
  let pasteCount = 0;
  const output: { seq: number; dataBase64: string }[] = [];
  const draw = (text: string) => {
    const chunk = {
      seq: nextSeq,
      dataBase64: Buffer.from(text, "utf8").toString("base64"),
    };
    output.push(chunk);
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: { type: "terminal.output", terminalId, chunk },
    });
    nextSeq += 1;
  };
  draw(initialScreen);
  const timer = setInterval(() => {
    const messages = daemonMessages(fixture.socket);
    for (const message of messages.slice(handled)) {
      if (
        message.type === "terminal.attach" &&
        message.terminalId === terminalId
      ) {
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
        continue;
      }
      if (
        message.type !== "terminal.input" ||
        message.terminalId !== terminalId
      ) {
        continue;
      }
      const text = Buffer.from(message.dataBase64, "base64").toString("utf8");
      const pasted = /^\u001b\[200~([\s\S]*)\u001b\[201~$/u.exec(text);
      if (pasted !== null) {
        pasteCount += 1;
        const lines = (pasted[1] ?? "").split("\n").length - 1;
        draw(
          `\u001b[3;1H\u001b[2K\u276f [Pasted text #${pasteCount} +${lines} lines]`,
        );
      } else if (text === "\r") {
        draw(`\u001b[3;1H\u001b[2K\u276f\u00a0`);
      }
    }
    handled = messages.length;
  }, 5);
  const inputs = () =>
    daemonMessages(fixture.socket).flatMap((message) =>
      message.type === "terminal.input" && message.terminalId === terminalId
        ? [Buffer.from(message.dataBase64, "base64").toString("utf8")]
        : [],
    );
  return {
    draw,
    inputs,
    pastes: () =>
      inputs().flatMap((text) => {
        const pasted = /^\u001b\[200~([\s\S]*)\u001b\[201~$/u.exec(text);
        return pasted === null ? [] : [pasted[1] ?? ""];
      }),
    stop: () => clearInterval(timer),
  };
}

function seedChild(fixture: Fixture, parentThreadId: string, index: number) {
  const providerThreadId = `child-session-${index}`;
  const child = seedThread(fixture.harness.deps, {
    environmentId: fixture.environmentId,
    parentThreadId,
    projectId: fixture.projectId,
    providerId: "claude-code",
    status: "active",
    title: `Child ${index}`,
  });
  seedThreadRuntimeState(fixture.harness.deps, {
    environmentId: fixture.environmentId,
    inputText: "Do the thing",
    providerThreadId,
    threadId: child.id,
  });
  seedEvent(fixture.harness.deps, {
    environmentId: fixture.environmentId,
    providerThreadId,
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
  seedTurnStarted(fixture.harness.deps, {
    environmentId: fixture.environmentId,
    providerThreadId,
    threadId: child.id,
    turnId: `turn-${index}`,
    sequence: 4,
  });
  return { child, providerThreadId, turnId: `turn-${index}` };
}

async function postEvents(
  fixture: Fixture,
  events: HostDaemonEventEnvelope[],
): Promise<void> {
  const response = await fixture.harness.app.request(
    "/internal/session/events",
    {
      method: "POST",
      headers: internalAuthHeaders(fixture.harness),
      body: JSON.stringify({
        sessionId: fixture.sessionId,
        eventGroups: groupHostDaemonEvents(events),
      }),
    },
  );
  expect(response.status).toBe(200);
}

function failChild(
  fixture: Fixture,
  seeded: ReturnType<typeof seedChild>,
): Promise<void> {
  const base = {
    threadId: seeded.child.id,
    providerThreadId: seeded.providerThreadId,
    scope: turnScope(seeded.turnId),
  };
  return postEvents(fixture, [
    {
      threadId: seeded.child.id,
      event: {
        ...base,
        type: "provider/error",
        message: "Provider error",
        detail: UNAUTHORIZED_DETAIL,
        errorInfo: {
          category: "unauthorized",
          providerCode: null,
          httpStatusCode: 401,
        },
      },
    },
    {
      threadId: seeded.child.id,
      event: { ...base, type: "turn/completed", status: "failed" },
    },
  ]);
}

function completeChild(
  fixture: Fixture,
  seeded: ReturnType<typeof seedChild>,
): Promise<void> {
  const base = {
    threadId: seeded.child.id,
    providerThreadId: seeded.providerThreadId,
    scope: turnScope(seeded.turnId),
  };
  return postEvents(fixture, [
    {
      threadId: seeded.child.id,
      event: { ...base, type: "turn/completed", status: "completed" },
    },
  ]);
}

describe("child notices for a native terminal parent", () => {
  it("delivers exactly one notice when a child fails", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningClaudeParent(fixture);
    const tui = startFakeClaudeTui(
      fixture,
      open.terminalId,
      EMPTY_PROMPT_SCREEN,
    );
    try {
      const seeded = seedChild(fixture, thread.id, 1);
      await failChild(fixture, seeded);
      await waitFor(() => tui.pastes().length > 0, 20_000);
      await sleep(1_000);
      const [notice, ...rest] = tui.pastes();
      expect(rest).toEqual([]);
      expect(notice?.startsWith("[bb notice]")).toBe(true);
      expect(notice).toContain(`@thread:${seeded.child.id}`);
      expect(notice).toContain("failed");
      expect(notice).toContain(UNAUTHORIZED_DETAIL);
      expect(notice).toMatch(NOTICE_TAIL);
      expect(tui.inputs().filter((input) => input === "\r")).toHaveLength(1);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("delivers exactly one notice when a child completes", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningClaudeParent(fixture);
    const tui = startFakeClaudeTui(
      fixture,
      open.terminalId,
      EMPTY_PROMPT_SCREEN,
    );
    try {
      const seeded = seedChild(fixture, thread.id, 1);
      await completeChild(fixture, seeded);
      await waitFor(() => tui.pastes().length > 0, 20_000);
      await sleep(1_000);
      const [notice, ...rest] = tui.pastes();
      expect(rest).toEqual([]);
      expect(notice?.startsWith("[bb notice]")).toBe(true);
      expect(notice).toContain(`@thread:${seeded.child.id} completed`);
      expect(notice).toMatch(NOTICE_TAIL);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("holds a notice until the parent's turn ends and sends nothing meanwhile", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningClaudeParent(fixture);
    const tui = startFakeClaudeTui(
      fixture,
      open.terminalId,
      EMPTY_PROMPT_SCREEN,
    );
    try {
      recordNativeTerminalActivity(fixture.harness.deps, {
        confirms: false,
        state: "working",
        threadId: thread.id,
      });
      expect(getThread(fixture.harness.db, thread.id)?.status).toBe("active");
      const seeded = seedChild(fixture, thread.id, 1);
      await failChild(fixture, seeded);
      await sleep(5_500);
      expect(tui.inputs()).toEqual([]);
      recordNativeTerminalActivity(fixture.harness.deps, {
        confirms: false,
        state: "idle",
        threadId: thread.id,
      });
      await waitFor(() => tui.pastes().length > 0, 20_000);
      await sleep(1_000);
      expect(tui.pastes()).toHaveLength(1);
      expect(tui.pastes()[0]).toContain(`@thread:${seeded.child.id}`);
    } finally {
      tui.stop();
    }
  }, 40_000);

  it("never writes into an input box that holds the owner's unsent text", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningClaudeParent(fixture);
    const tui = startFakeClaudeTui(
      fixture,
      open.terminalId,
      EMPTY_PROMPT_SCREEN,
    );
    try {
      tui.draw(TYPED_PROMPT_SCREEN);
      const seeded = seedChild(fixture, thread.id, 1);
      await failChild(fixture, seeded);
      await sleep(6_000);
      expect(tui.inputs()).toEqual([]);
      tui.draw("\u001b[3;1H\u001b[2K❯ ");
      await waitFor(() => tui.pastes().length > 0, 10_000);
      expect(tui.pastes()).toHaveLength(1);
      expect(tui.pastes()[0]).toContain(`@thread:${seeded.child.id}`);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it.each([
    ["Claude draft, cursor at its start", "❯ half a thought", 3],
    ["Claude draft, cursor in its middle", "❯ half a thought", 9],
    [
      "Codex-shaped draft, cursor at its start",
      "\u001b[1m›\u001b[22m half a thought",
      3,
    ],
  ])(
    "sends no paste and no Enter into a %s",
    async (_label, promptRow, cursorColumn) => {
      const fixture = await createFixture();
      const { open, thread } = await openRunningClaudeParent(fixture);
      const tui = startFakeClaudeTui(
        fixture,
        open.terminalId,
        EMPTY_PROMPT_SCREEN,
      );
      try {
        tui.draw(`\u001b[3;1H\u001b[2K${promptRow}\u001b[3;${cursorColumn}H`);
        const seeded = seedChild(fixture, thread.id, 1);
        await failChild(fixture, seeded);
        await sleep(6_000);
        expect(tui.inputs()).toEqual([]);
        tui.draw("\u001b[3;1H\u001b[2K❯ ");
        await waitFor(() => tui.pastes().length > 0, 10_000);
        expect(tui.pastes()).toHaveLength(1);
        expect(tui.pastes()[0]).toContain(`@thread:${seeded.child.id}`);
      } finally {
        tui.stop();
      }
    },
    30_000,
  );

  it("delivers into a Codex-shaped idle prompt whose placeholder is dim", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningClaudeParent(fixture);
    const tui = startFakeClaudeTui(
      fixture,
      open.terminalId,
      EMPTY_PROMPT_SCREEN,
    );
    try {
      tui.draw(
        "\u001b[2J\u001b[1;1H• done\u001b[3;1H\u001b[1m›\u001b[22m \u001b[2mAsk Codex to do anything\u001b[22m\u001b[3;3H\u001b[5;1H  GPT Ready",
      );
      const seeded = seedChild(fixture, thread.id, 1);
      await failChild(fixture, seeded);
      await waitFor(() => tui.pastes().length > 0, 20_000);
      await sleep(1_000);
      expect(tui.pastes()).toHaveLength(1);
      expect(tui.pastes()[0]).toContain(`@thread:${seeded.child.id}`);
    } finally {
      tui.stop();
    }
  }, 40_000);

  it("batches children that fail together into one delivery naming all of them", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningClaudeParent(fixture);
    const tui = startFakeClaudeTui(
      fixture,
      open.terminalId,
      EMPTY_PROMPT_SCREEN,
    );
    try {
      const children = [1, 2, 3, 4].map((index) =>
        seedChild(fixture, thread.id, index),
      );
      for (const seeded of children) await failChild(fixture, seeded);
      await waitFor(() => tui.pastes().length > 0, 20_000);
      await sleep(1_000);
      expect(tui.pastes()).toHaveLength(1);
      for (const seeded of children) {
        expect(tui.pastes()[0]).toContain(`@thread:${seeded.child.id}`);
      }
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("holds later failures for 60 seconds, then delivers them together", async () => {
    const fixture = await createFixture();
    const { open, thread } = await openRunningClaudeParent(fixture);
    const tui = startFakeClaudeTui(
      fixture,
      open.terminalId,
      EMPTY_PROMPT_SCREEN,
    );
    try {
      const first = seedChild(fixture, thread.id, 1);
      await failChild(fixture, first);
      await waitFor(() => tui.pastes().length === 1, 8_000);
      const deliveredAt = Date.now();
      const later = [2, 3, 4].map((index) =>
        seedChild(fixture, thread.id, index),
      );
      for (const seeded of later) {
        await failChild(fixture, seeded);
        await sleep(2_600);
      }
      expect(tui.pastes()).toHaveLength(1);
      await waitFor(() => tui.pastes().length === 2, 75_000);
      expect(Date.now() - deliveredAt).toBeGreaterThanOrEqual(59_000);
      await sleep(2_000);
      expect(tui.pastes()).toHaveLength(2);
      const second = tui.pastes()[1] ?? "";
      for (const seeded of later) {
        expect(second).toContain(`@thread:${seeded.child.id}`);
      }
      expect(second).not.toContain(`@thread:${first.child.id}`);
    } finally {
      tui.stop();
    }
  }, 120_000);

  it("drops the notice without throwing when the parent's CLI is not running", async () => {
    const fixture = await createFixture();
    const parent = seedThread(fixture.harness.deps, {
      environmentId: fixture.environmentId,
      projectId: fixture.projectId,
      providerId: "claude-code",
      status: "idle",
    });
    createNativeTerminalThread(fixture.harness.db, {
      threadId: parent.id,
      providerId: "claude-code",
      nativeSessionId: "native-session",
      initialPrompt: null,
      initialImages: [],
      model: null,
    });
    const warn = vi.spyOn(fixture.harness.deps.logger, "warn");
    const seeded = seedChild(fixture, parent.id, 1);
    await failChild(fixture, seeded);
    try {
      await waitFor(
        () =>
          warn.mock.calls.some((call) =>
            String(call[1]).includes("native parent is not running"),
          ),
        8_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}; warn calls: ${JSON.stringify(warn.mock.calls.map((call) => `${String(call[1])} ${String((call[0] as { err?: unknown }).err)}`))}`,
      );
    }
    await sleep(500);
    expect(
      fixture.socket.sentMessages.filter((message) =>
        message.includes("terminal.input"),
      ),
    ).toEqual([]);
  }, 30_000);
});

describe("child notices survive a server restart", () => {
  function enqueueAsPreviousServer(
    fixture: Fixture,
    parentThreadId: string,
    text: string,
  ): void {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      enqueueNativeParentNotice(fixture.harness.deps, {
        input: [{ type: "text", text, mentions: [] }],
        parentThreadId,
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  }

  function runSweeps(fixture: Fixture): Promise<void> {
    return runPeriodicSweeps({
      ...fixture.harness.deps,
      pluginSchedules: fixture.harness.pluginService,
      plugins: fixture.harness.pluginService,
    });
  }

  async function restartServer(fixture: Fixture): Promise<Fixture> {
    const harness = await createTestAppHarness({ db: fixture.harness.db });
    harnesses.push(harness);
    const sentMessages: string[] = [];
    const socket: FakeDaemonSocket = {
      close: vi.fn(),
      send: vi.fn((data: string) => {
        sentMessages.push(data);
      }),
      sentMessages,
    };
    harness.hub.registerDaemon(fixture.sessionId, fixture.hostId, socket);
    return { ...fixture, harness, socket };
  }

  it("redelivers a notice queued before the restart exactly once", async () => {
    const before = await createFixture();
    const { open, thread } = await openRunningClaudeParent(before);
    enqueueAsPreviousServer(
      before,
      thread.id,
      "@thread:thr_child failed.\n\nError details:\n- @thread:thr_child: out of credit",
    );
    expect(listNativeParentNotices(before.harness.db, thread.id)).toHaveLength(
      1,
    );
    await sleep(300);
    expect(before.socket.sentMessages.join("")).not.toContain("terminal.input");

    const after = await restartServer(before);
    const tui = startFakeClaudeTui(after, open.terminalId, EMPTY_PROMPT_SCREEN);
    try {
      await runSweeps(after);
      await waitFor(() => tui.pastes().length > 0, 20_000);
      await runSweeps(after);
      await sleep(1_500);
      await runSweeps(after);
      await sleep(500);
      const [notice, ...rest] = tui.pastes();
      expect(rest).toEqual([]);
      expect(notice?.startsWith("[bb notice]")).toBe(true);
      expect(notice).toContain("out of credit");
      expect(notice).toMatch(NOTICE_TAIL);
      expect(tui.inputs().filter((input) => input === "\r")).toHaveLength(1);
      expect(listNativeParentNotices(after.harness.db, thread.id)).toEqual([]);
      expect(
        getNativeParentNoticeDeliveredAt(after.harness.db, thread.id),
      ).not.toBeNull();
      expect(before.socket.sentMessages.join("")).not.toContain(
        "terminal.input",
      );
    } finally {
      tui.stop();
    }
  }, 60_000);

  it("keeps a held notice across the restart until the parent is idle", async () => {
    const before = await createFixture();
    const { open, thread } = await openRunningClaudeParent(before);
    recordNativeTerminalActivity(before.harness.deps, {
      confirms: false,
      state: "working",
      threadId: thread.id,
    });
    enqueueAsPreviousServer(before, thread.id, "@thread:thr_child completed.");

    const after = await restartServer(before);
    const tui = startFakeClaudeTui(after, open.terminalId, EMPTY_PROMPT_SCREEN);
    try {
      await runSweeps(after);
      await sleep(4_500);
      expect(tui.inputs()).toEqual([]);
      expect(listNativeParentNotices(after.harness.db, thread.id)).toHaveLength(
        1,
      );
      recordNativeTerminalActivity(after.harness.deps, {
        confirms: false,
        state: "idle",
        threadId: thread.id,
      });
      await waitFor(() => tui.pastes().length > 0, 20_000);
      await sleep(1_000);
      expect(tui.pastes()).toHaveLength(1);
      expect(tui.pastes()[0]).toContain("@thread:thr_child completed.");
    } finally {
      tui.stop();
    }
  }, 60_000);

  it("drops notices of a parent that was archived while the server was down", async () => {
    const before = await createFixture();
    const { open, thread } = await openRunningClaudeParent(before);
    enqueueAsPreviousServer(before, thread.id, "@thread:thr_child failed.");
    before.harness.db.$client
      .prepare("UPDATE threads SET archived_at = ? WHERE id = ?")
      .run(Date.now(), thread.id);

    const after = await restartServer(before);
    const tui = startFakeClaudeTui(after, open.terminalId, EMPTY_PROMPT_SCREEN);
    try {
      await runSweeps(after);
      await waitFor(
        () => listNativeParentNotices(after.harness.db, thread.id).length === 0,
        10_000,
      );
      await sleep(500);
      expect(tui.inputs()).toEqual([]);
    } finally {
      tui.stop();
    }
  }, 30_000);
});
