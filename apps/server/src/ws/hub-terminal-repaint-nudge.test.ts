import {
  TerminalWebSocketTransport,
  type TerminalBrowserSocket,
} from "@bb/client-core";
import type { TerminalSession } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationHub } from "./hub.js";

const TERMINAL_ID = "term_1";
const FITTED = { cols: 132, rows: 46 };

function session(cols: number, rows: number): TerminalSession {
  return {
    id: TERMINAL_ID,
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

interface TwoClientRoom {
  connect: () => void;
  advance: (ms: number) => void;
  delayReports: () => void;
  deliverReports: () => void;
  fit: (cols: number) => void;
  peerResizes: (cols: number, rows: number) => void;
  ptySize: () => { cols: number; rows: number };
  restoresSentByOwner: () => number;
  start: () => void;
  transport: TerminalWebSocketTransport;
  viewCols: () => number;
  viewHistory: number[];
}

function createRoom(): TwoClientRoom {
  vi.useFakeTimers();
  const hub = new NotificationHub();
  const ownerSocket = { close: () => undefined, send: () => undefined };
  const peerSocket = { close: () => undefined, send: () => undefined };
  hub.registerTerminalClient(TERMINAL_ID, ownerSocket);
  hub.registerTerminalClient(TERMINAL_ID, peerSocket);
  let pty = { ...FITTED };
  let fitted = FITTED.cols;
  let shared: number | null = null;
  const viewHistory: number[] = [];
  const viewCols = (): number => Math.min(fitted, shared ?? fitted);
  const track = (): void => {
    viewHistory.push(viewCols());
  };
  let restores = 0;
  let nudged = false;
  let delayed = false;
  const queued: Array<{ cols: number; rows: number }> = [];

  const browserSocket: TerminalBrowserSocket & {
    deliver: (size: { cols: number; rows: number }) => void;
  } = {
    onclose: null,
    onerror: null,
    onmessage: null,
    onopen: null,
    readyState: 1,
    close: () => undefined,
    deliver(size) {
      this.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "session-updated",
            session: session(size.cols, size.rows),
          }),
        }),
      );
    },
    send(data: string) {
      const message: unknown = JSON.parse(data);
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "resize" ||
        !("cols" in message) ||
        typeof message.cols !== "number" ||
        !("rows" in message) ||
        typeof message.rows !== "number"
      ) {
        return;
      }
      const size = { cols: message.cols, rows: message.rows };
      if (size.cols === FITTED.cols - 1) {
        nudged = true;
      } else if (nudged && size.cols === FITTED.cols) {
        restores += 1;
      }
      hub.recordTerminalClientSize(TERMINAL_ID, ownerSocket, size, Date.now());
      settle();
    },
  };

  const settle = (): void => {
    const shared = hub.terminalSharedSize(TERMINAL_ID, Date.now());
    if (shared === null) {
      return;
    }
    if (shared.cols === pty.cols && shared.rows === pty.rows) {
      return;
    }
    pty = shared;
    if (delayed) {
      queued.push(shared);
      return;
    }
    browserSocket.deliver(shared);
  };

  const transport = new TerminalWebSocketTransport({
    createSocket: () => browserSocket,
    onMessage: (message) => {
      if (message.type !== "session-updated") {
        return;
      }
      const reported = { cols: message.session.cols, rows: message.session.rows };
      if (!transport.consumeRepaintNudgeEcho(reported)) {
        shared = reported.cols;
        track();
      }
    },
    onRepaintNudgeSizeReleased: (size) => {
      shared = size.cols;
      track();
    },
    shouldReconnect: () => false,
    url: "ws://example.test/ws/terminals/term_1",
  });
  transport.sendResize(FITTED.cols, FITTED.rows);

  let connected = false;
  const connect = (): void => {
    if (connected) {
      return;
    }
    connected = true;
    transport.start();
    browserSocket.onopen?.(new Event("open"));
    transport.markLayoutSettled();
  };

  return {
    advance: (ms) => vi.advanceTimersByTime(ms),
    delayReports: () => {
      delayed = true;
    },
    deliverReports: () => {
      delayed = false;
      for (const size of queued.splice(0)) {
        browserSocket.deliver(size);
      }
    },
    fit: (cols) => {
      fitted = cols;
      track();
      transport.sendResize(cols, FITTED.rows);
    },
    peerResizes: (cols, rows) => {
      hub.recordTerminalClientSize(
        TERMINAL_ID,
        peerSocket,
        { cols, rows },
        Date.now(),
      );
      settle();
    },
    ptySize: () => pty,
    restoresSentByOwner: () => restores,
    connect,
    start: () => {
      connect();
      transport.requestRepaint();
      vi.advanceTimersByTime(0);
    },
    transport,
    viewCols,
    viewHistory,
  };
}

