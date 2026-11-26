import { chmodSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import {
  BRIDGE_NOTIFICATION_METHODS,
  sessionReplacedNotificationSchema,
} from "../notifications.js";
import { BRIDGE_REQUEST_METHODS } from "../requests.js";
import {
  backgroundScopedDeltaItemShapeSchema,
  bridgeOpenWorkSnapshotSchema,
  deltaItemKeySchema,
  deltaPresentationSchema,
  formatDeltaItemKey,
  THREAD_DELTA_NOTIFICATION_METHOD,
  type BridgeOpenWorkItem,
  type BridgeOpenWorkSnapshot,
} from "../thread-delta.js";
import { readBoundedLines } from "./bounded-line-reader.js";
import { BridgeReplayBuffer } from "./bridge-replay-buffer.js";

export const BRIDGE_SOCKET_ENV = "BB_BRIDGE_SOCKET";
export const BRIDGE_SPILL_ENV = "BB_BRIDGE_SPILL";
export const BRIDGE_SOCKET_MIN_ADOPTABLE_TRANSPORT_VERSION = 2 as const;
export const BRIDGE_SOCKET_TRANSPORT_VERSION = 3 as const;
export const BRIDGE_SHUTDOWN_METHOD = "bridge/shutdown";
export const BRIDGE_RESUME_METHOD = "bridge/resume";
export const BRIDGE_ACK_METHOD = "bridge/ack";
export const BRIDGE_OPEN_WORK_METHOD = "bridge/open-work";
export const BRIDGE_REATTACH_TTL_MS = 30 * 60 * 1000;
export const BRIDGE_REPLAY_MEMORY_CAP_BYTES = 64 * 1024 * 1024;
export const BRIDGE_REPLAY_HARD_CAP_BYTES = 1024 * 1024 * 1024;

const INTERNAL_RELEASE_ID_PREFIX = "__bb_bridge_release_";

export type BridgeSocketShutdownReason = "requested" | "abandoned";

export interface BridgeSocketServerArgs {
  socketPath: string;
  spillPath: string;
  reattachTtlMs: number;
  memoryCapBytes: number;
  hardCapBytes: number;
  onOverflow: (bytes: number) => void;
  onBackpressure: (paused: boolean, retainedBytes: number) => void;
}

export interface BridgeSocketListenArgs {
  onLine: (line: string) => void;
  onShutdown: (reason: BridgeSocketShutdownReason) => void;
}

export interface BridgeSocketServer {
  write(chunk: string | Uint8Array, callback?: (error?: Error) => void): void;
  listen(args: BridgeSocketListenArgs): Promise<void>;
  close(): void;
  replayStats(): ReturnType<BridgeReplayBuffer["stats"]>;
}

type BridgeControlMessage =
  | { kind: "shutdown" }
  | { kind: "resume"; afterWseq: number; reportOpenWork: boolean }
  | { kind: "ack"; through: number; keep: number[] };

interface PendingThreadRelease {
  originalId: string | number;
  threadId: string | null;
}

export function parseBridgeControlMessage(
  line: string,
): BridgeControlMessage | null {
  if (!line.includes('"bridge/')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const method = Reflect.get(parsed, "method");
  const params: unknown = Reflect.get(parsed, "params");
  const numberParam = (name: string): number | null => {
    if (typeof params !== "object" || params === null) return null;
    const value: unknown = Reflect.get(params, name);
    return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? value
      : null;
  };
  if (method === BRIDGE_SHUTDOWN_METHOD) return { kind: "shutdown" };
  if (method === BRIDGE_RESUME_METHOD) {
    const afterWseq = numberParam("afterWseq");
    const reportOpenWork =
      typeof params === "object" &&
      params !== null &&
      Reflect.get(params, "reportOpenWork") === true;
    return afterWseq === null
      ? null
      : { kind: "resume", afterWseq, reportOpenWork };
  }
  if (method === BRIDGE_ACK_METHOD) {
    const through = numberParam("through");
    const keep = wseqListParam(params, "keep");
    return through === null || keep === null
      ? null
      : { kind: "ack", through, keep };
  }
  return null;
}

export function parseBridgeOpenWorkMessage(
  line: string,
): BridgeOpenWorkSnapshot | null {
  if (!line.includes(BRIDGE_OPEN_WORK_METHOD)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  if (Reflect.get(parsed, "method") !== BRIDGE_OPEN_WORK_METHOD) return null;
  const snapshot = bridgeOpenWorkSnapshotSchema.safeParse(
    Reflect.get(parsed, "params"),
  );
  return snapshot.success ? snapshot.data : null;
}

function wseqListParam(params: unknown, name: string): number[] | null {
  if (typeof params !== "object" || params === null) return null;
  const value: unknown = Reflect.get(params, name);
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const wseqs: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) {
      return null;
    }
    wseqs.push(item);
  }
  return wseqs;
}

export function isBridgeShutdownRequest(line: string): boolean {
  return parseBridgeControlMessage(line)?.kind === "shutdown";
}

export function encodeBridgeFrame(wseq: number, line: string): Buffer {
  return Buffer.from(`${wseq}\t${line}\n`);
}

export function decodeBridgeFrame(
  frame: string,
): { wseq: number; line: string } | null {
  const tab = frame.indexOf("\t");
  if (tab <= 0) return null;
  const wseq = Number(frame.slice(0, tab));
  if (!Number.isSafeInteger(wseq) || wseq <= 0) return null;
  return { wseq, line: frame.slice(tab + 1) };
}

function isOpenBackgroundItem(item: BridgeOpenWorkItem["item"]): boolean {
  return item.type === "backgroundTask"
    ? item.status === "pending"
    : item.background;
}

export function createBridgeSocketServer(
  args: BridgeSocketServerArgs,
): BridgeSocketServer {
  let server: Server | null = null;
  let current: Socket | null = null;
  let resumed = false;
  let reattachTimer: NodeJS.Timeout | null = null;
  let closed = false;
  let listenArgs: BridgeSocketListenArgs | null = null;
  let nextWseq = 1;
  let nextInternalReleaseSeq = 1;
  let paused = false;
  let kept: readonly number[] = [];
  const decoder = new StringDecoder("utf8");
  let partialLine = "";
  const openWorkByThread = new Map<string, Map<string, BridgeOpenWorkItem>>();
  const pendingThreadReleases = new Map<string, PendingThreadRelease>();
  const buffer = new BridgeReplayBuffer({
    spillPath: args.spillPath,
    memoryCapBytes: args.memoryCapBytes,
  });

  function setThreadOpenWorkItem(
    threadId: string,
    keyStr: string,
    entry: BridgeOpenWorkItem | null,
  ): void {
    const existing = openWorkByThread.get(threadId);
    if (entry === null) {
      if (existing === undefined) return;
      existing.delete(keyStr);
      if (existing.size === 0) {
        openWorkByThread.delete(threadId);
      }
      return;
    }
    if (existing !== undefined) {
      existing.set(keyStr, entry);
      return;
    }
    openWorkByThread.set(threadId, new Map([[keyStr, entry]]));
  }

  function recordPendingRelease(entry: PendingThreadRelease): string {
    const internalId = `${INTERNAL_RELEASE_ID_PREFIX}${nextInternalReleaseSeq}`;
    nextInternalReleaseSeq += 1;
    pendingThreadReleases.set(internalId, entry);
    while (pendingThreadReleases.size > 4096) {
      const oldest = pendingThreadReleases.keys().next();
      if (oldest.done === true) break;
      pendingThreadReleases.delete(oldest.value);
    }
    return internalId;
  }

  function rewriteInboundLine(line: string): string {
    if (
      !line.includes(BRIDGE_REQUEST_METHODS.threadStop) &&
      !line.includes(BRIDGE_REQUEST_METHODS.threadDiscard) &&
      !line.includes(INTERNAL_RELEASE_ID_PREFIX)
    ) {
      return line;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return line;
    }
    if (typeof parsed !== "object" || parsed === null) return line;
    const id: unknown = Reflect.get(parsed, "id");
    if (typeof id !== "string" && typeof id !== "number") return line;
    const method: unknown = Reflect.get(parsed, "method");
    if (typeof method !== "string") return line;
    const isReleaseMethod =
      method === BRIDGE_REQUEST_METHODS.threadStop ||
      method === BRIDGE_REQUEST_METHODS.threadDiscard;
    const usesReservedPrefix =
      typeof id === "string" && id.startsWith(INTERNAL_RELEASE_ID_PREFIX);
    if (!isReleaseMethod && !usesReservedPrefix) {
      return line;
    }
    let threadId: string | null = null;
    if (isReleaseMethod) {
      const params: unknown = Reflect.get(parsed, "params");
      if (typeof params === "object" && params !== null) {
        const rawThreadId: unknown = Reflect.get(params, "threadId");
        if (typeof rawThreadId === "string" && rawThreadId.length > 0) {
          threadId = rawThreadId;
        }
      }
    }
    const internalId = recordPendingRelease({ originalId: id, threadId });
    return JSON.stringify({
      ...(parsed as Record<string, unknown>),
      id: internalId,
    });
  }

  function rewriteAndObserveOutboundLine(line: string): string {
    if (
      !line.includes(INTERNAL_RELEASE_ID_PREFIX) &&
      !line.includes(THREAD_DELTA_NOTIFICATION_METHOD) &&
      !line.includes(BRIDGE_NOTIFICATION_METHODS.sessionReplaced)
    ) {
      return line;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return line;
    }
    if (typeof parsed !== "object" || parsed === null) return line;
    const method: unknown = Reflect.get(parsed, "method");
    if (method === undefined) {
      const id: unknown = Reflect.get(parsed, "id");
      if (typeof id !== "string" || !id.startsWith(INTERNAL_RELEASE_ID_PREFIX)) {
        return line;
      }
      const pendingRelease = pendingThreadReleases.get(id);
      if (pendingRelease === undefined) return line;
      pendingThreadReleases.delete(id);
      if (
        pendingRelease.threadId !== null &&
        Reflect.has(parsed, "result") &&
        Reflect.get(parsed, "error") === undefined
      ) {
        openWorkByThread.delete(pendingRelease.threadId);
      }
      return JSON.stringify({
        ...(parsed as Record<string, unknown>),
        id: pendingRelease.originalId,
      });
    }
    const params: unknown = Reflect.get(parsed, "params");
    if (method === BRIDGE_NOTIFICATION_METHODS.sessionReplaced) {
      const replaced = sessionReplacedNotificationSchema.safeParse(params);
      if (
        replaced.success &&
        (replaced.data.contextLost || replaced.data.providerThreadId === null)
      ) {
        openWorkByThread.delete(replaced.data.threadId);
      }
      return line;
    }
    if (method !== THREAD_DELTA_NOTIFICATION_METHOD) return line;
    if (typeof params !== "object" || params === null) return line;
    const threadId: unknown = Reflect.get(params, "threadId");
    const deltas: unknown = Reflect.get(params, "deltas");
    if (
      typeof threadId !== "string" ||
      threadId.length === 0 ||
      !Array.isArray(deltas)
    ) {
      return line;
    }
    for (const rawDelta of deltas) {
      if (typeof rawDelta !== "object" || rawDelta === null) continue;
      const kind: unknown = Reflect.get(rawDelta, "kind");
      if (kind === "session.reset") {
        openWorkByThread.delete(threadId);
        continue;
      }
      if (
        kind !== "item.open" &&
        kind !== "item.progress" &&
        kind !== "item.close"
      ) {
        continue;
      }
      const keyResult = deltaItemKeySchema.safeParse(
        Reflect.get(rawDelta, "key"),
      );
      if (!keyResult.success) continue;
      const keyStr = formatDeltaItemKey(keyResult.data);
      if (kind === "item.close") {
        setThreadOpenWorkItem(threadId, keyStr, null);
        continue;
      }
      if (kind === "item.open") {
        const itemResult = backgroundScopedDeltaItemShapeSchema.safeParse(
          Reflect.get(rawDelta, "item"),
        );
        if (!itemResult.success || !isOpenBackgroundItem(itemResult.data)) {
          setThreadOpenWorkItem(threadId, keyStr, null);
          continue;
        }
        const presentationResult = deltaPresentationSchema.safeParse(
          Reflect.get(rawDelta, "presentation"),
        );
        setThreadOpenWorkItem(threadId, keyStr, {
          key: keyResult.data,
          item: itemResult.data,
          ...(presentationResult.success
            ? { presentation: presentationResult.data }
            : {}),
        });
        continue;
      }
      const rawSnapshot: unknown = Reflect.get(rawDelta, "snapshot");
      if (rawSnapshot === undefined) continue;
      const snapshotResult =
        backgroundScopedDeltaItemShapeSchema.safeParse(rawSnapshot);
      if (!snapshotResult.success) continue;
      if (!isOpenBackgroundItem(snapshotResult.data)) {
        setThreadOpenWorkItem(threadId, keyStr, null);
        continue;
      }
      const previous = openWorkByThread.get(threadId)?.get(keyStr);
      setThreadOpenWorkItem(threadId, keyStr, {
        key: keyResult.data,
        item: snapshotResult.data,
        ...(previous?.presentation !== undefined
          ? { presentation: previous.presentation }
          : {}),
      });
    }
    return line;
  }

  function snapshotOpenWork(): BridgeOpenWorkSnapshot["threads"] {
    const threads = Object.create(null) as BridgeOpenWorkSnapshot["threads"];
    for (const [threadId, items] of openWorkByThread) {
      if (items.size > 0) {
        threads[threadId] = [...items.values()];
      }
    }
    return threads;
  }

  function clearReattachTimer(): void {
    if (reattachTimer === null) return;
    clearTimeout(reattachTimer);
    reattachTimer = null;
  }

  function armReattachTimer(): void {
    clearReattachTimer();
    reattachTimer = setTimeout(() => {
      reattachTimer = null;
      shutdown("abandoned");
    }, args.reattachTtlMs);
  }

  function shutdown(reason: BridgeSocketShutdownReason): void {
    if (closed) return;
    const onShutdown = listenArgs?.onShutdown;
    close();
    onShutdown?.(reason);
  }

  function updateBackpressure(): void {
    const retained = buffer.retainedBytes();
    const attached = current !== null && !closed;
    if (!paused && attached && retained > args.hardCapBytes) {
      paused = true;
      args.onBackpressure(true, retained);
    } else if (paused && (!attached || retained <= args.memoryCapBytes)) {
      paused = false;
      args.onBackpressure(false, retained);
    }
  }

  function handleControl(socket: Socket, message: BridgeControlMessage): void {
    if (message.kind === "shutdown") {
      shutdown("requested");
      return;
    }
    if (message.kind === "ack") {
      kept = message.keep;
      buffer.ackThrough(message.through, kept);
      updateBackpressure();
      return;
    }
    buffer.ackThrough(message.afterWseq, kept);
    for (const frame of buffer.framesAfter(message.afterWseq, kept)) {
      socket.write(frame.bytes);
    }
    if (message.reportOpenWork) {
      socket.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: BRIDGE_OPEN_WORK_METHOD,
          params: { threads: snapshotOpenWork() },
        })}\n`,
      );
    }
    resumed = true;
    updateBackpressure();
  }

  function attach(socket: Socket): void {
    if (closed || listenArgs === null) {
      socket.destroy();
      return;
    }
    const previous = current;
    current = socket;
    resumed = false;
    clearReattachTimer();
    previous?.destroy();
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (current !== socket) return;
      current = null;
      resumed = false;
      updateBackpressure();
      if (!closed) armReattachTimer();
    });
    const handlers = listenArgs;
    readBoundedLines({
      input: socket,
      onLine: (line) => {
        if (current !== socket) return;
        const control = parseBridgeControlMessage(line);
        if (control !== null) {
          handleControl(socket, control);
          return;
        }
        handlers.onLine(rewriteInboundLine(line));
      },
      onOverflow: args.onOverflow,
    });
  }

  function appendLine(line: string): void {
    const outboundLine = rewriteAndObserveOutboundLine(line);
    const wseq = nextWseq;
    nextWseq += 1;
    const bytes = encodeBridgeFrame(wseq, outboundLine);
    buffer.append({ wseq, bytes });
    if (current !== null && resumed && current.writable) {
      current.write(bytes);
    }
  }

  function write(
    chunk: string | Uint8Array,
    callback?: (error?: Error) => void,
  ): void {
    const text =
      typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) break;
      appendLine(partialLine + text.slice(start, newline));
      partialLine = "";
      start = newline + 1;
    }
    partialLine += text.slice(start);
    updateBackpressure();
    if (callback !== undefined) queueMicrotask(() => callback());
  }

  function listen(handlers: BridgeSocketListenArgs): Promise<void> {
    listenArgs = handlers;
    const listening = createServer(attach);
    server = listening;
    return new Promise<void>((resolve, reject) => {
      listening.once("error", reject);
      listening.listen(args.socketPath, () => {
        listening.off("error", reject);
        try {
          chmodSync(args.socketPath, 0o600);
        } catch {}
        if (current === null) armReattachTimer();
        resolve();
      });
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    clearReattachTimer();
    current?.destroy();
    current = null;
    updateBackpressure();
    buffer.dispose();
    const listening = server;
    server = null;
    if (listening !== null) {
      listening.close();
      removeSocketFile(args.socketPath);
    }
  }

  return { write, listen, close, replayStats: () => buffer.stats() };
}

function removeSocketFile(socketPath: string): void {
  if (process.platform === "win32") return;
  try {
    unlinkSync(socketPath);
  } catch {}
}
