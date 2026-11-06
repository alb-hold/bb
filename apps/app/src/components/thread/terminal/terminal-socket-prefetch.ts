import type { TerminalBrowserSocket } from "@bb/client-core";
import {
  TERMINAL_LEGACY_WEBSOCKET_PROTOCOL,
  TERMINAL_RESIZE_ECHO_WEBSOCKET_PROTOCOL,
} from "@bb/server-contract";

const pending = new Map<string, BufferedTerminalSocket>();
const active = new Map<string, BufferedTerminalSocket>();
const MAX_BYTES = 24 * 1024 * 1024;

type Delivery = () => void;

class BufferedTerminalSocket implements TerminalBrowserSocket {
  onopen: TerminalBrowserSocket["onopen"] = null;
  onmessage: TerminalBrowserSocket["onmessage"] = null;
  onerror: TerminalBrowserSocket["onerror"] = null;
  onclose: TerminalBrowserSocket["onclose"] = null;
  private queue: Delivery[] = [];
  private bytes = 0;
  private adopted = false;
  private timer: ReturnType<typeof setTimeout>;
  private readonly socket: WebSocket;

  constructor(
    url: string,
    protocols: string[],
    private readonly forget: () => void,
  ) {
    this.socket = new WebSocket(url, protocols);
    this.timer = setTimeout(() => this.close(), 10_000);
    this.socket.onopen = (event) => this.deliver(() => this.onopen?.(event));
    this.socket.onmessage = (event) => {
      if (!this.adopted) {
        this.bytes +=
          typeof event.data === "string" ? event.data.length * 2 : MAX_BYTES;
        if (this.bytes > MAX_BYTES || this.queue.length >= 8192) {
          this.close();
          return;
        }
      }
      this.deliver(() => this.onmessage?.(event));
    };
    this.socket.onerror = (event) => this.deliver(() => this.onerror?.(event));
    this.socket.onclose = (event) => {
      this.forget();
      clearTimeout(this.timer);
      this.deliver(() => this.onclose?.(event));
    };
  }

  get readyState() {
    return this.socket.readyState;
  }
  get protocol() {
    return this.socket.protocol;
  }
  get bufferedAmount() {
    return this.socket.bufferedAmount;
  }

  private deliver(delivery: Delivery) {
    if (this.adopted) delivery();
    else this.queue.push(delivery);
  }

  adopt() {
    clearTimeout(this.timer);
    this.forget();
    queueMicrotask(() => {
      for (let index = 0; index < this.queue.length; index++)
        this.queue[index]?.();
      this.queue = [];
      this.bytes = 0;
      this.adopted = true;
    });
    return this;
  }

  send(data: string) {
    this.socket.send(data);
  }

  close(code?: number, reason?: string) {
    clearTimeout(this.timer);
    this.forget();
    this.queue = [];
    this.socket.close(code, reason);
  }
}

function attachUrl(url: string) {
  const parsed = new URL(url);
  parsed.searchParams.set("sinceSeq", "0");
  parsed.searchParams.set("outputAcks", "1");
  parsed.searchParams.set("resizeAcks", "1");
  return parsed.toString();
}

export function prefetchTerminalSocket(url: string): void {
  const key = attachUrl(url);
  if (pending.has(key) || active.has(key)) return;
  if (pending.size >= 2) pending.values().next().value?.close();
  try {
    const socket = new BufferedTerminalSocket(
      key,
      [
        TERMINAL_LEGACY_WEBSOCKET_PROTOCOL,
        TERMINAL_RESIZE_ECHO_WEBSOCKET_PROTOCOL,
      ],
      () => {
        if (pending.get(key) === socket) pending.delete(key);
        if (active.get(key) === socket) active.delete(key);
      },
    );
    pending.set(key, socket);
  } catch {
    pending.delete(key);
  }
}

export function createPrefetchedTerminalSocket(
  url: string,
  protocols: string[],
): TerminalBrowserSocket {
  const socket = pending.get(url);
  if (socket && socket.readyState < 2) {
    socket.adopt();
    active.set(url, socket);
    return socket;
  }
  socket?.close();
  return new WebSocket(url, protocols);
}

export function discardPrefetchedTerminalSocket(url: string): void {
  pending.get(attachUrl(url))?.close();
}
