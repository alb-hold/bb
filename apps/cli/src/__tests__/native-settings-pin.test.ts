import { existsSync, readFileSync, statSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderNativeTerminalActivity } from "@bb/domain";
import {
  prepareNativeSettings,
  removePinnedNativeSettings,
  selectPinnedSettingsEnv,
} from "../native-settings-pin.js";

type ActivityHooks = NonNullable<ProviderNativeTerminalActivity["hooks"]>;

const POOL_TOKEN = "poolTokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const CLAUDE_HOOKS: ActivityHooks = {
  args: ["--settings", "{settings}"],
  working: ["UserPromptSubmit", "PreToolUse"],
  idle: [],
  pending: ["Stop"],
  promptField: "prompt",
  sessionIdField: "session_id",
};

const POOLED_ENV = {
  BB_CLAUDE_SETTINGS_ENV_PIN:
    "ANTHROPIC_BASE_URL,CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_AUTH_TOKEN",
  BB_CLAUDE_SETTINGS_ENV_PIN_PROVIDER: "claude-code",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:38886/api/v1/plugins/account-pool/http",
  CLAUDE_CODE_OAUTH_TOKEN: POOL_TOKEN,
  ANTHROPIC_AUTH_TOKEN: "",
};

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) removePinnedNativeSettings(directory);
  }
});

