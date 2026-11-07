import { readCachedTerminalGrid } from "./terminal-grid-cache";
import { markTerminalPerformance } from "@/lib/terminal-performance";
import type { TerminalBrowserSocket } from "@bb/client-core";
import type {
  TERMINAL_REPLAY_BATCH_WEBSOCKET_PROTOCOL,
  TERMINAL_LEGACY_WEBSOCKET_PROTOCOL,
  TERMINAL_RESIZE_ECHO_WEBSOCKET_PROTOCOL,
} from "@bb/server-contract";

const pending = new Map<string, BufferedTerminalSocket>();
const active = new Map<string, BufferedTerminalSocket>();
let cachedClaimMisses = 0;
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
  private adoptionRequested = false;
  private cachedClaim: { cols: number; rows: number } | null = null;
  private firstLiveOutput = false;
  private firstReplayBatch = false;
  private timer: ReturnType<typeof setTimeout>;
  private readonly socket: WebSocket;

  constructor(
    url: string,
    protocols: string[],
    private readonly forget: () => void,
  ) {
    this.socket = new WebSocket(url, protocols);
    markTerminalPerformance("terminal-socket-created");
    this.timer = setTimeout(() => this.close(), 10_000);
    this.socket.onopen = (event) => {
      markTerminalPerformance("terminal-socket-open");
      const terminalId = new URL(url).pathname.match(
        /\/terminals\/([^/]+)(?:\/|$)/,
      )?.[1];
      const grid =
        !this.adoptionRequested && terminalId
          ? readCachedTerminalGrid(decodeURIComponent(terminalId))
          : null;
      if (grid) {
        this.cachedClaim = grid;
        this.socket.send(
          JSON.stringify({ type: "resize", ...grid, claim: true }),
        );
        markTerminalPerformance("terminal-cached-grid-claimed");
      }
      this.deliver(() => this.onopen?.(event));
    };
    this.socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const message: unknown = JSON.parse(event.data);
          if (
            typeof message !== "object" ||
            message === null ||
            !("type" in message)
          )
            throw new Error("Invalid terminal frame");
          if (
            typeof message.type === "string" &&
            [
              "attached",
              "features",
              "session-updated",
              "resize-applied",
            ].includes(message.type)
          )
            markTerminalPerformance(`terminal-wire-${message.type}`);
          if (message.type === "output-batch" && !this.firstReplayBatch) {
            this.firstReplayBatch = true;
            markTerminalPerformance("terminal-wire-first-output-batch");
          }
          if (message.type === "output" && !this.firstLiveOutput) {
            this.firstLiveOutput = true;
            markTerminalPerformance("terminal-wire-first-output");
          }
        } catch {}
      }
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
      this.cachedClaim = null;
      this.forget();
      clearTimeout(this.timer);
      this.deliver(() => this.onclose?.(event));
    };
  }

  get initialSizeClaim() {
    return this.cachedClaim ?? undefined;
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
    this.adoptionRequested = true;
    markTerminalPerformance("terminal-socket-adopted");
    clearTimeout(this.timer);
    this.forget();
    queueMicrotask(() => {
      markTerminalPerformance("terminal-buffer-drain-start");
      for (let index = 0; index < this.queue.length; index++)
        this.queue[index]?.();
      this.queue = [];
      this.bytes = 0;
      this.adopted = true;
      markTerminalPerformance("terminal-buffer-drain-end");
    });
    return this;
  }

  send(data: string) {
    if (this.cachedClaim) {
      const frame: unknown = JSON.parse(data);
      if (
        typeof frame === "object" &&
        frame !== null &&
        "type" in frame &&
        frame.type === "resize"
      ) {
        const cached = this.cachedClaim;
        this.cachedClaim = null;
        if (
          "cols" in frame &&
          "rows" in frame &&
          frame.cols === cached.cols &&
          frame.rows === cached.rows
        ) {
          markTerminalPerformance("terminal-cached-grid-hit");
        } else
          markTerminalPerformance("terminal-cached-grid-miss", {
            detail: { count: ++cachedClaimMisses },
          });
      }
    }
    this.socket.send(data);
  }

  close(code?: number, reason?: string) {
    this.cachedClaim = null;
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
        "bb.terminal.v1" satisfies typeof TERMINAL_LEGACY_WEBSOCKET_PROTOCOL,
        "bb.terminal.resize-echo.v1" satisfies typeof TERMINAL_RESIZE_ECHO_WEBSOCKET_PROTOCOL,
        "bb.terminal.replay-batch.v1" satisfies typeof TERMINAL_REPLAY_BATCH_WEBSOCKET_PROTOCOL,
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
