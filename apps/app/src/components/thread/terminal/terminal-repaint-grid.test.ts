import {
  TerminalWebSocketTransport,
  type TerminalBrowserSocket,
} from "@bb/client-core";
import type {
  TerminalServerMessage,
  TerminalSession,
} from "@bb/server-contract";
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalResizeCoalescer } from "./terminal-resize-coalescer";
import {
  applyTerminalFitDimensions,
  nextSharedTerminalSize,
  terminalDisplaySize,
} from "./terminal-shared-size";

const FITTED_COLS = 40;
const FITTED_ROWS = 12;
const FOOTER_STATUS = "11 warnings";
const FOOTER_LABEL = "model x";

function session(cols: number, rows: number): TerminalSession {
  return {
    id: "term_1",
    threadId: "thr_1",
    environmentId: "env_1",
    hostId: "host_1",
    title: "Terminal",
    initialCwd: "/workspace",
    cols,
    rows,
    status: "running",
    exitCode: null,
    closeReason: null,
    createdAt: 1,
    updatedAt: 1,
    lastUserInputAt: null,
  };
}

class InlineTuiPty {
  private drawnRows = 0;
  private nextSeq = 0;
  private width = FITTED_COLS;

  constructor(
    private readonly deliver: (message: TerminalServerMessage) => void,
    private readonly echoAfterDraw = false,
  ) {}

  resize(cols: number, rows: number): void {
    this.width = cols;
    if (this.echoAfterDraw) {
      this.draw();
      this.deliver({ type: "session-updated", session: session(cols, rows) });
      return;
    }
    this.deliver({ type: "session-updated", session: session(cols, rows) });
    this.draw();
  }

  draw(): void {
    this.deliver({
      type: "output",
      chunk: {
        seq: this.nextSeq,
        dataBase64: Buffer.from(this.frame(), "utf8").toString("base64"),
      },
    });
    this.nextSeq += 1;
  }

  private frame(): string {
    const padding = " ".repeat(
      this.width - FOOTER_LABEL.length - FOOTER_STATUS.length,
    );
    const lines = [
      "> Ask me anything",
      "",
      `${FOOTER_LABEL}${padding}${FOOTER_STATUS}`,
    ];
    const up = this.drawnRows > 1 ? `\u001b[${this.drawnRows - 1}A` : "";
    this.drawnRows = lines.length;
    return `${up}\r\u001b[J${lines.join("\r\n")}`;
  }
}

class FakeSocket implements TerminalBrowserSocket {
  onclose: ((event: CloseEvent) => void) | null = null;
  onDisposed: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readyState = 1;
  readonly resizes: Array<{ cols: number; rows: number; seq?: number }> = [];

  close(): void {
    this.readyState = 3;
    this.onDisposed?.();
  }

  send(data: string): void {
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "type" in parsed &&
      parsed.type === "resize" &&
      "cols" in parsed &&
      typeof parsed.cols === "number" &&
      "rows" in parsed &&
      typeof parsed.rows === "number"
    ) {
      this.resizes.push({
        cols: parsed.cols,
        rows: parsed.rows,
        ...("seq" in parsed && typeof parsed.seq === "number"
          ? { seq: parsed.seq }
          : {}),
      });
    }
  }
}

function newTerminal(): Terminal {
  return new Terminal({
    allowProposedApi: true,
    cols: FITTED_COLS,
    rows: FITTED_ROWS,
  });
}

function screenText(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("|").replace(/\|+$/u, "");
}

function writeAndWait(terminal: Terminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => terminal.write(data, resolve));
}

function decodeChunk(message: TerminalServerMessage): string | null {
  return message.type === "output"
    ? Buffer.from(message.chunk.dataBase64, "base64").toString("utf8")
    : null;
}

async function cleanReferenceScreen(): Promise<string> {
  const terminal = newTerminal();
  const reference = new InlineTuiPty((message) => {
    const data = decodeChunk(message);
    if (data !== null) {
      terminal.write(data);
    }
  });
  reference.draw();
  await writeAndWait(terminal, "");
  return screenText(terminal);
}