describe("prepareNativeSettings", () => {
  it("writes hooks and the pinned env into one 0600 file whose path replaces {settings}", () => {
    const settings = prepareNativeSettings({
      providerId: "claude-code",
      sessionRootEnv: "CLAUDE_CONFIG_DIR",
      env: POOLED_ENV,
      hooks: CLAUDE_HOOKS,
      hookTarget: "/tmp/spool",
    });
    if (settings === null || settings.directory === null)
      throw new Error("expected a settings file");
    directories.push(settings.directory);
    expect(settings.value.startsWith("{")).toBe(false);
    expect(settings.value).not.toContain(POOL_TOKEN);
    expect(statSync(settings.value).mode & 0o777).toBe(0o600);
    const contents = JSON.parse(readFileSync(settings.value, "utf8"));
    expect(contents.apiKeyHelper).toBe("");
    expect(contents.env).toEqual({
      ANTHROPIC_BASE_URL: POOLED_ENV.ANTHROPIC_BASE_URL,
      CLAUDE_CODE_OAUTH_TOKEN: POOL_TOKEN,
      ANTHROPIC_AUTH_TOKEN: "",
    });
    expect(Object.keys(contents.hooks)).toEqual([
      "UserPromptSubmit",
      "PreToolUse",
      "Stop",
    ]);
  });

  it("still pins the env when hook capture is unavailable", () => {
    const settings = prepareNativeSettings({
      providerId: "claude-code",
      sessionRootEnv: "CLAUDE_CONFIG_DIR",
      env: POOLED_ENV,
      hooks: CLAUDE_HOOKS,
      hookTarget: null,
    });
    if (settings === null || settings.directory === null)
      throw new Error("expected a settings file");
    directories.push(settings.directory);
    const contents = JSON.parse(readFileSync(settings.value, "utf8"));
    expect(contents.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(POOL_TOKEN);
    expect(contents).not.toHaveProperty("hooks");
  });

  it("keeps the inline hook settings when the launch is not pooled", () => {
    const settings = prepareNativeSettings({
      providerId: "claude-code",
      sessionRootEnv: "CLAUDE_CONFIG_DIR",
      env: {},
      hooks: CLAUDE_HOOKS,
      hookTarget: "/tmp/spool",
    });
    expect(settings?.directory).toBeNull();
    expect(settings?.value.startsWith("{")).toBe(true);
    expect(JSON.parse(settings?.value ?? "{}")).not.toHaveProperty("env");
    expect(
      prepareNativeSettings({
        providerId: "claude-code",
        sessionRootEnv: "CLAUDE_CONFIG_DIR",
        env: {},
        hooks: CLAUDE_HOOKS,
        hookTarget: null,
      }),
    ).toBeNull();
  });

  it("ignores the Claude marker for another provider's native launch", () => {
    const settings = prepareNativeSettings({
      providerId: "codex",
      sessionRootEnv: "CODEX_HOME",
      env: POOLED_ENV,
      hooks: { ...CLAUDE_HOOKS, args: ["-c", "hooks=1"] },
      hookTarget: "/tmp/spool",
    });
    expect(settings?.directory).toBeNull();
  });

  it("pins a launch by its provider, whatever the provider CLI executable is called", () => {
    for (const executable of [
      "/opt/x/bin/claude",
      "claude-wrapper",
      "claude",
    ]) {
      const settings = prepareNativeSettings({
        providerId: "claude-code",
        sessionRootEnv: "CLAUDE_CONFIG_DIR",
        env: { ...POOLED_ENV, BB_CLAUDE_CODE_EXECUTABLE: executable },
        hooks: CLAUDE_HOOKS,
        hookTarget: "/tmp/spool",
      });
      if (settings === null || settings.directory === null)
        throw new Error(`${executable} was not pinned`);
      directories.push(settings.directory);
      expect(
        JSON.parse(readFileSync(settings.value, "utf8")).env
          .CLAUDE_CODE_OAUTH_TOKEN,
      ).toBe(POOL_TOKEN);
    }
  });

  it("pins or refuses a Claude launch whose marker names no provider", () => {
    const unnamed = Object.fromEntries(
      Object.entries(POOLED_ENV).filter(
        ([name]) => name !== "BB_CLAUDE_SETTINGS_ENV_PIN_PROVIDER",
      ),
    );
    expect(() =>
      prepareNativeSettings({
        providerId: "claude-renamed",
        sessionRootEnv: "CLAUDE_CONFIG_DIR",
        env: unnamed,
        hooks: { ...CLAUDE_HOOKS, args: ["-c", "hooks=1"] },
        hookTarget: "/tmp/spool",
      }),
    ).toThrow(/not started/u);
    const settings = prepareNativeSettings({
      providerId: "claude-renamed",
      sessionRootEnv: "CLAUDE_CONFIG_DIR",
      env: unnamed,
      hooks: CLAUDE_HOOKS,
      hookTarget: "/tmp/spool",
    });
    if (settings === null || settings.directory === null)
      throw new Error("expected a settings file");
    directories.push(settings.directory);
    expect(settings.value.startsWith("{")).toBe(false);
  });

  it("ignores a marker that names no provider for a launch that takes no Claude settings", () => {
    const unnamed = Object.fromEntries(
      Object.entries(POOLED_ENV).filter(
        ([name]) => name !== "BB_CLAUDE_SETTINGS_ENV_PIN_PROVIDER",
      ),
    );
    const codexHooks = { ...CLAUDE_HOOKS, args: ["-c", "hooks=1"] };
    const settings = prepareNativeSettings({
      providerId: "codex",
      sessionRootEnv: "CODEX_HOME",
      env: unnamed,
      hooks: codexHooks,
      hookTarget: "/tmp/spool",
    });
    expect(settings?.directory).toBeNull();
    expect(settings?.value.startsWith("{")).toBe(true);
    expect(settings?.value).not.toContain(POOL_TOKEN);
    expect(
      prepareNativeSettings({
        providerId: "codex",
        sessionRootEnv: "CODEX_HOME",
        env: unnamed,
        hooks: undefined,
        hookTarget: null,
      }),
    ).toBeNull();
  });

  it("refuses to launch a pooled Claude without a {settings} argument instead of launching unpinned", () => {
    expect(() =>
      prepareNativeSettings({
        providerId: "claude-code",
        sessionRootEnv: "CLAUDE_CONFIG_DIR",
        env: POOLED_ENV,
        hooks: { ...CLAUDE_HOOKS, args: ["-c", "hooks=1"] },
        hookTarget: "/tmp/spool",
      }),
    ).toThrow(/not started/u);
    expect(() =>
      prepareNativeSettings({
        providerId: "claude-code",
        sessionRootEnv: "CLAUDE_CONFIG_DIR",
        env: POOLED_ENV,
        hooks: undefined,
        hookTarget: null,
      }),
    ).toThrow(/not started/u);
  });

  it("removes the file with its directory", () => {
    const settings = prepareNativeSettings({
      providerId: "claude-code",
      sessionRootEnv: "CLAUDE_CONFIG_DIR",
      env: POOLED_ENV,
      hooks: CLAUDE_HOOKS,
      hookTarget: null,
    });
    if (settings === null || settings.directory === null)
      throw new Error("expected a settings file");
    removePinnedNativeSettings(settings.directory);
    expect(existsSync(settings.value)).toBe(false);
  });
});

describe("selectPinnedSettingsEnv", () => {
  it("blanks listed names the env lacks and ignores invalid names", () => {
    expect(
      selectPinnedSettingsEnv({
        BB_CLAUDE_SETTINGS_ENV_PIN: "A_ONE,B-TWO,C_THREE",
        A_ONE: "1",
      }),
    ).toEqual({ A_ONE: "1", C_THREE: "" });
    expect(selectPinnedSettingsEnv({})).toBeNull();
  });
});
