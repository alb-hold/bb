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

const BUNDLE_NAME = "bb-native-hold.app";
const BUNDLE_ID = "dev.bb.native-hold";
const HOLDER_CWD_ENV = "BB_NATIVE_HOLD_CWD";
export const NATIVE_HOLDER_ENV_FILE_ENV = "BB_NATIVE_HOLD_ENV_FILE";
const OPEN = "/usr/bin/open";
const CODESIGN = "/usr/bin/codesign";
const COMMAND_TIMEOUT_MS = 10_000;
const STALE_ENV_FILE_MS = 60_000;

const RUN_SCRIPT = `#!/bin/bash
cd "\${${HOLDER_CWD_ENV}:-/}" 2>/dev/null
unset ${HOLDER_CWD_ENV}
exec "$@" </dev/null >/dev/null 2>&1
`;

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>run</string>
<key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
<key>CFBundleName</key><string>bb-native-hold</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
`;

export interface NativeHolderLaunchRequest {
  argv: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  socketPath: string;
}

export type NativeHolderAppFallbackReason =
  | "not-darwin"
  | "bundle-failed"
  | "open-failed";

export type NativeHolderAppResult =
  | { ok: true; environmentFile: string }
  | {
      ok: false;
      reason: NativeHolderAppFallbackReason;
      errorName: string | null;
    };

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
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

export interface NativeHolderAppDeps {
  platform: NodeJS.Platform;
  run(command: string, args: string[]): void;
}

export function defaultNativeHolderAppDeps(): NativeHolderAppDeps {
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

function readIfPresent(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function ensureBundle(directory: string, deps: NativeHolderAppDeps): string {
  const bundle = path.join(directory, BUNDLE_NAME);
  const macos = path.join(bundle, "Contents", "MacOS");
  const run = path.join(macos, "run");
  const info = path.join(bundle, "Contents", "Info.plist");
  mkdirSync(macos, { recursive: true });
  const current =
    readIfPresent(run) === RUN_SCRIPT &&
    readIfPresent(info) === INFO_PLIST &&
    existsSync(path.join(bundle, "Contents", "_CodeSignature"));
  if (current) return bundle;
  writeFileSync(run, RUN_SCRIPT);
  writeFileSync(info, INFO_PLIST);
  chmodSync(run, 0o755);
  deps.run(CODESIGN, ["--force", "--sign", "-", bundle]);
  return bundle;
}

export function nativeHolderOpenArgs(
  bundle: string,
  request: NativeHolderLaunchRequest,
  environmentFile: string,
): string[] {
  return [
    "-n",
    "-g",
    "-j",
    bundle,
    "--env",
    `${NATIVE_HOLDER_ENV_FILE_ENV}=${environmentFile}`,
    "--env",
    `${HOLDER_CWD_ENV}=${request.cwd}`,
    "--args",
    ...request.argv,
  ];
}

function writeEnvironmentFile(request: NativeHolderLaunchRequest): string {
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.environment)) {
    if (value !== undefined) entries[key] = value;
  }
  const file = `${request.socketPath}.${randomUUID()}.env`;
  writeFileSync(file, JSON.stringify(entries), { flag: "wx", mode: 0o600 });
  return file;
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
  if (deps.platform !== "darwin") {
    return { ok: false, reason: "not-darwin", errorName: null };
  }
  const directory = path.dirname(request.socketPath);
  let bundle: string;
  try {
    bundle = ensureBundle(directory, deps);
  } catch (error) {
    return { ok: false, reason: "bundle-failed", errorName: errorNameOf(error) };
  }
  removeStaleEnvironmentFiles(directory);
  let environmentFile: string | null = null;
  try {
    environmentFile = writeEnvironmentFile(request);
    deps.run(OPEN, nativeHolderOpenArgs(bundle, request, environmentFile));
    return { ok: true, environmentFile };
  } catch (error) {
    if (environmentFile !== null) {
      try {
        unlinkSync(environmentFile);
      } catch {}
    }
    return { ok: false, reason: "open-failed", errorName: errorNameOf(error) };
  }
}