describe("replay repaint nudge", () => {
  it("leaves a full-width inline TUI exactly as a clean draw after the return nudge", async () => {
    const terminal = newTerminal();
    const pty = new InlineTuiPty((message) => {
      if (message.type === "session-updated") {
        const display = terminalDisplaySize(
          { cols: FITTED_COLS, rows: FITTED_ROWS },
          { cols: message.session.cols, rows: message.session.rows },
        );
        terminal.resize(display.cols, display.rows);
      }
      const data = decodeChunk(message);
      if (data !== null) {
        terminal.write(data);
      }
    });
    const socket = new FakeSocket();
    const transport = new TerminalWebSocketTransport({
      createSocket: () => socket,
      onMessage: () => undefined,
      shouldReconnect: () => false,
      url: "ws://example.test/ws/terminals/term_1",
    });
    transport.sendResize(FITTED_COLS, FITTED_ROWS);
    transport.start();
    socket.onopen?.(new Event("open"));
    transport.markLayoutSettled();

    pty.draw();
    transport.requestRepaint();
    let applied = 0;
    for (let step = 0; step < 10; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, 70));
      for (const resize of socket.resizes.slice(applied)) {
        pty.resize(resize.cols, resize.rows);
      }
      applied = socket.resizes.length;
    }
    await writeAndWait(terminal, "");

    expect(socket.resizes.at(-1)).toEqual({
      cols: FITTED_COLS,
      rows: FITTED_ROWS,
    });
    expect(screenText(terminal)).toBe(await cleanReferenceScreen());
    transport.dispose();
  });
});

interface ViewHarness {
  applySizes: () => Promise<void>;
  pty: InlineTuiPty;
  socket: FakeSocket;
  terminal: Terminal;
  transport: TerminalWebSocketTransport;
  widths: number[];
}

function createViewHarness(): ViewHarness {
  const terminal = newTerminal();
  const widths: number[] = [];
  terminal.onResize(({ cols }) => widths.push(cols));
  let sharedSize: { cols: number; rows: number } | null = null;
  const socket = new FakeSocket();
  const applyShared = (size: { cols: number; rows: number }): void => {
    const next = nextSharedTerminalSize(sharedSize, size, false);
    if (next === null) {
      return;
    }
    sharedSize = next;
    const display = terminalDisplaySize(
      { cols: FITTED_COLS, rows: FITTED_ROWS },
      sharedSize,
    );
    terminal.resize(display.cols, display.rows);
  };
  const transport = new TerminalWebSocketTransport({
    createSocket: () => socket,
    onMessage: () => undefined,
    onRepaintNudgeSizeReleased: applyShared,
    shouldReconnect: () => false,
    url: "ws://example.test/ws/terminals/term_1",
  });
  const pty = new InlineTuiPty((message) => {
    if (message.type === "session-updated") {
      const reported = {
        cols: message.session.cols,
        rows: message.session.rows,
      };
      const next = nextSharedTerminalSize(
        sharedSize,
        reported,
        transport.consumeRepaintNudgeEcho(reported),
      );
      if (next !== null) {
        sharedSize = next;
        const display = terminalDisplaySize(
          { cols: FITTED_COLS, rows: FITTED_ROWS },
          sharedSize,
        );
        terminal.resize(display.cols, display.rows);
      }
    }
    const data = decodeChunk(message);
    if (data !== null) {
      terminal.write(data);
    }
  }, true);
  transport.sendResize(FITTED_COLS, FITTED_ROWS);
  transport.start();
  socket.onopen?.(new Event("open"));
  socket.onmessage?.(
    new MessageEvent("message", {
      data: JSON.stringify({ type: "features", resizeAcks: true }),
    }),
  );
  transport.markLayoutSettled();
  let applied = socket.resizes.length;
  const applySizes = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const resize of socket.resizes.slice(applied)) {
      pty.resize(resize.cols, resize.rows);
      if (resize.seq !== undefined) {
        socket.onmessage?.(
          new MessageEvent("message", {
            data: JSON.stringify({ type: "resize-applied", seq: resize.seq }),
          }),
        );
      }
    }
    applied = socket.resizes.length;
  };
  return { applySizes, pty, socket, terminal, transport, widths };
}

