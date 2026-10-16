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
  let parentLossHandled = false;
  const launcherPid = process.ppid;
  const parentWatch =
    options !== undefined && port.channel !== undefined
      ? new Worker(
          `const { parentPort, workerData } = require("node:worker_threads");
const { readFileSync } = require("node:fs");
const pollMs = workerData.pollMs;
const pause = new Int32Array(new SharedArrayBuffer(4));
let stopped = false;
const parentGone = () => {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync("/proc/" + workerData.serverPid + "/stat", "utf8");
      if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) !== workerData.parentPid) return true;
    } catch { return true; }
  }
  try {
    process.kill(workerData.parentPid, 0);
    return false;
  } catch (error) {
    return error && error.code === "ESRCH";
  }
};
parentPort.on("message", () => { stopped = true; });
while (!stopped && !parentGone()) Atomics.wait(pause, 0, 0, pollMs);
if (!stopped) {
  parentPort.postMessage("parent-gone");
  const startedAt = Date.now();
  while (!stopped && Date.now() - startedAt < workerData.timeoutMs - workerData.safetyMarginMs * 3) Atomics.wait(pause, 0, 0, pollMs);
  if (!stopped) {
    process.stderr.write("Launcher disappeared; terminating server at the shutdown bound\\n");
    process.kill(workerData.serverPid, "SIGKILL");
  }
}`,
          {
            eval: true,
            workerData: {
              parentPid: launcherPid,
              pollMs: SERVER_SHUTDOWN_SAFETY_MARGIN_MS,
              safetyMarginMs: SERVER_SHUTDOWN_SAFETY_MARGIN_MS,
              serverPid: process.pid,
              timeoutMs: SERVER_SHUTDOWN_BOUND_MS,
            },
          },
        )
      : undefined;
  const parentWatchReady =
    parentWatch === undefined
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          parentWatch.once("online", resolve);
          parentWatch.once("error", reject);
        });
  parentWatch?.on("error", (error) =>
    options?.log(`Launcher parent watcher failed: ${error.message}`),
  );
  parentWatch?.unref();

  const stopStartupTimer = (): void => {
    if (startupDeadline !== undefined) {
      clearTimeout(startupDeadline);
      startupDeadline = undefined;
    }
  };

  const stopStartupWatch = (): void => {
    stopStartupTimer();
    parentWatch?.postMessage("stop");
  };

  const logPath = (message: string): void => {
    if (pathLogged) return;
    pathLogged = true;
    options?.log(message);
  };

  const stop = (): void => {
    if (!disconnected || shutdown === null || exit === null || parentLossHandled) return;
    parentLossHandled = true;
    logPath("Launcher parent disappeared; running normal server shutdown");
    const runShutdown = shutdown;
    const exitProcess = exit;
    shutdown = null;
    exit = null;
    void runShutdown().finally(() => {
      stopStartupWatch();
      exitProcess(0);
    });
  };

  const parentIsAlive = (): boolean => {
    if (process.ppid !== launcherPid) return false;
    try {
      process.kill(launcherPid, 0);
      return true;
    } catch (error) {
      return !(error instanceof Error && "code" in error && error.code === "ESRCH");
    }
  };

  const handleConfirmedParentLoss = (): void => {
    disconnected = true;
    if (shutdown === null && options !== undefined && startupDeadline === undefined) {
      startupDeadline = setTimeout(() => {
        if (shutdown !== null || parentIsAlive()) return;
        logPath("Launcher disappeared during startup; exiting before shutdown registration");
        options.exit(1);
      }, SERVER_SHUTDOWN_BOUND_MS);
    }
    stop();
  };

  parentWatch?.on("message", (message: unknown) => {
    if (message === "parent-gone") handleConfirmedParentLoss();
  });

  port.channel?.unref();
  port.once("disconnect", () => {
    if (parentIsAlive()) {
      options?.log("Launcher IPC disconnected while parent is alive (reason ipc-disconnect-parent-alive)");
      return;
    }
    handleConfirmedParentLoss();
  });

  return {
    ready: () => parentWatchReady,
    setShutdown(args) {
      stopStartupTimer();
      shutdown = args.shutdown;
      exit = args.exit;
      stop();
    },
    stopStartupWatch,
  };
}
