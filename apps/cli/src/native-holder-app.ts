import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const BUNDLE_NAME = "bb-native-hold.app";
const BUNDLE_ID = "dev.bb.native-hold";
const HOLDER_CWD_ENV = "BB_NATIVE_HOLD_CWD";
const OPEN = "/usr/bin/open";
const CODESIGN = "/usr/bin/codesign";
const COMMAND_TIMEOUT_MS = 10_000;

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
): string[] {
  const args = ["-n", "-g", "-j", bundle];
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.environment)) {
    if (value !== undefined) environment[key] = value;
  }
  environment[HOLDER_CWD_ENV] = request.cwd;
  for (const [key, value] of Object.entries(environment)) {
    args.push("--env", `${key}=${value}`);
  }
  args.push("--args", ...request.argv);
  return args;
}

export function startNativeHolderAsApp(
  request: NativeHolderLaunchRequest,
  deps: NativeHolderAppDeps,
): boolean {
  if (deps.platform !== "darwin") return false;
  try {
    const bundle = ensureBundle(path.dirname(request.socketPath), deps);
    deps.run(OPEN, nativeHolderOpenArgs(bundle, request));
    return true;
  } catch {
    return false;
  }
}
