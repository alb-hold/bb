import { Buffer } from "node:buffer";
import { Worker } from "node:worker_threads";
import type {
  TerminalOutputResponse,
  TerminalScreenResponse,
} from "@bb/server-contract";
import { terminalScreenWorkerSource } from "../../generated/terminal-screen-worker.js";
import type { ServerLogger } from "../../types.js";
import type { renderTerminalScreenInline } from "./terminal-screen-render.js";

export const TERMINAL_SCREEN_MAX_LINES = 500;
export const TERMINAL_SCREEN_REPLAY_BYTES = 64 * 1024;
const TERMINAL_SCREEN_WORKER_TIMEOUT_MS = 30_000;
const TERMINAL_SCREEN_MAX_IN_FLIGHT_READS = 32;
type RenderArgs = Parameters<typeof renderTerminalScreenInline>[0];
type ScreenReadArgs = {
  cols: number;
  lines: number | undefined;
  output: TerminalOutputResponse;
  rows: number;
};
type WorkerResult = {
  id: number;
  result?: TerminalScreenResponse;
  error?: string;
};
type PendingRead = {
  id: number;
  args: ScreenReadArgs;
  resolve: (value: TerminalScreenResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  deadline: number;
  logger?: ServerLogger;
  worker?: Worker;
  workerFailures: number;
};

function isTerminalScreenResponse(
  value: unknown,
): value is TerminalScreenResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "rows" in value &&
    Array.isArray(value.rows) &&
    value.rows.every((row) => typeof row === "string") &&
    "cursor" in value &&
    typeof value.cursor === "object" &&
    value.cursor !== null &&
    "col" in value.cursor &&
    typeof value.cursor.col === "number" &&
    "row" in value.cursor &&
    typeof value.cursor.row === "number" &&
    "cols" in value &&
    typeof value.cols === "number" &&
    "gridRows" in value &&
    typeof value.gridRows === "number" &&
    "truncated" in value &&
    typeof value.truncated === "boolean" &&
    "complete" in value &&
    typeof value.complete === "boolean"
  );
}

function isWorkerResult(value: unknown): value is WorkerResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "number" &&
    (("error" in value && typeof value.error === "string") ||
      ("result" in value && isTerminalScreenResponse(value.result)))
  );
}

let worker: Worker | undefined;
let terminatingWorker: Worker | undefined;
let pending: PendingRead | undefined;
const queued: PendingRead[] = [];
let nextId = 1;

function removeQueued(read: PendingRead) {
  const index = queued.indexOf(read);
  if (index >= 0) queued.splice(index, 1);
}

function rejectRead(read: PendingRead, error: Error) {
  if (pending === read) pending = undefined;
  else removeQueued(read);
  clearTimeout(read.timeout);
  read.reject(error);
}

function retryOrRejectWorkerRead(read: PendingRead, error: Error) {
  if (Date.now() >= read.deadline) {
    rejectRead(
      read,
      new Error("Terminal screen read timed out after 30 seconds"),
    );
    return;
  }
  if (read.workerFailures >= 1) {
    rejectRead(
      read,
      new Error(`Terminal screen renderer crashed twice: ${error.message}`),
    );
    return;
  }
  read.workerFailures += 1;
  read.worker = undefined;
  if (pending === read) pending = undefined;
  queued.unshift(read);
}

function terminateWorker(current: Worker, error: Error) {
  if (worker === current) worker = undefined;
  terminatingWorker = current;
  const active = pending;
  if (active?.worker === current) retryOrRejectWorkerRead(active, error);
  void current.terminate();
}

function logWorkerFailure(error: Error) {
  const logger = pending?.logger;
  if (logger) logger.error({ err: error }, "Terminal screen worker failed");
  else console.error("Terminal screen worker failed", error);
}

