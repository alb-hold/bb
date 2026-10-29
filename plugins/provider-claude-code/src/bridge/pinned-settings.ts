import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, Settings } from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_SETTINGS_ENV_PIN = "BB_CLAUDE_SETTINGS_ENV_PIN";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PIN_DIRECTORY_PREFIX = "bb-claude-flag-settings-";
const liveDirectories = new Set<string>();
let exitCleanupRegistered = false;

export interface PinnedLaunchOptions {
  options: Options;
  release(): void;
}

export function selectPinnedSettingsEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> | null {
  const listed = env[CLAUDE_SETTINGS_ENV_PIN];
  if (listed === undefined) return null;
  const pins: Record<string, string> = {};
  for (const entry of listed.split(",")) {
    const name = entry.trim();
    if (!ENV_NAME.test(name) || name === CLAUDE_SETTINGS_ENV_PIN) continue;
    pins[name] = env[name] ?? "";
  }
  return Object.keys(pins).length === 0 ? null : pins;
}

function removeDirectory(directory: string): void {
  liveDirectories.delete(directory);
  rmSync(directory, { force: true, recursive: true });
}

function registerExitCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.once("exit", () => {
    for (const directory of [...liveDirectories]) removeDirectory(directory);
  });
}

function withDefaultFailIfUnavailable(
  sandbox: NonNullable<Options["sandbox"]>,
): NonNullable<Options["sandbox"]> {
  return sandbox.enabled === true && sandbox.failIfUnavailable === undefined
    ? { ...sandbox, failIfUnavailable: true }
    : sandbox;
}

export function applyPinnedSettings(options: Options): PinnedLaunchOptions {
  const pins = selectPinnedSettingsEnv(options.env ?? process.env);
  if (pins === null) return { options, release: () => {} };
  const { sandbox, ...rest } = options;
  const base: Settings =
    typeof options.settings === "object" ? options.settings : {};
  const contents: Settings = {
    ...base,
    ...(sandbox ? { sandbox: withDefaultFailIfUnavailable(sandbox) } : {}),
    apiKeyHelper: "",
    env: { ...base.env, ...pins },
  };
  const directory = mkdtempSync(join(tmpdir(), PIN_DIRECTORY_PREFIX));
  liveDirectories.add(directory);
  registerExitCleanup();
  try {
    const file = join(directory, "settings.json");
    writeFileSync(file, JSON.stringify(contents), { flag: "wx", mode: 0o600 });
    return {
      options: { ...rest, settings: file },
      release: () => removeDirectory(directory),
    };
  } catch (error) {
    removeDirectory(directory);
    throw error;
  }
}
