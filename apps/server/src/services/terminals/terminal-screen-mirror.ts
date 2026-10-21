import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { terminalScreenMirrorWorkerSource } from "./terminal-screen-mirror-worker-source.js";
import { TERMINAL_SCREEN_MAX_LINES } from "./terminal-screen.js";

const MAX_QUEUED_BYTES_PER_SESSION = 16 * 1024 * 1024;
const MAX_QUEUED_BYTES_TOTAL = 64 * 1024 * 1024;

type MirrorScreen = {
  baseY: number;
  bufferRows: string[];
  cols: number;
  cursor: { col: number; row: number };
  gridRows: number;
};

type WorkerMessage =
  | {
      bytes: number;
      generation: number;
      seq: number;
      sessionId: string;
      type: "written";
    }
  | {
      generation: number;
      requestId: number;
      screen: MirrorScreen | null;
      sessionId: string;
      type: "snapshot";
    };

type MirrorState = {
  available: boolean;
  cols: number;
  generation: number;
  lastSeq: number | null;
  pendingBytes: number;
  rows: number;
};

type PendingSnapshot = {
  generation: number;
  resolve: (value: MirrorScreen | null) => void;
  sessionId: string;
};

type MirrorWorkerFactory = () => Worker;

const require = createRequire(import.meta.url);

function transferableBytes(data: Uint8Array): ArrayBuffer {
  const exact = new Uint8Array(data.byteLength);
  exact.set(data);
  return exact.buffer;
}

function resetOffset(data: Uint8Array): number {
  for (let index = 0; index + 1 < data.length; index += 1) {
    if (data[index] === 0x1b && data[index + 1] === 0x63) return index;
  }
  return -1;
}

export class TerminalScreenMirror {
  private readonly generations = new Map<string, number>();
  private readonly pendingSnapshots = new Map<number, PendingSnapshot>();
  private readonly sessions = new Map<string, MirrorState>();
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private queuedBytes = 0;
  private stopping = false;

  constructor(
    private readonly log: (error: unknown, message: string) => void,
    private readonly workerFactory: MirrorWorkerFactory = () =>
      new Worker(terminalScreenMirrorWorkerSource, {
        eval: true,
        workerData: {
          headlessPath: require.resolve("@xterm/headless"),
          scrollback: TERMINAL_SCREEN_MAX_LINES,
          unicodeAddonPath: require.resolve("@xterm/addon-unicode11"),
        },
      }),
  ) {}