function getWorker() {
  if (worker) return worker;
  const current = new Worker(terminalScreenWorkerSource, {
    eval: true,
    execArgv: [],
  });
  worker = current;
  current.unref();
  current.on("message", (value: unknown) => {
    if (!isWorkerResult(value)) {
      const error = new Error(
        "Terminal screen worker returned an invalid response",
      );
      logWorkerFailure(error);
      terminateWorker(current, error);
      return;
    }
    const message = value;
    const active = pending;
    if (!active || active.worker !== current || message.id !== active.id)
      return;
    pending = undefined;
    clearTimeout(active.timeout);
    current.unref();
    if (message.error !== undefined) active.reject(new Error(message.error));
    else if (message.result) active.resolve(message.result);
    else active.reject(new Error("Terminal screen worker returned no result"));
    dispatchNext();
  });
  let failureReported = false;
  current.on("error", (error) => {
    failureReported = true;
    logWorkerFailure(error);
    terminateWorker(current, error);
  });
  current.on("exit", (code) => {
    if (worker === current) worker = undefined;
    if (terminatingWorker === current) terminatingWorker = undefined;
    const active = pending;
    if (active?.worker === current) {
      const error = new Error(`Terminal screen worker exited (${code})`);
      if (!failureReported) logWorkerFailure(error);
      retryOrRejectWorkerRead(active, error);
    }
    dispatchNext();
  });
  return current;
}

function workerArgs(read: PendingRead) {
  const { output, ...renderArgs } = read.args;
  const data = Buffer.concat(
    output.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
  );
  const transferable =
    data.buffer instanceof ArrayBuffer &&
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength
      ? data.buffer
      : Uint8Array.from(data).buffer;
  return {
    ...renderArgs,
    output: { data: transferable, truncated: output.truncated },
  } satisfies RenderArgs;
}

function dispatchNext() {
  if (pending || terminatingWorker) return;
  while (queued.length > 0) {
    const next = queued.shift();
    if (!next) return;
    if (Date.now() >= next.deadline) {
      clearTimeout(next.timeout);
      next.reject(new Error("Terminal screen read timed out after 30 seconds"));
      continue;
    }
    let current: Worker;
    try {
      current = getWorker();
    } catch (error) {
      clearTimeout(next.timeout);
      next.reject(error instanceof Error ? error : new Error(String(error)));
      continue;
    }
    next.worker = current;
    pending = next;
    current.ref();
    try {
      const args = workerArgs(next);
      current.postMessage({ id: next.id, args }, [args.output.data]);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      rejectRead(next, failure);
      terminateWorker(current, failure);
    }
    return;
  }
}

function timeoutRead(read: PendingRead) {
  const error = new Error("Terminal screen read timed out after 30 seconds");
  read.logger?.error({ err: error }, "Terminal screen read timed out");
  const current = read.worker;
  if (pending === read) {
    rejectRead(read, error);
    if (current) terminateWorker(current, error);
  } else if (queued.includes(read)) {
    rejectRead(read, error);
  }
}

export function renderTerminalScreen(args: {
  cols: number;
  lines: number | undefined;
  output: TerminalOutputResponse;
  rows: number;
  logger?: ServerLogger;
}): Promise<TerminalScreenResponse> {
  if (
    queued.length + (pending ? 1 : 0) >=
    TERMINAL_SCREEN_MAX_IN_FLIGHT_READS
  ) {
    return Promise.reject(
      new Error(
        `Terminal screen read queue is full (maximum ${TERMINAL_SCREEN_MAX_IN_FLIGHT_READS} in flight)`,
      ),
    );
  }
  const { logger, ...readArgs } = args;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const read = {
      id,
      args: readArgs,
      resolve,
      reject,
      timeout: setTimeout(
        () => timeoutRead(read),
        TERMINAL_SCREEN_WORKER_TIMEOUT_MS,
      ),
      deadline: Date.now() + TERMINAL_SCREEN_WORKER_TIMEOUT_MS,
      ...(logger === undefined ? {} : { logger }),
      workerFailures: 0,
    } satisfies PendingRead;
    queued.push(read);
    dispatchNext();
  });
}
