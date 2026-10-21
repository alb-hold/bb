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
type RenderArgs = Parameters<typeof renderTerminalScreenInline>[0];
type WorkerResult = {
  id: number;
  result?: TerminalScreenResponse;
  error?: string;
};
type PendingRead = {
  id: number;
  resolve: (value: TerminalScreenResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  logger?: ServerLogger;
};

function isTerminalScreenResponse(value: unknown): value is TerminalScreenResponse {
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
let nextId = 1;

const workerExecArgv = process.execArgv.filter((arg, index, args) => {
  if (index > 0 && ["--import", "--loader", "--experimental-loader", "--input-type"].includes(args[index - 1]!)) return false;
  return !["--import", "--loader", "--experimental-loader", "--input-type"].some(
    (option) => arg === option || arg.startsWith(`${option}=`),
  );
});

function rejectPending(error: Error) {
  const active = pending;
  if (!active) return;
  pending = undefined;
  clearTimeout(active.timeout);
  active.reject(error);
}

function terminateWorker(current: Worker, error: Error) {
  if (worker === current) worker = undefined;
  terminatingWorker = current;
  rejectPending(error);
  void current.terminate();
}

function logWorkerFailure(error: Error) {
  const logger = pending?.logger;
  if (logger) logger.error({ err: error }, "Terminal screen worker failed");
  else console.error("Terminal screen worker failed", error);
}

function getWorker() {
  if (worker) return worker;
  if (terminatingWorker) throw new Error("Terminal screen worker is restarting");
  const current = new Worker(terminalScreenWorkerSource, {
    eval: true,
    execArgv: workerExecArgv,
  });
  worker = current;
  current.unref();
  current.on("message", (value: unknown) => {
    if (!isWorkerResult(value)) {
      const error = new Error("Terminal screen worker returned an invalid response");
      logWorkerFailure(error);
      terminateWorker(current, error);
      return;
    }
    const message = value;
    const active = pending;
    if (!active || message.id !== active.id) return;
    pending = undefined;
    clearTimeout(active.timeout);
    current.unref();
    if (message.error !== undefined) active.reject(new Error(message.error));
    else if (message.result) active.resolve(message.result);
    else active.reject(new Error("Terminal screen worker returned no result"));
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
    if (pending) {
      const error = new Error(`Terminal screen worker exited (${code})`);
      if (!failureReported) logWorkerFailure(error);
      rejectPending(error);
    }
  });
  return current;
}

void getWorker();

export function renderTerminalScreen(args: {
  cols: number;
  lines: number | undefined;
  output: TerminalOutputResponse;
  rows: number;
  logger?: ServerLogger;
}): Promise<TerminalScreenResponse> {
  if (pending) return Promise.reject(new Error("Terminal screen renderer is busy"));
  let current: Worker;
  try {
    current = getWorker();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  const { logger, output, ...renderArgs } = args;
  const data = Buffer.concat(
    output.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
  );
  const transferable =
    data.buffer instanceof ArrayBuffer &&
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength
      ? data.buffer
      : Uint8Array.from(data).buffer;
  const workerArgs = {
    ...renderArgs,
    output: { data: transferable, truncated: output.truncated },
  };
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (worker === current) worker = undefined;
      terminatingWorker = current;
      pending = undefined;
      const error = new Error("Terminal screen render timed out");
      logger?.error({ err: error }, "Terminal screen render timed out");
      reject(error);
      void current.terminate();
    }, TERMINAL_SCREEN_WORKER_TIMEOUT_MS);
    pending = { id, resolve, reject, timeout, logger };
    current.ref();
    try {
      current.postMessage({ id, args: workerArgs satisfies RenderArgs }, [transferable]);
    } catch (error) {
      pending = undefined;
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
      terminateWorker(current, error instanceof Error ? error : new Error(String(error)));
    }
  });
}