  start(sessionId: string, cols: number, rows: number): number {
    this.dispose(sessionId);
    const generation = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, generation);
    const state: MirrorState = {
      available: true,
      cols,
      generation,
      lastSeq: -1,
      pendingBytes: 0,
      rows,
    };
    this.sessions.set(sessionId, state);
    this.ensureWorker()?.postMessage({
      cols,
      generation,
      rows,
      sessionId,
      type: "start",
    });
    return generation;
  }

  write(sessionId: string, seq: number, data: Uint8Array): void {
    const state = this.sessions.get(sessionId);
    if (!state || this.stopping) return;
    const offset = resetOffset(data);
    if (!state.available) {
      if (offset < 0) return;
      const suffix = transferableBytes(data.subarray(offset));
      state.available = true;
      state.pendingBytes = suffix.byteLength;
      this.queuedBytes += suffix.byteLength;
      state.lastSeq = seq;
      const worker = this.ensureWorker();
      if (!worker) {
        this.markUnavailable(sessionId, state);
        return;
      }
      worker.postMessage(
        {
          cols: state.cols,
          data: suffix,
          generation: state.generation,
          rows: state.rows,
          seq,
          sessionId,
          type: "reset",
        },
        [suffix],
      );
      return;
    }
    if (state.lastSeq !== null && seq <= state.lastSeq) return;
    if (state.lastSeq !== null && seq !== state.lastSeq + 1) {
      this.markUnavailable(sessionId, state);
      if (offset >= 0) this.write(sessionId, seq, data);
      return;
    }
    let payload = data;
    let reset = false;
    if (
      state.pendingBytes + payload.byteLength > MAX_QUEUED_BYTES_PER_SESSION ||
      this.queuedBytes + payload.byteLength > MAX_QUEUED_BYTES_TOTAL
    ) {
      this.markUnavailable(sessionId, state);
      if (offset < 0) return;
      payload = data.subarray(offset);
      reset = true;
    }
    const buffer = transferableBytes(payload);
    state.available = true;
    state.pendingBytes += buffer.byteLength;
    this.queuedBytes += buffer.byteLength;
    state.lastSeq = seq;
    const worker = this.ensureWorker();
    if (!worker) {
      this.markUnavailable(sessionId, state);
      return;
    }
    worker.postMessage(
      reset
        ? {
            cols: state.cols,
            data: buffer,
            generation: state.generation,
            rows: state.rows,
            seq,
            sessionId,
            type: "reset",
          }
        : {
            data: buffer,
            generation: state.generation,
            seq,
            sessionId,
            type: "write",
          },
      [buffer],
    );
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.cols = cols;
    state.rows = rows;
    if (!state.available) return;
    this.worker?.postMessage({
      cols,
      generation: state.generation,
      rows,
      sessionId,
      type: "resize",
    });
  }

  async snapshot(sessionId: string): Promise<MirrorScreen | null> {
    const state = this.sessions.get(sessionId);
    if (!state?.available || this.stopping) return null;
    const worker = this.ensureWorker();
    if (!worker) return null;
    worker.ref();
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      this.pendingSnapshots.set(requestId, {
        generation: state.generation,
        resolve,
        sessionId,
      });
      worker.postMessage({
        generation: state.generation,
        requestId,
        sessionId,
        type: "snapshot",
      });
    });
  }

  dispose(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.sessions.delete(sessionId);
    this.generations.set(sessionId, state.generation + 1);
    this.queuedBytes = Math.max(0, this.queuedBytes - state.pendingBytes);
    this.worker?.postMessage({
      generation: state.generation,
      sessionId,
      type: "dispose",
    });
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const sessionId of this.sessions.keys()) this.dispose(sessionId);
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
    for (const [requestId, pending] of this.pendingSnapshots) {
      this.pendingSnapshots.delete(requestId);
      pending.resolve(null);
    }
  }

  private markUnavailable(sessionId: string, state: MirrorState): void {
    if (!state.available) return;
    state.available = false;
    this.queuedBytes = Math.max(0, this.queuedBytes - state.pendingBytes);
    state.pendingBytes = 0;
    this.worker?.postMessage({
      generation: state.generation,
      sessionId,
      type: "dispose",
    });
    for (const [requestId, pending] of this.pendingSnapshots) {
      if (pending.sessionId !== sessionId) continue;
      this.pendingSnapshots.delete(requestId);
      pending.resolve(null);
    }
  }

  private ensureWorker(): Worker | null {
    if (this.stopping) return null;
    if (this.worker) return this.worker;
    try {
      const worker = this.workerFactory();
      this.worker = worker;
      worker.unref();
      worker.on("message", (value: unknown) => this.handleMessage(value));
      worker.on("error", (error) => this.handleWorkerFailure(worker, error));
      worker.on("exit", (code) => {
        if (!this.stopping)
          this.handleWorkerFailure(worker, new Error(`screen mirror worker exited with code ${code}`));
      });
      return worker;
    } catch (error) {
      this.log(error, "Unable to start terminal screen mirror worker");
      return null;
    }
  }

  private handleMessage(value: unknown): void {
    if (typeof value !== "object" || value === null || !("type" in value))
      return;
    const message = value as WorkerMessage;
    if (message.type === "written") {
      const state = this.sessions.get(message.sessionId);
      if (!state || state.generation !== message.generation) return;
      const acknowledged = Math.min(state.pendingBytes, message.bytes);
      state.pendingBytes -= acknowledged;
      this.queuedBytes = Math.max(0, this.queuedBytes - acknowledged);
      return;
    }
    const pending = this.pendingSnapshots.get(message.requestId);
    if (!pending) return;
    this.pendingSnapshots.delete(message.requestId);
    const state = this.sessions.get(message.sessionId);
    pending.resolve(
      state?.available &&
        state.generation === message.generation &&
        pending.generation === message.generation
        ? message.screen
        : null,
    );
    if (this.pendingSnapshots.size === 0) this.worker?.unref();
  }

  private handleWorkerFailure(worker: Worker, error: unknown): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.log(error, "Terminal screen mirror worker failed; using retained-output replay");
    for (const [sessionId, state] of this.sessions) {
      state.available = false;
      this.queuedBytes = Math.max(0, this.queuedBytes - state.pendingBytes);
      state.pendingBytes = 0;
      state.generation += 1;
      this.generations.set(sessionId, state.generation);
    }
    for (const [requestId, pending] of this.pendingSnapshots) {
      this.pendingSnapshots.delete(requestId);
      pending.resolve(null);
    }
  }
}
