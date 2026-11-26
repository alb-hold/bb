import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const APP_LAUNCH_RESERVED_PREFIX = "BB_APP_LAUNCH_";
export const APP_LAUNCH_CWD_ENV ="BB_APP_LAUNCH_CWD";
export const APP_LAUNCH_PID_FILE_ENV = "BB_APP_LAUNCH_PID_FILE";
export const APP_LAUNCH_LOG_ENV = "BB_APP_LAUNCH_LOG";
export const APP_LAUNCH_SHELL_ENV_FILE_ENV = "BB_APP_LAUNCH_SHELL_ENV_FILE";
export const APP_LAUNCH_CANCEL_FILE_ENV = "BB_APP_LAUNCH_CANCEL_FILE";

const OPEN = "/usr/bin/open";
const CODESIGN = "/usr/bin/codesign";
const COMMAND_TIMEOUT_MS = 10_000;
const STALE_ENV_FILE_MS = 60_000;

const RUN_SCRIPT = `#!/bin/bash
if [ -n "\${${APP_LAUNCH_CANCEL_FILE_ENV}:-}" ]; then
  mkdir "\$${APP_LAUNCH_CANCEL_FILE_ENV}" 2>/dev/null || exit 0
fi
if [ -n "\${${APP_LAUNCH_SHELL_ENV_FILE_ENV}:-}" ]; then
  __bb_env_file="\$${APP_LAUNCH_SHELL_ENV_FILE_ENV}"
  set -a
  . "\$__bb_env_file"
  set +a
  rm -f "\$__bb_env_file"
  unset __bb_env_file ${APP_LAUNCH_SHELL_ENV_FILE_ENV}
fi
cd "\${${APP_LAUNCH_CWD_ENV}:-/}" 2>/dev/null
unset ${APP_LAUNCH_CWD_ENV}
if [ -n "\${${APP_LAUNCH_PID_FILE_ENV}:-}" ]; then
  echo $$ > "\$${APP_LAUNCH_PID_FILE_ENV}.tmp" && mv "\$${APP_LAUNCH_PID_FILE_ENV}.tmp" "\$${APP_LAUNCH_PID_FILE_ENV}"
  unset ${APP_LAUNCH_PID_FILE_ENV}
fi
if [ -n "\${${APP_LAUNCH_LOG_ENV}:-}" ]; then
  __bb_log="\$${APP_LAUNCH_LOG_ENV}"
  unset ${APP_LAUNCH_LOG_ENV}
  exec "$@" </dev/null >>"\$__bb_log" 2>&1
fi
exec "$@" </dev/null >/dev/null 2>&1
`;

function infoPlist(bundleId: string, bundleName: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>run</string>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>${bundleName}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
`;
}

export type AppLaunchFallbackReason =
  | "not-darwin"
  | "bundle-failed"
  | "open-failed";

export interface AppLaunchDeps {
  platform: NodeJS.Platform;
  run(command: string, args: string[]): void;
}

export function defaultAppLaunchDeps(): AppLaunchDeps {
  return {
    platform: process.platform,
    run: (command, args) => {
      execFileSync(command, args, {
        stdio: "ignore",
        timeout: COMMAND_TIMEOUT_MS,
      });
    },
  };
}

export interface AppLaunchRequest {
  bundleName: string;
  bundleId: string;
  directory: string;
  argv: string[];
  cwd: string;
  environmentFile: { path: string; content: string };
  environmentFileVariable: string;
  extraEnvironment: Record<string, string>;
}

export type AppLaunchResult =
  | { ok: true; environmentFile: string }
  | { ok: false; reason: AppLaunchFallbackReason; errorName: string | null };

export function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function readIfPresent(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function removeStaleEnvironmentFiles(directory: string): void {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_ENV_FILE_MS;
  for (const name of names) {
    if (!name.endsWith(".env")) continue;
    const file = path.join(directory, name);
    try {
      if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
    } catch {}
  }
}

function ensureBundle(request: AppLaunchRequest, deps: AppLaunchDeps): string {
  const bundle = path.join(request.directory, request.bundleName);
  const macos = path.join(bundle, "Contents", "MacOS");
  const run = path.join(macos, "run");
  const info = path.join(bundle, "Contents", "Info.plist");
  const plist = infoPlist(request.bundleId, request.bundleName);
  mkdirSync(macos, { recursive: true });
  const current =
    readIfPresent(run) === RUN_SCRIPT &&
    readIfPresent(info) === plist &&
    existsSync(path.join(bundle, "Contents", "_CodeSignature"));
  if (current) return bundle;
  writeFileSync(run, RUN_SCRIPT);
  writeFileSync(info, plist);
  chmodSync(run, 0o755);
  deps.run(CODESIGN, ["--force", "--sign", "-", bundle]);
  return bundle;
}

export function appLaunchOpenArgs(
  bundle: string,
  request: AppLaunchRequest,
): string[] {
  const environment: Record<string, string> = {
    [request.environmentFileVariable]: request.environmentFile.path,
    [APP_LAUNCH_CWD_ENV]: request.cwd,
    ...request.extraEnvironment,
  };
  return [
    "-n",
    "-g",
    "-j",
    bundle,
    ...Object.entries(environment).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]),
    "--args",
    ...request.argv,
  ];
}

export function shellEnvironmentContent(environment: NodeJS.ProcessEnv): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (key.startsWith(APP_LAUNCH_RESERVED_PREFIX)) continue;
    lines.push(`export ${key}='${value.replaceAll("'", `'\\''`)}'`);
  }
  return `${lines.join("\n")}\n`;
}

export function jsonEnvironmentContent(environment: NodeJS.ProcessEnv): string {
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || key.startsWith(APP_LAUNCH_RESERVED_PREFIX)) continue;
    entries[key] = value;
  }
  return JSON.stringify(entries);
}

export function uniqueEnvironmentFilePath(basePath: string): string {
  return `${basePath}.${randomUUID()}.env`;
}

export function startAppLaunch(
  request: AppLaunchRequest,
  deps: AppLaunchDeps,
): AppLaunchResult {
  if (deps.platform !== "darwin") {
    return { ok: false, reason: "not-darwin", errorName: null };
  }
  let bundle: string;
  try {
    bundle = ensureBundle(request, deps);
  } catch (error) {
    return {
      ok: false,
      reason: "bundle-failed",
      errorName: errorNameOf(error),
    };
  }
  removeStaleEnvironmentFiles(request.directory);
  let written = false;
  try {
    writeFileSync(request.environmentFile.path, request.environmentFile.content, {
      flag: "wx",
      mode: 0o600,
    });
    written = true;
    deps.run(OPEN, appLaunchOpenArgs(bundle, request));
    return { ok: true, environmentFile: request.environmentFile.path };
  } catch (error) {
    if (written) {
      try {
        unlinkSync(request.environmentFile.path);
      } catch {}
    }
    return { ok: false, reason: "open-failed", errorName: errorNameOf(error) };
  }
}