describe("page terminal during the repaint nudge", () => {
  it("never narrows the page's own terminal for the echo of its nudge and ends at the real size with a clean screen", async () => {
    const { applySizes, pty, socket, terminal, transport, widths } =
      createViewHarness();

    pty.draw();
    transport.requestRepaint();
    for (let step = 0; step < 70; step += 1) {
      await applySizes();
    }
    await writeAndWait(terminal, "");

    expect(socket.resizes.map((resize) => resize.cols)).toEqual([
      FITTED_COLS,
      FITTED_COLS - 1,
      FITTED_COLS,
    ]);
    expect(widths.filter((cols) => cols < FITTED_COLS)).toEqual([]);
    expect(terminal.cols).toBe(FITTED_COLS);
    expect(screenText(terminal)).toBe(await cleanReferenceScreen());
    transport.dispose();
  });

  it("still follows a smaller size another client chose during the nudge window", async () => {
    const { applySizes, pty, terminal, transport } = createViewHarness();

    pty.draw();
    transport.requestRepaint();
    await applySizes();
    pty.resize(30, FITTED_ROWS);
    await writeAndWait(terminal, "");

    expect(terminal.cols).toBe(30);
    transport.dispose();
  });
});

describe("font zoom across terminal clients", () => {
  it("reflows both clients to the minimum shared columns and rows", () => {
    const clients = [newTerminal(), newTerminal()];
    const fitted = [
      { cols: 132, rows: 46 },
      { cols: 100, rows: 24 },
    ];
    let sharedSize: { cols: number; rows: number } | null = null;
    let ptySize = { ...fitted[1] };
    const reflow = (): void => {
      for (let index = 0; index < clients.length; index += 1) {
        const display = terminalDisplaySize(fitted[index], sharedSize);
        clients[index].resize(display.cols, display.rows);
      }
    };
    const reportZoomedClient = (): void => {
      const aggregatedSize = fitted.reduce(
        (minimum, clientSize) => ({
          cols: Math.min(minimum.cols, clientSize.cols),
          rows: Math.min(minimum.rows, clientSize.rows),
        }),
        { cols: Number.POSITIVE_INFINITY, rows: Number.POSITIVE_INFINITY },
      );
      const nextSize = nextSharedTerminalSize(
        sharedSize,
        aggregatedSize,
        false,
      );
      if (nextSize === null) return;
      sharedSize = nextSize;
      ptySize = nextSize;
      reflow();
    };

    fitted[0] = { cols: 72, rows: 30 };
    reportZoomedClient();

    expect(ptySize).toEqual({ cols: 72, rows: 24 });
    expect(clients.map(({ cols, rows }) => ({ cols, rows }))).toEqual([
      { cols: 72, rows: 24 },
      { cols: 72, rows: 24 },
    ]);
  });
});

interface FitChangeRoom {
  advance: (ms: number) => void;
  deliverReports: () => void;
  fit: (cols: number) => void;
  hiddenFit: (cols: number) => void;
  peer: (cols: number) => void;
  ptyCols: () => number;
  resizeCount: () => number;
  resizeCountFor: (cols: number) => number;
  terminal: Terminal;
  transport: TerminalWebSocketTransport;
  widths: number[];
}

