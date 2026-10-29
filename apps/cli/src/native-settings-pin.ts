import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderNativeTerminalActivity } from "@bb/domain";
import {
  nativeActivityHookSettings,
  nativeActivityHookSettingsObject,
} from "./native-activity.js";

export const CLAUDE_SETTINGS_ENV_PIN = "BB_CLAUDE_SETTINGS_ENV_PIN";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SETTINGS_TOKEN = "{settings}";
const PINNED_EXECUTABLE = "claude";

function takesSettings(arg: string): boolean {
  return arg.includes(SETTINGS_TOKEN);
}

type ActivityHooks = NonNullable<ProviderNativeTerminalActivity["hooks"]>;

export interface NativeSettings {
  directory: string | null;
  value: string;
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

function writePinnedSettingsFile(
  settings: Readonly<Record<string, unknown>>,
  pins: Readonly<Record<string, string>>,
): NativeSettings {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bb-native-settings-"));
  const file = path.join(directory, "settings.json");
  try {
    writeFileSync(
      file,
      JSON.stringify({ ...settings, apiKeyHelper: "", env: pins }),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
  return { directory, value: file };
}

export function prepareNativeSettings(args: {
  env: Readonly<Record<string, string | undefined>>;
  executable: string;
  hooks: ActivityHooks | undefined;
  hookTarget: string | { appendFile: string } | null;
}): NativeSettings | null {
  const { hooks, hookTarget } = args;
  const pins =
    args.executable === PINNED_EXECUTABLE
      ? selectPinnedSettingsEnv(args.env)
      : null;
  if (pins !== null) {
    if (hooks === undefined || !hooks.args.some(takesSettings)) {
      throw new Error(
        "A pooled Claude launch must carry its routing in --settings, but the native launch declaration has no {settings} argument. The launch was not started.",
      );
    }
    return writePinnedSettingsFile(
      hookTarget === null
        ? {}
        : nativeActivityHookSettingsObject(hooks, hookTarget),
      pins,
    );
  }
  if (hooks === undefined || hookTarget === null) return null;
  return {
    directory: null,
    value: nativeActivityHookSettings(hooks, hookTarget),
  };
}

export function removePinnedNativeSettings(directory: string): void {
  rmSync(directory, { force: true, recursive: true });
}
