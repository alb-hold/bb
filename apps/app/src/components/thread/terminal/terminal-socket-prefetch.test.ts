// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rememberTerminalGrid } from "./terminal-grid-cache";
import * as terminalFont from "./terminal-font";
import { terminalLayoutFingerprint } from "./terminal-layout-fingerprint";
import browserCaptures from "./terminal-grid-cache.browser-fixture";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { TerminalWebSocketTransport } from "@bb/client-core";
import {
  createPrefetchedTerminalSocket,
  discardPrefetchedTerminalSocket,
  prefetchTerminalSocket,
} from "./terminal-socket-prefetch";

const url = "ws://localhost/ws/terminals/term";
const fullUrl = `${url}?sinceSeq=0&outputAcks=1&resizeAcks=1`;

class Socket {
  static readonly OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  protocol = "";
  bufferedAmount = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: string[] = [];
  constructor() {
    Socket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  message(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
});
afterEach(() => {
  document.body.replaceChildren();
  discardPrefetchedTerminalSocket(url);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(
  [44, 125].flatMap((cols) =>
    ["miss", "match", "mismatch"].map((kind) => ({ cols, kind })),
  ),
)(
  "claims a cached $cols-column grid at socket open and reconciles the final renderer ($kind)",
  async ({ cols, kind }) => {
    if (kind !== "miss") {
      const container = document.createElement("div");
      vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
        new DOMRect(0, 0, 936, 662),
      );
      rememberTerminalGrid(
        "term",
        container,
        terminalFont.readTerminalFontMetrics().fontSize,
        { cols, rows: 38 },
      );
    }
    prefetchTerminalSocket(url);
    const native = Socket.instances[0]!;
    native.open();
    native.message("not json");
    const attachedAt = Date.now();
    native.message(
      JSON.stringify({
        type: "attached",
        session: makeTerminalSession({ id: "term", status: "running" }),
        replayStartSeq: 0,
        nextSeq: 0,
      }),
    );
    const frames = () =>
      native.sent
        .map((raw) => JSON.parse(raw))
        .filter((frame) => frame.type === "resize");
    expect(frames()).toEqual(
      kind === "miss" ? [] : [{ type: "resize", cols, rows: 38, claim: true }],
    );
    expect(Date.now() - attachedAt).toBeLessThanOrEqual(5);
    await vi.advanceTimersByTimeAsync(700);
    const transport = new TerminalWebSocketTransport({
      url,
      createSocket: createPrefetchedTerminalSocket,
      onMessage: () => {},
      shouldReconnect: () => true,
    });
    const fittedCols = kind === "mismatch" ? cols + 1 : cols;
    transport.sendResize(fittedCols, 38, true);
    transport.markLayoutSettled();
    transport.start();
    vi.runAllTicks();
    await Promise.resolve();
    transport.sendResize(fittedCols, 38);
    transport.markLayoutSettled();
    expect(frames()).toHaveLength(kind === "mismatch" ? 2 : 1);
    expect(frames().at(-1)).toEqual({
      type: "resize",
      cols: fittedCols,
      rows: 38,
      claim: true,
    });
    transport.claimSize();
    expect(frames()).toHaveLength(kind === "mismatch" ? 3 : 2);
    expect(frames().at(-1)).toEqual({
      type: "resize",
      cols: fittedCols,
      rows: 38,
      claim: true,
    });
    transport.dispose();
  },
);

it("buffers split control sequences and a live write during replay in exact wire order", async () => {
  prefetchTerminalSocket(url);
  prefetchTerminalSocket(url);
  expect(Socket.instances).toHaveLength(1);
  const native = Socket.instances[0]!;
  native.open();
  native.message("attached");
  native.message("\u001b[3");
  native.message("1mhistory");
  const socket = createPrefetchedTerminalSocket(fullUrl, []);
  const seen: string[] = [];
  socket.onopen = () => {
    seen.push("open");
    native.message("live-during-drain");
  };
  socket.onmessage = (event) => seen.push(event.data);
  native.message("live-during-adoption");
  expect(native.sent).toEqual([]);
  vi.runAllTicks();
  await Promise.resolve();
  native.message("live-after-adoption");
  expect(seen).toEqual([
    "open",
    "attached",
    "\u001b[3",
    "1mhistory",
    "live-during-adoption",
    "live-during-drain",
    "live-after-adoption",
  ]);
  expect(Socket.instances).toHaveLength(1);
  socket.close();
});

it("adopts an open socket without reconnecting and sends only the fitted grid", async () => {
  prefetchTerminalSocket(url);
  const native = Socket.instances[0]!;
  native.open();
  expect(native.sent).toEqual([]);
  const transport = new TerminalWebSocketTransport({
    url,
    createSocket: createPrefetchedTerminalSocket,
    onMessage: () => {},
    shouldReconnect: () => true,
  });
  transport.sendResize(120, 40);
  transport.markLayoutSettled();
  transport.start();
  vi.runAllTicks();
  await Promise.resolve();
  expect(Socket.instances).toHaveLength(1);
  prefetchTerminalSocket(url);
  discardPrefetchedTerminalSocket(url);
  expect(Socket.instances).toHaveLength(1);
  expect(native.readyState).toBe(1);
  const frames = native.sent.map((data) => JSON.parse(data));
  expect(frames.filter((frame) => frame.type === "resize")).toEqual([
    expect.objectContaining({ cols: 120, rows: 40 }),
  ]);
  expect(frames.some((frame) => frame.type === "input")).toBe(false);
  transport.dispose();
});

it("expires unused sockets and does not reuse closed connections", async () => {
  prefetchTerminalSocket(url);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(Socket.instances[0]!.readyState).toBe(3);
  const socket = createPrefetchedTerminalSocket(fullUrl, []);
  expect(Socket.instances).toHaveLength(2);
  socket.close();
});

it("closes abandoned sockets without sending any frames", () => {
  prefetchTerminalSocket(url);
  discardPrefetchedTerminalSocket(url);
  expect(Socket.instances[0]!.readyState).toBe(3);
  expect(Socket.instances[0]!.sent).toEqual([]);
});

it("bounds unconsumed frame memory", () => {
  prefetchTerminalSocket(url);
  Socket.instances[0]!.message("x".repeat(13 * 1024 * 1024));
  expect(Socket.instances[0]!.readyState).toBe(3);
});

it("claims while attach is pending and delivers replay at the claimed grid before live output", async () => {
  const container = document.createElement("div");
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 936, 662),
  );
  rememberTerminalGrid(
    "term",
    container,
    terminalFont.readTerminalFontMetrics().fontSize,
    { cols: 116, rows: 38 },
  );
  prefetchTerminalSocket(url);
  const native = Socket.instances[0]!;
  native.open();
  expect(native.sent.map((raw) => JSON.parse(raw))).toEqual([
    { type: "resize", cols: 116, rows: 38, claim: true },
  ]);
  const session = makeTerminalSession({
    id: "term",
    status: "running",
    cols: 116,
    rows: 38,
  });
  const attached = { type: "attached", session, replayStartSeq: 0, nextSeq: 1 };
  const replay = {
    type: "output",
    chunk: { seq: 0, dataBase64: btoa("history") },
  };
  native.message(JSON.stringify(attached));
  native.message(JSON.stringify(replay));
  const seen: unknown[] = [];
  const transport = new TerminalWebSocketTransport({
    url,
    createSocket: createPrefetchedTerminalSocket,
    onMessage: (message) => seen.push(message),
    shouldReconnect: () => true,
  });
  transport.sendResize(116, 38, true);
  transport.markLayoutSettled();
  transport.start();
  vi.runAllTicks();
  await Promise.resolve();
  expect(seen).toEqual(expect.arrayContaining([attached, replay]));
  expect(
    seen
      .map((message) => JSON.stringify(message))
      .indexOf(JSON.stringify(attached)),
  ).toBeLessThan(
    seen
      .map((message) => JSON.stringify(message))
      .indexOf(JSON.stringify(replay)),
  );
  expect(
    native.sent
      .map((raw) => JSON.parse(raw))
      .filter((frame) => frame.type === "resize"),
  ).toHaveLength(1);
  transport.dispose();
});