function createFitChangeRoom(delayReports = false): FitChangeRoom {
  vi.useFakeTimers();
  const terminal = newTerminal();
  const widths: number[] = [];
  terminal.onResize(({ cols }) => widths.push(cols));
  let fitted = FITTED_COLS;
  let own: number | null = FITTED_COLS;
  let peerCols: number | null = null;
  let pty = FITTED_COLS;
  let sharedSize: { cols: number; rows: number } | null = null;
  const socket = new FakeSocket();

  const show = (): void => {
    const display = terminalDisplaySize(
      { cols: fitted, rows: FITTED_ROWS },
      sharedSize,
    );
    terminal.resize(display.cols, display.rows);
  };
  const applyShared = (size: { cols: number; rows: number }): void => {
    const next = nextSharedTerminalSize(sharedSize, size, false);
    if (next === null) {
      return;
    }
    sharedSize = next;
    show();
  };
  const transport = new TerminalWebSocketTransport({
    createSocket: () => socket,
    onMessage: (message) => {
      if (message.type !== "session-updated") {
        return;
      }
      const reported = {
        cols: message.session.cols,
        rows: message.session.rows,
      };
      const next = nextSharedTerminalSize(
        sharedSize,
        reported,
        transport.consumeRepaintNudgeEcho(reported),
      );
      if (next !== null) {
        applyShared(next);
      }
    },
    onRepaintNudgeSizeReleased: applyShared,
    shouldReconnect: () => false,
    url: "ws://example.test/ws/terminals/term_1",
  });
  let delivered = 0;
  let delayed = delayReports;
  const queued: unknown[] = [];
  const deliver = (message: unknown): void => {
    socket.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  };
  const emit = (message: unknown): void => {
    if (delayed) {
      queued.push(message);
      return;
    }
    deliver(message);
  };
  const hub = (): void => {
    const shared =
      own === null
        ? peerCols
        : peerCols === null
          ? own
          : Math.min(own, peerCols);
    if (shared !== null && shared !== pty) {
      pty = shared;
      emit({ type: "session-updated", session: session(shared, FITTED_ROWS) });
    }
  };
  socket.onDisposed = () => {
    own = null;
    hub();
  };
  const syncOwn = (): void => {
    for (const resize of socket.resizes.slice(delivered)) {
      own = resize.cols;
      hub();
      if (resize.seq !== undefined) {
        emit({ type: "resize-applied", seq: resize.seq });
      }
    }
    delivered = socket.resizes.length;
  };
  const applyFit = (cols: number, visible: boolean): void => {
    fitted = cols;
    applyTerminalFitDimensions(
      { cols, rows: FITTED_ROWS },
      sharedSize,
      visible,
      (displayCols, displayRows) => terminal.resize(displayCols, displayRows),
      (nextCols, nextRows) => transport.sendResize(nextCols, nextRows),
    );
    syncOwn();
  };
  transport.sendResize(FITTED_COLS, FITTED_ROWS);
  transport.start();
  socket.onopen?.(new Event("open"));
  deliver({ type: "features", resizeAcks: true });
  transport.markLayoutSettled();
  syncOwn();
  transport.requestRepaint();
  vi.advanceTimersByTime(0);
  syncOwn();
  return {
    advance: (ms) => {
      vi.advanceTimersByTime(ms);
      syncOwn();
    },
    deliverReports: () => {
      delayed = false;
      for (const message of queued.splice(0)) {
        deliver(message);
      }
    },
    fit: (cols) => applyFit(cols, true),
    hiddenFit: (cols) => applyFit(cols, false),
    peer: (cols) => {
      peerCols = cols;
      hub();
    },
    ptyCols: () => pty,
    resizeCount: () => socket.resizes.length,
    resizeCountFor: (cols) =>
      socket.resizes.filter((resize) => resize.cols === cols).length,
    terminal,
    transport,
    widths,
  };
}

