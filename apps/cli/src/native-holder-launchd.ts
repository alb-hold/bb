import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const NATIVE_HOLDER_LAUNCHD_LABEL_ENV = "BB_NATIVE_HOLD_LAUNCHD_LABEL";

const LAUNCHD_LABEL_PREFIX = "dev.bb.native-hold.";
const LAUNCHCTL = "/bin/launchctl";
const LAUNCHCTL_TIMEOUT_MS = 10_000;

export interface NativeHolderLaunchRequest {
  argv: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  socketPath: string;
}

export interface NativeHolderLaunchdDeps {
  platform: NodeJS.Platform;
  uid: number;
  tmpDir: string;
  runLaunchctl(args: string[]): void;
  fireLaunchctl(args: string[]): void;
}

export function nativeHolderLaunchdLabel(socketPath: string): string {
  const base = path.basename(socketPath).replace(/\.sock$/u, "");
  return `${LAUNCHD_LABEL_PREFIX}${base.replace(/[^A-Za-z0-9._-]/gu, "_")}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function plistString(value: string): string {
  return `<string>${escapeXml(value)}</string>`;
}

export function nativeHolderLaunchdPlist(
  label: string,
  request: NativeHolderLaunchRequest,
): string {
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.environment)) {
    if (value !== undefined) entries[key] = value;
  }
  entries[NATIVE_HOLDER_LAUNCHD_LABEL_ENV] = label;
  const rendered = Object.entries(entries)
    .map(([key, value]) => `<key>${escapeXml(key)}</key>${plistString(value)}`)
    .join("");
  const args = request.argv.map(plistString).join("");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key>${plistString(label)}`,
    `<key>ProgramArguments</key><array>${args}</array>`,
    `<key>WorkingDirectory</key>${plistString(request.cwd)}`,
    `<key>EnvironmentVariables</key><dict>${rendered}</dict>`,
    "<key>RunAtLoad</key><true/>",
    "<key>KeepAlive</key><false/>",
    "<key>AbandonProcessGroup</key><true/>",
    `<key>StandardOutPath</key>${plistString("/dev/null")}`,
    `<key>StandardErrorPath</key>${plistString("/dev/null")}`,
    "</dict></plist>",
    "",
  ].join("\n");
}

export function defaultNativeHolderLaunchdDeps(): NativeHolderLaunchdDeps {
  return {
    platform: process.platform,
    uid: os.userInfo().uid,
    tmpDir: os.tmpdir(),
    runLaunchctl: (args) => {
      execFileSync(LAUNCHCTL, args, {
        stdio: "ignore",
        timeout: LAUNCHCTL_TIMEOUT_MS,
      });
    },
    fireLaunchctl: (args) => {
      spawn(LAUNCHCTL, args, { detached: true, stdio: "ignore" }).unref();
    },
  };
}

export function startNativeHolderInOwnCoalition(
  request: NativeHolderLaunchRequest,
  deps: NativeHolderLaunchdDeps,
): boolean {
  if (deps.platform !== "darwin") return false;
  const label = nativeHolderLaunchdLabel(request.socketPath);
  const domain = `gui/${deps.uid}`;
  const directory = mkdtempSync(path.join(deps.tmpDir, "bb-native-hold-"));
  const plistPath = path.join(directory, `${label}.plist`);
  try {
    writeFileSync(plistPath, nativeHolderLaunchdPlist(label, request), {
      mode: 0o600,
    });
    try {
      deps.runLaunchctl(["bootout", `${domain}/${label}`]);
    } catch {}
    deps.runLaunchctl(["bootstrap", domain, plistPath]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function removeNativeHolderLaunchdJob(
  environment: NodeJS.ProcessEnv,
  deps: NativeHolderLaunchdDeps,
): void {
  const label = environment[NATIVE_HOLDER_LAUNCHD_LABEL_ENV];
  if (deps.platform !== "darwin" || label === undefined || label === "") {
    return;
  }
  try {
    deps.fireLaunchctl(["bootout", `gui/${deps.uid}/${label}`]);
  } catch {}
}
