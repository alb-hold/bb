import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  APP_LAUNCH_CANCEL_FILE_ENV,
  APP_LAUNCH_LOG_ENV,
  APP_LAUNCH_PID_FILE_ENV,
  APP_LAUNCH_SHELL_ENV_FILE_ENV,
  type AppLaunchDeps,
  type AppLaunchFallbackReason,
  shellEnvironmentContent,
  startAppLaunch,
  uniqueEnvironmentFilePath,
} from "@bb/process-utils";

const BUNDLE_NAME = "bb-bridge-worker.app";
const BUNDLE_ID = "dev.bb.bridge-worker";
export const BRIDGE_WORKER_APP_FALLBACK_WINDOW_MS = 8_000;
export const BRIDGE_WORKER_APP_CLAIMED_WAIT_MS = 60_000;
const PID_POLL_MS = 25;

export interface BridgeWorkerAppLaunch {
  pidFile: string;
  cancelFile: string;
}

export type BridgeWorkerAppResult =
  | ({ ok: true } & BridgeWorkerAppLaunch)
  | { ok: false; reason: AppLaunchFallbackReason; errorName: string | null };

export function bridgeWorkerPidFilePath(workerDir: string, id: string): string {
  return join(workerDir, `${id}.pid`);
}

export function startBridgeWorkerAsApp(
  request: {
    workerDir: string;
    id: string;
    logPath: string;
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
  deps: AppLaunchDeps,
): BridgeWorkerAppResult {
  if (deps.platform !== "darwin") {
    return { ok: false, reason: "not-darwin", errorName: null };
  }
  const pidFile = bridgeWorkerPidFilePath(request.workerDir, request.id);
  const cancelFile = `${pidFile}.cancel`;
  try {
    closeSync(openSync(request.logPath, "a", 0o600));
  } catch {}
  const result = startAppLaunch(
    {
      bundleName: BUNDLE_NAME,
      bundleId: BUNDLE_ID,
      directory: request.workerDir,
      argv: [request.command, ...request.args],
      cwd: request.cwd,
      environmentFile: {
        path: uniqueEnvironmentFilePath(join(request.workerDir, request.id)),
        content: shellEnvironmentContent(request.env),
      },
      environmentFileVariable: APP_LAUNCH_SHELL_ENV_FILE_ENV,
      extraEnvironment: {
        [APP_LAUNCH_PID_FILE_ENV]: pidFile,
        [APP_LAUNCH_LOG_ENV]: request.logPath,
        [APP_LAUNCH_CANCEL_FILE_ENV]: cancelFile,
      },
    },
    deps,
  );
  return result.ok
    ? { ok: true, pidFile, cancelFile }
    : { ok: false, reason: result.reason, errorName: result.errorName };
}

export function cancelBridgeWorkerAppLaunch(
  launch: BridgeWorkerAppLaunch,
): boolean {
  try {
    mkdirSync(launch.cancelFile, { mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

export function removeBridgeWorkerAppFiles(launch: BridgeWorkerAppLaunch): void {
  for (const file of [launch.pidFile, `${launch.pidFile}.tmp`]) {
    try {
      unlinkSync(file);
    } catch {}
  }
  try {
    rmdirSync(launch.cancelFile);
  } catch {}
}

export async function waitForBridgeWorkerPid(
  pidFile: string,
  timeoutMs: number,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {}
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, PID_POLL_MS));
  }
}