describe("page terminal when the fitted size changes between nudge and restore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never takes the nudge size when the fit grows past a smaller peer, and ends at the peer's size", () => {
    const room = createFitChangeRoom();
    room.advance(100);
    room.fit(60);
    room.advance(100);
    room.peer(30);
    room.advance(2000);

    expect(room.widths).not.toContain(FITTED_COLS - 1);
    expect(room.ptyCols()).toBe(30);
    expect(room.terminal.cols).toBe(30);
    room.transport.dispose();
  });

  it("never takes the nudge size when the fit shrinks and a peer sits exactly at the nudge size", () => {
    const room = createFitChangeRoom();
    room.advance(100);
    room.peer(FITTED_COLS - 1);
    room.advance(100);
    room.fit(30);
    room.advance(2000);

    expect(room.widths).not.toContain(FITTED_COLS - 1);
    expect(room.ptyCols()).toBe(30);
    expect(room.terminal.cols).toBe(30);
    room.transport.dispose();
  });

  it("applies the peer's size once the exchange is acknowledged when the fit grows past a peer exactly at the nudge size", () => {
    const room = createFitChangeRoom();
    room.advance(100);
    room.peer(FITTED_COLS - 1);
    room.advance(100);
    room.fit(60);
    room.advance(2000);

    expect(room.ptyCols()).toBe(FITTED_COLS - 1);
    expect(room.terminal.cols).toBe(FITTED_COLS - 1);
    room.transport.dispose();
  });

  it("follows the fit with no peer and never takes the nudge size", () => {
    const room = createFitChangeRoom();
    room.advance(100);
    room.fit(30);
    room.advance(2000);

    expect(room.widths).not.toContain(FITTED_COLS - 1);
    expect(room.ptyCols()).toBe(30);
    expect(room.terminal.cols).toBe(30);
    room.transport.dispose();
  });

  it("never takes the nudge size when the fit changes before the nudge report is delivered", () => {
    const room = createFitChangeRoom(true);
    room.fit(60);
    room.advance(50);
    room.deliverReports();
    room.advance(2000);

    expect(room.widths).not.toContain(FITTED_COLS - 1);
    expect(room.ptyCols()).toBe(60);
    expect(room.terminal.cols).toBe(60);
    room.transport.dispose();
  });

  it("never takes the nudge size when the fit shrinks before the nudge report is delivered and a smaller peer resizes", () => {
    const room = createFitChangeRoom(true);
    room.fit(30);
    room.peer(20);
    room.advance(50);
    room.deliverReports();
    room.advance(2000);

    expect(room.widths).not.toContain(FITTED_COLS - 1);
    expect(room.ptyCols()).toBe(20);
    expect(room.terminal.cols).toBe(20);
    room.transport.dispose();
  });

  it("applies a peer exactly at the nudge size once acknowledged when the fit grows before the nudge report is delivered", () => {
    const room = createFitChangeRoom(true);
    room.peer(FITTED_COLS - 1);
    room.fit(60);
    room.advance(50);
    expect(room.widths).not.toContain(FITTED_COLS - 1);
    room.deliverReports();
    room.advance(2000);

    expect(room.ptyCols()).toBe(FITTED_COLS - 1);
    expect(room.terminal.cols).toBe(FITTED_COLS - 1);
    room.transport.dispose();
  });

  it("never takes a nudge report that is delivered 2 s late after the fit changed", () => {
    const room = createFitChangeRoom(true);
    room.fit(60);
    room.advance(2000);
    room.deliverReports();
    room.advance(2000);

    expect(room.widths).not.toContain(FITTED_COLS - 1);
    expect(room.ptyCols()).toBe(60);
    expect(room.terminal.cols).toBe(60);
    room.transport.dispose();
  });

  it("still applies a legitimate later peer at the same size as the nudge", () => {
    const room = createFitChangeRoom(true);
    room.fit(60);
    room.advance(2000);
    room.deliverReports();
    room.advance(2000);
    expect(room.widths).not.toContain(FITTED_COLS - 1);
    room.peer(FITTED_COLS - 1);

    expect(room.ptyCols()).toBe(FITTED_COLS - 1);
    expect(room.terminal.cols).toBe(FITTED_COLS - 1);
    room.transport.dispose();
  });

  it("applies a peer at the nudge size that arrives after an acknowledged nudge with no fit change", () => {
    const room = createFitChangeRoom();
    room.advance(100);
    room.advance(2000);
    room.peer(FITTED_COLS - 1);

    expect(room.ptyCols()).toBe(FITTED_COLS - 1);
    expect(room.terminal.cols).toBe(FITTED_COLS - 1);
    room.transport.dispose();
  });
});

describe("hidden terminal fit and shared PTY size", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the final hidden geometry after a burst so the shared PTY no longer has stale ownership", () => {
    const room = createFitChangeRoom();
    let geometry = 70;
    room.peer(20);
    const coalescer = createTerminalResizeCoalescer({
      isSettled: () => true,
      onSettled: () => room.hiddenFit(geometry),
      quietPeriodMs: 120,
    });
    for (let elapsed = 0; elapsed <= 500; elapsed += 16) {
      geometry = 72 - Math.floor(elapsed / 25);
      coalescer.schedule();
      vi.advanceTimersByTime(16);
    }
    vi.advanceTimersByTime(120);
    room.peer(80);

    expect(room.ptyCols()).toBe(53);
    coalescer.cancel();
    room.transport.dispose();
  });

  it("releases a hidden client's size claim when its terminal unmounts", () => {
    const room = createFitChangeRoom();
    room.hiddenFit(16);
    room.peer(24);
    room.transport.setVisible(false);
    room.transport.dispose();

    expect(room.ptyCols()).toBe(24);
  });

  it("uses the settled fit after visibility returns without sending a duplicate resize", () => {
    const room = createFitChangeRoom();
    room.hiddenFit(56);
    room.transport.setVisible(false);
    room.transport.setVisible(true);
    room.fit(56);

    expect(room.ptyCols()).toBe(56);
    expect(room.resizeCountFor(56)).toBe(1);
    expect(room.terminal.cols).toBe(56);
    room.transport.dispose();
  });
});