it("forgets a disconnected cached claim before a new socket is adopted", () => {
  const container = document.createElement("div");
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 936, 662),
  );
  rememberTerminalGrid(
    "term",
    container,
    terminalFont.readTerminalFontMetrics().fontSize,
    { cols: 116, rows: 38 },
  );
  prefetchTerminalSocket(url);
  const native = Socket.instances[0]!;
  native.open();
  native.readyState = 3;
  native.onclose?.(new CloseEvent("close"));
  prefetchTerminalSocket(url);
  const replacement = Socket.instances[1]!;
  replacement.open();
  expect(replacement.sent.map((raw) => JSON.parse(raw))).toEqual([
    { type: "resize", cols: 116, rows: 38, claim: true },
  ]);
  expect(native.sent).toHaveLength(1);
});

it("claims at socket-open even when the view adopted the connecting socket first", async () => {
  const container = document.createElement("div");
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 936, 662),
  );
  rememberTerminalGrid(
    "term",
    container,
    terminalFont.readTerminalFontMetrics().fontSize,
    { cols: 116, rows: 38 },
  );
  prefetchTerminalSocket(url);
  const native = Socket.instances[0]!;
  const transport = new TerminalWebSocketTransport({
    url,
    createSocket: createPrefetchedTerminalSocket,
    onMessage: () => {},
    shouldReconnect: () => true,
  });
  transport.start();
  vi.runAllTicks();
  await Promise.resolve();
  native.open();
  expect(
    native.sent
      .map((raw) => JSON.parse(raw))
      .filter((frame) => frame.type === "resize"),
  ).toEqual([{ type: "resize", cols: 116, rows: 38, claim: true }]);
  transport.sendResize(116, 38, true);
  transport.markLayoutSettled();
  expect(
    native.sent
      .map((raw) => JSON.parse(raw))
      .filter((frame) => frame.type === "resize"),
  ).toHaveLength(1);
  transport.dispose();
});

