import { readFileSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import {
  type AppLaunchDeps,
  type AppLaunchFallbackReason,
  defaultAppLaunchDeps,
  jsonEnvironmentContent,
  startAppLaunch,
  uniqueEnvironmentFilePath,
} from "@bb/process-utils";

const BUNDLE_NAME = "bb-native-hold.app";
const BUNDLE_ID = "dev.bb.native-hold";
export const NATIVE_HOLDER_ENV_FILE_ENV = "BB_NATIVE_HOLD_ENV_FILE";

export interface NativeHolderLaunchRequest {
  argv: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  socketPath: string;
}

export type NativeHolderAppFallbackReason = AppLaunchFallbackReason;

export type NativeHolderAppResult =
  | { ok: true; environmentFile: string }
  | {
      ok: false;
      reason: NativeHolderAppFallbackReason;
      errorName: string | null;
    };

export type NativeHolderAppDeps = AppLaunchDeps;

export function defaultNativeHolderAppDeps(): NativeHolderAppDeps {
  return defaultAppLaunchDeps();
}

export function loadNativeHolderEnvironment(
  environment: NodeJS.ProcessEnv,
): void {
  const file = environment[NATIVE_HOLDER_ENV_FILE_ENV];
  if (file === undefined) return;
  let raw: string;
  try {
    const stat = statSync(file);
    const uid = process.getuid?.();
    if ((stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) {
      throw new Error("environment file is not private to this user");
    }
    raw = readFileSync(file, "utf8");
  } finally {
    try {
      unlinkSync(file);
    } catch {}
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("environment file is not an object");
  }
  const loaded: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error("environment file has a non-string value");
    }
    loaded[key] = value;
  }
  delete environment[NATIVE_HOLDER_ENV_FILE_ENV];
  Object.assign(environment, loaded);
}

export function startNativeHolderAsApp(
  request: NativeHolderLaunchRequest,
  deps: NativeHolderAppDeps,
): NativeHolderAppResult {
  return startAppLaunch(
    {
      bundleName: BUNDLE_NAME,
      bundleId: BUNDLE_ID,
      directory: path.dirname(request.socketPath),
      argv: request.argv,
      cwd: request.cwd,
      environmentFile: {
        path: uniqueEnvironmentFilePath(request.socketPath),
        content: jsonEnvironmentContent(request.environment),
      },
      environmentFileVariable: NATIVE_HOLDER_ENV_FILE_ENV,
      extraEnvironment: {},
    },
    deps,
  );
}
