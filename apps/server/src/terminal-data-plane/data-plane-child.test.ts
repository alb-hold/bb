import { Socket } from "node:net";
import type { TerminalSession } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TerminalDataPlaneChild,
  type TerminalDataPlaneSocket,
} from "./data-plane-child.js";
import {
  TERMINAL_DATA_PLANE_CHILD_PENDING_IPC_BYTES,
  TERMINAL_DATA_PLANE_INPUT_COALESCE_MS,
  TERMINAL_DATA_PLANE_IPC_VERSION,
  TERMINAL_DATA_PLANE_PENDING_REPLAY_BUFFER_BYTES,
  TERMINAL_DATA_PLANE_RELAY_HARD_CAP_BYTES,
  TERMINAL_DATA_PLANE_STATS_INTERVAL_MS,
  type TerminalDataPlaneChildMessage,
  type TerminalDataPlaneMainMessage,
} from "./ipc-contract.js";

const v = TERMINAL_DATA_PLANE_IPC_VERSION;

const session: TerminalSession = {
  id: "term_a",
  threadId: null,
  environmentId: null,
  hostId: "host_1",
  title: "shell",
  initialCwd: "/tmp",
  cols: 80,
  rows: 24,
  status: "running",
  exitCode: null,
  closeReason: null,
  createdAt: 1,
  updatedAt: 1,
  lastUserInputAt: null,
};

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function chunk(seq: number, text = `out-${seq}`) {
  return { seq, dataBase64: base64(text) };
}

class FakeSocket implements TerminalDataPlaneSocket {
  bufferedAmount = 0;
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> =
    [];
  readonly sent: string[] = [];
  terminated = false;
  private closeListeners: Array<() => void> = [];
  private messageListeners: Array<(data: unknown) => void> = [];

  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(
    event: "close" | "error" | "message",
    listener: (() => void) | ((error: Error) => void) | ((data: unknown) => void),
  ): unknown {
    if (event === "close") {
      this.closeListeners.push(listener as () => void);
    } else if (event === "message") {
      this.messageListeners.push(listener as (data: unknown) => void);
    }
    return this;
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  terminate(): void {
    this.terminated = true;
  }

  receive(message: unknown): void {
    const data = typeof message === "string" ? message : JSON.stringify(message);
    for (const listener of this.messageListeners) {
      listener(data);
    }
  }

  emitClose(): void {
    for (const listener of this.closeListeners) {
      listener();
    }
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((data) => JSON.parse(data) as Record<string, unknown>);
  }

  outputSeqs(): number[] {
    return this.frames()
      .filter((frame) => frame.type === "output")
      .map((frame) => (frame.chunk as { seq: number }).seq);
  }
}

interface Harness {
  child: TerminalDataPlaneChild;
  clock: { now: number };
  exits: number;
  failNextUpgrade: boolean;
  holdSends: boolean;
  releaseSends(): void;
  sockets: FakeSocket[];
  toMain: TerminalDataPlaneChildMessage[];
}

const harnesses: Harness[] = [];

function createHarness(): Harness {
  const held: Array<() => void> = [];
  const state: Omit<Harness, "child"> = {
    clock: { now: 1_000_000 },
    exits: 0,
    failNextUpgrade: false,
    holdSends: false,
    releaseSends: () => {
      for (const done of held.splice(0)) {
        done();
      }
    },
    sockets: [],
    toMain: [],
  };
  const child = new TerminalDataPlaneChild({
    exit: () => {
      state.exits += 1;
    },
    now: () => state.clock.now,
    rssBytes: () => 4096,
    sendToMain: (message, onSent) => {
      state.toMain.push(message);
      if (state.holdSends) {
        held.push(onSent);
      } else {
        onSent();
      }
    },
    upgrade: () => {
      if (state.failNextUpgrade) {
        state.failNextUpgrade = false;
        return Promise.reject(new Error("handshake refused"));
      }
      const socket = new FakeSocket();
      state.sockets.push(socket);
      return Promise.resolve(socket);
    },
  });
  const harness = Object.assign(state, { child });
  harnesses.push(harness);
  return harness;
}

function ofType<Type extends TerminalDataPlaneChildMessage["type"]>(
  harness: Harness,
  type: Type,
): Array<Extract<TerminalDataPlaneChildMessage, { type: Type }>> {
  return harness.toMain.filter(
    (message): message is Extract<TerminalDataPlaneChildMessage, { type: Type }> =>
      message.type === type,
  );
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
}

function main(harness: Harness, message: TerminalDataPlaneMainMessage): void {
  harness.child.handleMainMessage(message, undefined);
}

async function attachBrowser(
  harness: Harness,
  args: {
    attachId: string;
    daemonSessionId?: string;
    outputAcks?: boolean;
    terminalId: string;
    url?: string;
  },
): Promise<FakeSocket> {
  const before = harness.sockets.length;
  harness.child.handleMainMessage(
    {
      v,
      type: "browser.attach",
      attachId: args.attachId,
      terminalId: args.terminalId,
      daemonSessionId: args.daemonSessionId ?? "session_1",
      outputAcks: args.outputAcks ?? false,
      sinceSeq: 0,
      request: {
        url: args.url ?? `/ws/terminals/${args.terminalId}`,
        headers: [],
        headBase64: "",
      },
    },
    new Socket(),
  );
  await settle();
  const socket = harness.sockets[before];
  if (socket === undefined) {
    throw new Error("The upgrade did not produce a socket");
  }
  return socket;
}

function replay(
  harness: Harness,
  args: {
    attachId: string;
    chunks?: Array<{ seq: number; dataBase64: string }>;
    nextSeq: number;
    replayStartSeq?: number;
    terminalId: string;
  },
): void {
  main(harness, {
    v,
    type: "browser.replay",
    attachId: args.attachId,
    terminalId: args.terminalId,
    session: { ...session, id: args.terminalId },
    replayStartSeq: args.replayStartSeq ?? 0,
    chunks: args.chunks ?? [],
    nextSeq: args.nextSeq,
  });
}

async function attachLive(
  harness: Harness,
  args: Parameters<typeof attachBrowser>[1] & { nextSeq?: number },
): Promise<FakeSocket> {
  const socket = await attachBrowser(harness, args);
  replay(harness, {
    attachId: args.attachId,
    terminalId: args.terminalId,
    nextSeq: args.nextSeq ?? 0,
  });
  return socket;
}

async function attachDaemon(
  harness: Harness,
  daemonSessionId: string,
): Promise<FakeSocket> {
  const before = harness.sockets.length;
  harness.child.handleMainMessage(
    {
      v,
      type: "daemon.attach",
      daemonSessionId,
      request: { url: "/internal/terminal-data", headers: [], headBase64: "" },
    },
    new Socket(),
  );
  await settle();
  const socket = harness.sockets[before];
  if (socket === undefined) {
    throw new Error("The upgrade did not produce a socket");
  }
  return socket;
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.child.shutdown();
  }
  vi.useRealTimers();
});

