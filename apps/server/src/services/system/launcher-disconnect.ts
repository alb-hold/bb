import { Worker } from "node:worker_threads";
import {
  SERVER_SHUTDOWN_BOUND_MS,
  SERVER_SHUTDOWN_SAFETY_MARGIN_MS,
} from "@bb/config/full-stack-shutdown";

export interface LauncherDisconnectPort {
  channel?: { unref(): void } | undefined;
  once(event: "disconnect", listener: () => void): unknown;
}

export interface LauncherDisconnectOptions {
  exit: (code: number) => never;
  log: (message: string) => void;
}

export interface LauncherDisconnectWatch {
  ready(): Promise<void>;
  setShutdown(args: {
    shutdown: () => Promise<void>;
    exit: (code: number) => never;
  }): void;
  stopStartupWatch(): void;
}

export function watchLauncherDisconnect(
  port: LauncherDisconnectPort,
  options?: LauncherDisconnectOptions,
): LauncherDisconnectWatch {
  let disconnected = false;
  let shutdown: (() => Promise<void>) | null = null;
  let exit: ((code: number) => never) | null = null;
  let startupDeadline: ReturnType<typeof setTimeout> | undefined;
  let pathLogged = false;
  const startupWorker =
    options !== undefined && port.channel !== undefined
      ? new Worker(
          `const { parentPort, workerData } = require("node:worker_threads");
const { readFileSync } = require("node:fs");
const pollMs = workerData.timeoutMs / 1_000;
const pause = new Int32Array(new SharedArrayBuffer(4));
let stopped = false;
const parentAlive = () => {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync("/proc/" + workerData.serverPid + "/stat", "utf8");
      return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === workerData.parentPid;
    }
    return process.ppid === workerData.parentPid;
  } catch { return false; }
};
parentPort.on("message", () => { stopped = true; });
while (!stopped && parentAlive()) Atomics.wait(pause, 0, 0, pollMs);
if (!stopped) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < workerData.timeoutMs - workerData.safetyMarginMs) Atomics.wait(pause, 0, 0, pollMs);
  if (!stopped) {
    process.stderr.write("Launcher disappeared during startup; terminating server at the shutdown bound\\n");
    process.kill(workerData.serverPid, "SIGKILL");
  }
}`,
          {
            eval: true,
            workerData: {
              parentPid: process.ppid,
              serverPid: process.pid,
              safetyMarginMs: SERVER_SHUTDOWN_SAFETY_MARGIN_MS,
              timeoutMs: SERVER_SHUTDOWN_BOUND_MS,
            },
          },
        )
      : undefined;
  const startupWatchReady =
    startupWorker === undefined
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          startupWorker.once("online", resolve);
          startupWorker.once("error", reject);
        });
  startupWorker?.on("error", (error) =>
    options?.log(`Launcher startup deadline worker failed: ${error.message}`),
  );
  startupWorker?.unref();

  const stopStartupTimer = (): void => {
    if (startupDeadline !== undefined) {
      clearTimeout(startupDeadline);
      startupDeadline = undefined;
    }
  };

  const stopStartupWatch = (): void => {
    stopStartupTimer();
    startupWorker?.postMessage("stop");
  };

  const logPath = (message: string): void => {
    if (pathLogged) return;
    pathLogged = true;
    options?.log(message);
  };

  const stop = (): void => {
    if (!disconnected || shutdown === null || exit === null) return;
    logPath("Launcher disconnected; running normal server shutdown");
    const runShutdown = shutdown;
    const exitProcess = exit;
    shutdown = null;
    exit = null;
    void runShutdown().finally(() => {
      stopStartupWatch();
      exitProcess(0);
    });
  };

  port.channel?.unref();
  port.once("disconnect", () => {
    disconnected = true;
    if (shutdown === null && options !== undefined) {
      startupDeadline = setTimeout(() => {
        if (shutdown !== null) return;
        logPath("Launcher disconnected during startup; exiting before shutdown registration");
        options.exit(1);
      }, SERVER_SHUTDOWN_BOUND_MS);
    }
    stop();
  });

  return {
    ready: () => startupWatchReady,
    setShutdown(args) {
      stopStartupTimer();
      stopStartupWatch();
      shutdown = args.shutdown;
      exit = args.exit;
      stop();
    },
    stopStartupWatch,
  };
}
