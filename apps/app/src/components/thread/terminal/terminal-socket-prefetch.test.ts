import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalWebSocketTransport } from "@bb/client-core";
import {
  createPrefetchedTerminalSocket,
  discardPrefetchedTerminalSocket,
  prefetchTerminalSocket,
} from "./terminal-socket-prefetch";

const url = "ws://localhost/api/terminals/term/socket";
const fullUrl = `${url}?sinceSeq=0&outputAcks=1&resizeAcks=1`;

class Socket {
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
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
});
afterEach(() => {
  discardPrefetchedTerminalSocket(url);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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