describe("repaint nudge with a second client on the same terminal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves a peer's smaller size as the shared size after the restore, and the owner's view follows it", () => {
    const room = createRoom();
    room.start();
    expect(room.ptySize().cols).toBe(FITTED.cols - 1);

    room.advance(100);
    room.peerResizes(44, 20);
    expect(room.viewCols()).toBe(44);

    room.advance(300);
    expect(room.restoresSentByOwner()).toBe(1);
    room.advance(1000);

    expect(room.ptySize()).toEqual({ cols: 44, rows: 20 });
    expect(room.viewCols()).toBe(44);
    room.transport.dispose();
  });

  it("applies a peer size that is exactly the nudge size once the window closes, instead of dropping it as the echo", () => {
    const room = createRoom();
    room.start();
    room.advance(100);
    room.peerResizes(FITTED.cols - 1, FITTED.rows);
    expect(room.viewCols()).toBe(FITTED.cols);

    room.advance(300);
    expect(room.restoresSentByOwner()).toBe(1);
    room.advance(1000);

    expect(room.ptySize()).toEqual({ cols: FITTED.cols - 1, rows: FITTED.rows });
    expect(room.viewCols()).toBe(FITTED.cols - 1);
    room.transport.dispose();
  });

  it("returns to the real size when no peer interferes", () => {
    const room = createRoom();
    room.start();
    room.advance(1500);

    expect(room.ptySize()).toEqual(FITTED);
    expect(room.viewCols()).toBe(FITTED.cols);
    room.transport.dispose();
  });

  it("lets a larger peer leave the owner's size as the shared size", () => {
    const room = createRoom();
    room.start();
    room.advance(100);
    room.peerResizes(200, 60);
    room.advance(1500);

    expect(room.ptySize()).toEqual(FITTED);
    expect(room.viewCols()).toBe(FITTED.cols);
    room.transport.dispose();
  });

  it("never applies the nudge size when the fit grows between nudge and restore and a smaller peer resizes", () => {
    const room = createRoom();
    room.start();
    room.advance(100);
    room.fit(200);
    room.advance(50);
    room.peerResizes(44, 20);
    room.advance(2000);

    expect(room.viewHistory).not.toContain(FITTED.cols - 1);
    expect(room.restoresSentByOwner()).toBe(0);
    expect(room.ptySize().cols).toBe(44);
    expect(room.viewCols()).toBe(44);
    room.transport.dispose();
  });

  it("never applies the nudge size when the fit shrinks between nudge and restore and a peer sits exactly at the nudge size", () => {
    const room = createRoom();
    room.start();
    room.advance(100);
    room.peerResizes(FITTED.cols - 1, FITTED.rows);
    room.advance(50);
    room.fit(100);
    room.advance(2000);

    expect(room.viewHistory).not.toContain(FITTED.cols - 1);
    expect(room.ptySize().cols).toBe(100);
    expect(room.viewCols()).toBe(100);
    room.transport.dispose();
  });

  it("applies a peer exactly at the nudge size only after the grace window when the fit grows past it", () => {
    const room = createRoom();
    room.start();
    room.advance(100);
    room.peerResizes(FITTED.cols - 1, FITTED.rows);
    room.advance(50);
    room.fit(200);
    room.advance(249);
    expect(room.viewHistory).not.toContain(FITTED.cols - 1);
    room.advance(2000);

    expect(room.ptySize().cols).toBe(FITTED.cols - 1);
    expect(room.viewCols()).toBe(FITTED.cols - 1);
    room.transport.dispose();
  });

  it("never applies the nudge size when the fit changes before the nudge report is delivered", () => {
    const room = createRoom();
    room.delayReports();
    room.start();
    room.fit(200);
    room.advance(50);
    room.deliverReports();
    room.advance(2000);

    expect(room.viewHistory).not.toContain(FITTED.cols - 1);
    expect(room.ptySize().cols).toBe(200);
    expect(room.viewCols()).toBe(200);
    room.transport.dispose();
  });

  it("never applies the nudge size when the fit changes before the nudge report and a smaller peer resizes", () => {
    const room = createRoom();
    room.delayReports();
    room.start();
    room.fit(200);
    room.peerResizes(44, 20);
    room.advance(50);
    room.deliverReports();
    room.advance(2000);

    expect(room.viewHistory).not.toContain(FITTED.cols - 1);
    expect(room.ptySize().cols).toBe(44);
    expect(room.viewCols()).toBe(44);
    room.transport.dispose();
  });

  it("is not stuck when the nudge report never arrives because a smaller peer already held the shared size", () => {
    const room = createRoom();
    room.connect();
    room.peerResizes(44, 20);
    room.start();
    room.advance(50);
    room.fit(200);
    room.advance(2000);

    expect(room.viewHistory).not.toContain(FITTED.cols - 1);
    expect(room.viewCols()).toBe(44);

    room.peerResizes(FITTED.cols - 1, FITTED.rows);
    expect(room.ptySize().cols).toBe(FITTED.cols - 1);
    expect(room.viewCols()).toBe(FITTED.cols - 1);
    room.transport.dispose();
  });

  it("applies a peer that later resizes to exactly the nudge size once the stale window has passed", () => {
    const room = createRoom();
    room.connect();
    room.peerResizes(300, 60);
    room.start();
    room.advance(50);
    room.fit(500);
    room.advance(2000);
    room.peerResizes(FITTED.cols - 1, FITTED.rows);

    expect(room.ptySize().cols).toBe(FITTED.cols - 1);
    expect(room.viewCols()).toBe(FITTED.cols - 1);
    room.transport.dispose();
  });
});