it("claims a persisted grid at socket open before the app layout mounts", async () => {
  const shell = document.createElement("div");
  shell.dataset.testid = "app-layout-content-shell";
  vi.spyOn(shell, "getBoundingClientRect").mockReturnValue(
    new DOMRect(320, 0, 960, 800),
  );
  const container = document.createElement("div");
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 944, 698),
  );
  shell.append(container);
  document.body.append(shell);
  rememberTerminalGrid(
    "term",
    container,
    terminalFont.readTerminalFontMetrics().fontSize,
    { cols: 116, rows: 36 },
  );
  document.body.replaceChildren();
  prefetchTerminalSocket(url);
  const native = Socket.instances[0]!;
  native.open();
  expect(document.body.children).toHaveLength(0);
  expect(native.sent.map((frame) => JSON.parse(frame))).toEqual([
    { type: "resize", cols: 116, rows: 36, claim: true },
  ]);
  const transport = new TerminalWebSocketTransport({
    url,
    createSocket: createPrefetchedTerminalSocket,
    onMessage: () => {},
    shouldReconnect: () => true,
  });
  transport.sendResize(116, 36, true);
  transport.markLayoutSettled();
  transport.start();
  vi.runAllTicks();
  await Promise.resolve();
  expect(native.sent).toHaveLength(1);
  transport.dispose();
});

it.each(browserCaptures)(
  "reuses the fitted key at socket open after captured WebKit hydration at $viewportWidth px",
  async (capture) => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(
      capture.viewportWidth,
    );
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(
      capture.viewportHeight,
    );
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(capture.dpr);
    vi.spyOn(terminalFont, "readTerminalFontMetrics").mockReturnValue({
      fontSize: capture.fontSize,
      fontWeight: 400,
      fontFamily: terminalFont.readTerminalFontFamily(),
    });
    localStorage.setItem("bb.splitLayout", capture.splitLayout);
    const panelKey = "bb.thread.fixedPanelTabsState-thread-1";
    localStorage.setItem(
      panelKey,
      JSON.stringify({ secondary: capture.fittedPanelGeometry }),
    );
    const shell = document.createElement("div");
    shell.dataset.testid = "app-layout-content-shell";
    const container = document.createElement("div");
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, capture.containerWidth, capture.containerHeight),
    );
    shell.append(container);
    document.body.append(shell);
    rememberTerminalGrid("term", container, capture.fontSize, capture.grid);
    const fittedKey = JSON.parse(
      localStorage.getItem("bb.terminal.fit-grids.v4")!,
    )[0].layout;
    expect(fittedKey).toEqual(
      JSON.stringify([320, true, capture.splitLayout, null, []]),
    );
    document.body.replaceChildren();
    localStorage.setItem(panelKey, JSON.stringify(capture.persistedPanelState));
    expect(terminalLayoutFingerprint()).toEqual(fittedKey);
    prefetchTerminalSocket(url);
    const native = Socket.instances[0]!;
    native.open();
    expect(native.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "resize", ...capture.grid, claim: true },
    ]);
    const transport = new TerminalWebSocketTransport({
      url,
      createSocket: createPrefetchedTerminalSocket,
      onMessage: () => {},
      shouldReconnect: () => true,
    });
    transport.sendResize(capture.grid.cols, capture.grid.rows, true);
    transport.markLayoutSettled();
    transport.start();
    vi.runAllTicks();
    await Promise.resolve();
    expect(native.sent).toHaveLength(1);
    transport.dispose();
  },
);