describe("terminal data plane child", () => {
  it("keeps two terminals on one daemon session apart in both directions", async () => {
    const harness = createHarness();
    const a = await attachLive(harness, { attachId: "a1", terminalId: "term_a" });
    const b = await attachLive(harness, { attachId: "b1", terminalId: "term_b" });

    main(harness, { v, type: "terminal.output", terminalId: "term_a", chunk: chunk(0) });
    main(harness, { v, type: "terminal.output", terminalId: "term_b", chunk: chunk(0, "for-b") });
    a.receive({ type: "input", dataBase64: base64("typed-in-a") });

    expect(a.outputSeqs()).toEqual([0]);
    expect(a.sent.join("")).not.toContain(base64("for-b"));
    expect(b.sent.join("")).not.toContain(base64("out-0"));
    expect(ofType(harness, "terminal.input")).toEqual([
      { v, type: "terminal.input", terminalId: "term_a", dataBase64: base64("typed-in-a") },
    ]);
  });

  it("binds the socket to the terminal named by main when the URL names another", async () => {
    const harness = createHarness();
    const socket = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
      url: "/ws/terminals/term_b",
    });

    main(harness, { v, type: "terminal.output", terminalId: "term_b", chunk: chunk(0) });
    expect(socket.outputSeqs()).toEqual([]);

    main(harness, { v, type: "terminal.output", terminalId: "term_a", chunk: chunk(0) });
    socket.receive({ type: "input", dataBase64: base64("x") });

    expect(socket.outputSeqs()).toEqual([0]);
    expect(ofType(harness, "terminal.input").map((message) => message.terminalId)).toEqual([
      "term_a",
    ]);
  });

  it("accepts a browser socket only as an IPC handle", async () => {
    const harness = createHarness();

    main(harness, {
      v,
      type: "browser.attach",
      attachId: "a1",
      terminalId: "term_a",
      daemonSessionId: "session_1",
      outputAcks: false,
      sinceSeq: 0,
      request: { url: "/ws/terminals/term_a", headers: [], headBase64: "" },
    });
    await settle();

    expect(harness.sockets).toHaveLength(0);
    expect(harness.child.browserSocketCount).toBe(0);
    expect(ofType(harness, "browser.rejected")).toMatchObject([
      { attachId: "a1", code: "missing_socket" },
    ]);
  });

  it("destroys a handle that arrives with a message that takes none or is invalid", () => {
    const harness = createHarness();
    const stray = new Socket();
    const malformed = new Socket();
    const wrongDirection = new Socket();

    harness.child.handleMainMessage(
      { v, type: "terminal.unroute", terminalId: "term_a" },
      stray,
    );
    harness.child.handleMainMessage({ v, type: "browser.attach" }, malformed);
    harness.child.handleMainMessage({ v, type: "ready", pid: 1 }, wrongDirection);

    expect(stray.destroyed).toBe(true);
    expect(malformed.destroyed).toBe(true);
    expect(wrongDirection.destroyed).toBe(true);
    expect(harness.child.rejectedMainMessageCount).toBe(2);
    expect(harness.child.browserSocketCount).toBe(0);
  });

  it("reports a failed upgrade and destroys the socket", async () => {
    const harness = createHarness();
    harness.failNextUpgrade = true;
    const handle = new Socket();

    harness.child.handleMainMessage(
      {
        v,
        type: "browser.attach",
        attachId: "a1",
        terminalId: "term_a",
        daemonSessionId: "session_1",
        outputAcks: false,
        sinceSeq: 0,
        request: { url: "/ws/terminals/term_a", headers: [], headBase64: "" },
      },
      handle,
    );
    await settle();

    expect(handle.destroyed).toBe(true);
    expect(ofType(harness, "browser.rejected")).toMatchObject([
      { attachId: "a1", code: "upgrade_failed", message: "handshake refused" },
    ]);
    expect(ofType(harness, "browser.attached")).toEqual([]);
  });

  it("terminates a socket whose attach was closed while the upgrade was running", async () => {
    const harness = createHarness();

    harness.child.handleMainMessage(
      {
        v,
        type: "browser.attach",
        attachId: "a1",
        terminalId: "term_a",
        daemonSessionId: "session_1",
        outputAcks: false,
        sinceSeq: 0,
        request: { url: "/ws/terminals/term_a", headers: [], headBase64: "" },
      },
      new Socket(),
    );
    main(harness, {
      v,
      type: "browser.close",
      target: { kind: "terminal", terminalId: "term_a" },
      code: 1000,
      reason: "terminal-closed",
    });
    await settle();

    expect(harness.sockets[0]?.terminated).toBe(true);
    expect(ofType(harness, "browser.attached")).toEqual([]);
    expect(ofType(harness, "browser.rejected")).toMatchObject([
      { attachId: "a1", code: "closed_before_attach" },
    ]);
  });

  it("writes the attached frame and the replay before live output that arrived first", async () => {
    const harness = createHarness();
    const socket = await attachBrowser(harness, { attachId: "a1", terminalId: "term_a" });

    main(harness, { v, type: "terminal.output", terminalId: "term_a", chunk: chunk(2) });
    main(harness, { v, type: "terminal.output", terminalId: "term_a", chunk: chunk(3) });
    expect(socket.sent).toEqual([]);

    replay(harness, {
      attachId: "a1",
      terminalId: "term_a",
      chunks: [chunk(0), chunk(1), chunk(2)],
      nextSeq: 3,
    });
    main(harness, { v, type: "terminal.output", terminalId: "term_a", chunk: chunk(4) });

    expect(socket.frames()[0]).toMatchObject({
      type: "attached",
      replayStartSeq: 0,
      nextSeq: 3,
    });
    expect(socket.outputSeqs()).toEqual([0, 1, 2, 3, 4]);
    expect(ofType(harness, "browser.resync")).toEqual([]);
  });

  it("never writes a chunk below the socket's next sequence", async () => {
    const harness = createHarness();
    const socket = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
      nextSeq: 5,
    });

    for (const seq of [3, 4, 5, 5, 6, 4, 6, 7]) {
      main(harness, { v, type: "terminal.output", terminalId: "term_a", chunk: chunk(seq) });
    }

    expect(socket.outputSeqs()).toEqual([5, 6, 7]);
  });

  it("asks main for a resync once on a gap and resumes without loss or duplicate", async () => {
    const harness = createHarness();
    const socket = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
      nextSeq: 2,
    });

    main(harness, { v, type: "terminal.output", terminalId: "term_a", chunk: chunk(2) });
    main(harness, { v, type: "terminal.output", terminalId: "term_a", chunk: chunk(5) });
    main(harness, { v, type: "terminal.output", terminalId: "term_a", chunk: chunk(6) });

    expect(socket.outputSeqs()).toEqual([2]);
    expect(ofType(harness, "browser.resync")).toEqual([
      { v, type: "browser.resync", attachId: "a1", terminalId: "term_a", fromSeq: 3 },
    ]);

    replay(harness, {
      attachId: "a1",
      terminalId: "term_a",
      replayStartSeq: 1,
      chunks: [chunk(1), chunk(2), chunk(3), chunk(4), chunk(5)],
      nextSeq: 6,
    });
    main(harness, { v, type: "terminal.output", terminalId: "term_a", chunk: chunk(7) });

    expect(socket.outputSeqs()).toEqual([2, 3, 4, 5, 6, 7]);
    expect(socket.frames().filter((frame) => frame.type === "attached")).toHaveLength(1);
    expect(ofType(harness, "browser.resync")).toHaveLength(1);
  });

  it("closes the socket when a resync replay cannot cover the gap", async () => {
    const harness = createHarness();
    const socket = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
      nextSeq: 2,
    });

    main(harness, { v, type: "terminal.output", terminalId: "term_a", chunk: chunk(9) });
    replay(harness, {
      attachId: "a1",
      terminalId: "term_a",
      replayStartSeq: 6,
      chunks: [chunk(6), chunk(7), chunk(8)],
      nextSeq: 9,
    });

    expect(socket.outputSeqs()).toEqual([]);
    expect(socket.closes).toEqual([{ code: 1013, reason: "replay-gap" }]);
    expect(ofType(harness, "browser.detached")).toMatchObject([{ attachId: "a1" }]);
  });

  it("closes a socket whose pending replay buffer passes the cap", async () => {
    const harness = createHarness();
    const socket = await attachBrowser(harness, { attachId: "a1", terminalId: "term_a" });
    const large = "A".repeat(64 * 1024);
    const needed = Math.ceil(TERMINAL_DATA_PLANE_PENDING_REPLAY_BUFFER_BYTES / large.length) + 1;

    for (let seq = 0; seq < needed; seq += 1) {
      main(harness, {
        v,
        type: "terminal.output",
        terminalId: "term_a",
        chunk: { seq, dataBase64: large },
      });
    }

    expect(socket.sent).toEqual([]);
    expect(socket.closes).toEqual([{ code: 1013, reason: "replay-buffer-overflow" }]);
    expect(ofType(harness, "browser.detached")).toEqual([
      { v, type: "browser.detached", attachId: "a1", terminalId: "term_a", lastAckedSeq: null },
    ]);
    expect(harness.child.browserSocketCount).toBe(0);
  });

  it("closes a browser socket whose send backlog passes the hard cap", async () => {
    const harness = createHarness();
    const socket = await attachLive(harness, { attachId: "a1", terminalId: "term_a" });
    socket.bufferedAmount = TERMINAL_DATA_PLANE_RELAY_HARD_CAP_BYTES + 1;

    main(harness, { v, type: "terminal.output", terminalId: "term_a", chunk: chunk(0) });
    main(harness, { v, type: "terminal.output", terminalId: "term_a", chunk: chunk(1) });

    expect(socket.outputSeqs()).toEqual([0]);
    expect(socket.closes).toEqual([{ code: 1013, reason: "browser-backlog" }]);
  });

  it("holds control frames until the attached frame has been written", async () => {
    const harness = createHarness();
    const socket = await attachBrowser(harness, { attachId: "a1", terminalId: "term_a" });

    main(harness, {
      v,
      type: "browser.send",
      terminalId: "term_a",
      message: { type: "session-updated", session },
    });
    expect(socket.sent).toEqual([]);

    replay(harness, { attachId: "a1", terminalId: "term_a", nextSeq: 0 });
    main(harness, {
      v,
      type: "browser.send",
      terminalId: "term_a",
      message: { type: "error", code: "terminal_error", message: "boom" },
    });

    expect(socket.frames().map((frame) => frame.type)).toEqual([
      "attached",
      "session-updated",
      "error",
    ]);
  });

  it("answers ping itself and passes resize, ack and visibility to main", async () => {
    const harness = createHarness();
    const socket = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
      outputAcks: true,
    });
    harness.toMain.length = 0;

    socket.receive({ type: "ping" });
    socket.receive({ type: "resize", cols: 120, rows: 40 });
    socket.receive({ type: "ack", nextSeq: 7 });
    socket.receive({ type: "visibility", visible: false });
    socket.emitClose();

    expect(socket.frames().at(-1)).toEqual({ type: "pong" });
    expect(harness.toMain).toEqual([
      {
        v,
        type: "browser.control",
        attachId: "a1",
        terminalId: "term_a",
        message: { type: "resize", cols: 120, rows: 40 },
      },
      { v, type: "terminal.ack", attachId: "a1", terminalId: "term_a", nextSeq: 7 },
      { v, type: "terminal.visibility", attachId: "a1", terminalId: "term_a", visible: false },
      { v, type: "browser.detached", attachId: "a1", terminalId: "term_a", lastAckedSeq: 6 },
    ]);
  });

  it("closes a socket that sends a frame outside the browser protocol", async () => {
    const harness = createHarness();
    const socket = await attachLive(harness, { attachId: "a1", terminalId: "term_a" });

    socket.receive({ type: "input", dataBase64: "not base64!" });
    socket.receive({ type: "input", dataBase64: base64("after-close") });

    expect(socket.closes).toEqual([{ code: 1008, reason: "invalid-message" }]);
    expect(ofType(harness, "terminal.input")).toEqual([]);
    expect(ofType(harness, "browser.detached")).toHaveLength(1);
  });

  it("sends the first keystroke at once and coalesces the burst behind it", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const socket = await attachLive(harness, { attachId: "a1", terminalId: "term_a" });

    for (const key of ["a", "b", "c", "d"]) {
      socket.receive({ type: "input", dataBase64: base64(key) });
    }
    expect(ofType(harness, "terminal.input").map((message) => message.dataBase64)).toEqual([
      base64("a"),
    ]);

    vi.advanceTimersByTime(TERMINAL_DATA_PLANE_INPUT_COALESCE_MS);
    expect(ofType(harness, "terminal.input").map((message) => message.dataBase64)).toEqual([
      base64("a"),
      base64("bcd"),
    ]);

    vi.advanceTimersByTime(TERMINAL_DATA_PLANE_INPUT_COALESCE_MS * 2);
    socket.receive({ type: "input", dataBase64: base64("e") });
    expect(ofType(harness, "terminal.input").map((message) => message.dataBase64)).toEqual([
      base64("a"),
      base64("bcd"),
      base64("e"),
    ]);
  });

  it("reports input activity at most once a second per terminal", async () => {
    const harness = createHarness();
    const socket = await attachLive(harness, { attachId: "a1", terminalId: "term_a" });

    socket.receive({ type: "input", dataBase64: base64("a") });
    harness.clock.now += 999;
    socket.receive({ type: "input", dataBase64: base64("b") });
    harness.clock.now += 1;
    socket.receive({ type: "input", dataBase64: base64("c") });

    expect(ofType(harness, "terminal.input-activity").map((message) => message.at)).toEqual([
      1_000_000,
      1_001_000,
    ]);
  });

  it("closes the terminal's sockets when input waiting for main passes the cap", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const socket = await attachLive(harness, { attachId: "a1", terminalId: "term_a" });
    const other = await attachLive(harness, { attachId: "b1", terminalId: "term_b" });
    harness.holdSends = true;
    const block = Buffer.alloc(48 * 1024, 0x61).toString("base64");
    const blocks = Math.ceil(TERMINAL_DATA_PLANE_CHILD_PENDING_IPC_BYTES / block.length) + 2;

    for (let index = 0; index < blocks; index += 1) {
      socket.receive({ type: "input", dataBase64: block });
      vi.advanceTimersByTime(TERMINAL_DATA_PLANE_INPUT_COALESCE_MS);
    }

    expect(socket.closes).toEqual([{ code: 1013, reason: "input-backlog" }]);
    expect(other.closes).toEqual([]);
    const relayed = ofType(harness, "terminal.input").reduce(
      (total, message) => total + message.dataBase64.length,
      0,
    );
    expect(relayed).toBeLessThanOrEqual(TERMINAL_DATA_PLANE_CHILD_PENDING_IPC_BYTES);

    harness.releaseSends();
    harness.holdSends = false;
    other.receive({ type: "input", dataBase64: base64("still-works") });
    expect(ofType(harness, "terminal.input").at(-1)).toMatchObject({
      terminalId: "term_b",
      dataBase64: base64("still-works"),
    });
  });

  it("carries a data-socket terminal without sending its bytes through main", async () => {
    const harness = createHarness();
    const daemon = await attachDaemon(harness, "session_1");
    main(harness, {
      v,
      type: "terminal.route",
      terminalId: "term_a",
      daemonSessionId: "session_1",
      mode: "data-socket",
    });
    const browser = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
      outputAcks: true,
    });
    harness.toMain.length = 0;

    daemon.receive({ type: "terminal.output", terminalId: "term_a", chunk: chunk(0) });
    daemon.receive({ type: "terminal.output", terminalId: "term_a", chunk: chunk(1) });
    browser.receive({ type: "input", dataBase64: base64("ls\n") });
    browser.receive({ type: "ack", nextSeq: 2 });

    expect(browser.outputSeqs()).toEqual([0, 1]);
    expect(daemon.frames()).toEqual([
      { type: "terminal.flow-control", terminalId: "term_a", enabled: true },
      { type: "terminal.input", terminalId: "term_a", dataBase64: base64("ls\n") },
      { type: "terminal.ack", terminalId: "term_a", nextSeq: 2 },
    ]);
    expect(harness.toMain.map((message) => message.type)).toEqual([
      "terminal.input-activity",
    ]);
  });

  it("drops and counts a data-socket frame for a terminal routed elsewhere", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.child.start();
    const owner = await attachDaemon(harness, "session_1");
    const intruder = await attachDaemon(harness, "session_2");
    main(harness, {
      v,
      type: "terminal.route",
      terminalId: "term_a",
      daemonSessionId: "session_1",
      mode: "data-socket",
    });
    main(harness, {
      v,
      type: "terminal.route",
      terminalId: "term_relay",
      daemonSessionId: "session_2",
      mode: "main-relay",
    });
    const browser = await attachLive(harness, { attachId: "a1", terminalId: "term_a" });
    const relayBrowser = await attachLive(harness, {
      attachId: "r1",
      terminalId: "term_relay",
      daemonSessionId: "session_2",
    });

    intruder.receive({ type: "terminal.output", terminalId: "term_a", chunk: chunk(0, "forged") });
    intruder.receive({ type: "terminal.output", terminalId: "term_relay", chunk: chunk(0, "forged") });
    intruder.receive({ type: "terminal.output", terminalId: "term_unknown", chunk: chunk(0) });
    owner.receive({ type: "terminal.output", terminalId: "term_a", chunk: chunk(0, "real") });

    expect(browser.frames().filter((frame) => frame.type === "output")).toEqual([
      { type: "output", chunk: chunk(0, "real") },
    ]);
    expect(relayBrowser.outputSeqs()).toEqual([]);

    vi.advanceTimersByTime(TERMINAL_DATA_PLANE_STATS_INTERVAL_MS);
    expect(ofType(harness, "stats")).toEqual([
      {
        v,
        type: "stats",
        rssBytes: 4096,
        browserSockets: 2,
        daemonSockets: 2,
        droppedMisroutedFrames: 3,
      },
    ]);
    harness.child.shutdown();
  });

  it("sends input through main when the browser was bound to another daemon session", async () => {
    const harness = createHarness();
    const daemon = await attachDaemon(harness, "session_2");
    main(harness, {
      v,
      type: "terminal.route",
      terminalId: "term_a",
      daemonSessionId: "session_2",
      mode: "data-socket",
    });
    const browser = await attachLive(harness, {
      attachId: "a1",
      terminalId: "term_a",
      daemonSessionId: "session_1",
    });

    browser.receive({ type: "input", dataBase64: base64("x") });

    expect(daemon.frames()).toEqual([]);
    expect(ofType(harness, "terminal.input")).toMatchObject([{ terminalId: "term_a" }]);
  });

  it("reports a dropped data socket and falls back to main for input", async () => {
    const harness = createHarness();
    const daemon = await attachDaemon(harness, "session_1");
    main(harness, {
      v,
      type: "terminal.route",
      terminalId: "term_a",
      daemonSessionId: "session_1",
      mode: "data-socket",
    });
    const browser = await attachLive(harness, { attachId: "a1", terminalId: "term_a" });
    expect(ofType(harness, "daemon.attached")).toEqual([
      { v, type: "daemon.attached", daemonSessionId: "session_1" },
    ]);

    daemon.emitClose();
    browser.receive({ type: "input", dataBase64: base64("x") });

    expect(ofType(harness, "daemon.detached")).toEqual([
      { v, type: "daemon.detached", daemonSessionId: "session_1" },
    ]);
    expect(harness.child.daemonSocketCount).toBe(0);
    expect(ofType(harness, "terminal.input")).toMatchObject([{ terminalId: "term_a" }]);
  });

  it("drops a session's routes and closes its data socket on daemon.detach", async () => {
    const harness = createHarness();
    const daemon = await attachDaemon(harness, "session_1");
    main(harness, {
      v,
      type: "terminal.route",
      terminalId: "term_a",
      daemonSessionId: "session_1",
      mode: "data-socket",
    });
    const browser = await attachLive(harness, { attachId: "a1", terminalId: "term_a" });

    main(harness, { v, type: "daemon.detach", daemonSessionId: "session_1" });
    daemon.receive({ type: "terminal.output", terminalId: "term_a", chunk: chunk(0) });

    expect(daemon.closes).toEqual([{ code: 1000, reason: "daemon-detached" }]);
    expect(browser.outputSeqs()).toEqual([]);
    expect(harness.child.daemonSocketCount).toBe(0);
  });

  it("closes sockets on browser.close and terminal.resync and reports each once", async () => {
    const harness = createHarness();
    const first = await attachLive(harness, { attachId: "a1", terminalId: "term_a" });
    const second = await attachLive(harness, { attachId: "a2", terminalId: "term_a" });
    const third = await attachLive(harness, { attachId: "b1", terminalId: "term_b" });

    main(harness, {
      v,
      type: "browser.close",
      target: { kind: "attach", attachId: "a1" },
      code: 1000,
      reason: "done",
    });
    first.emitClose();
    main(harness, { v, type: "terminal.resync", terminalId: "term_a" });
    main(harness, { v, type: "terminal.output", terminalId: "term_a", chunk: chunk(0) });

    expect(first.closes).toEqual([{ code: 1000, reason: "done" }]);
    expect(second.closes).toEqual([{ code: 1013, reason: "terminal-resync" }]);
    expect(third.closes).toEqual([]);
    expect(second.outputSeqs()).toEqual([]);
    expect(ofType(harness, "browser.detached").map((message) => message.attachId)).toEqual([
      "a1",
      "a2",
    ]);
    expect(harness.child.browserSocketCount).toBe(1);
  });

  it("terminates every socket and exits on shutdown", async () => {
    const harness = createHarness();
    harness.child.start();
    const browser = await attachLive(harness, { attachId: "a1", terminalId: "term_a" });
    const daemon = await attachDaemon(harness, "session_1");
    const late = new Socket();

    main(harness, { v, type: "shutdown" });
    harness.child.handleMainMessage(
      {
        v,
        type: "browser.attach",
        attachId: "late",
        terminalId: "term_a",
        daemonSessionId: "session_1",
        outputAcks: false,
        sinceSeq: 0,
        request: { url: "/ws/terminals/term_a", headers: [], headBase64: "" },
      },
      late,
    );
    harness.child.shutdown();

    expect(browser.terminated).toBe(true);
    expect(daemon.terminated).toBe(true);
    expect(late.destroyed).toBe(true);
    expect(harness.exits).toBe(1);
    expect(harness.child.browserSocketCount).toBe(0);
    expect(harness.child.daemonSocketCount).toBe(0);
  });
});
