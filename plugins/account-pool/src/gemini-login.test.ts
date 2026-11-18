import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GeminiLogin,
  GeminiLoginError,
  antigravityLaunchFromCustomAgents,
  type GeminiLoginAccount,
  type GeminiLoginOptions,
  type GeminiLoginTarget,
} from "./gemini-login.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

function spawnsOf(script: string): number {
  return vi
    .mocked(spawn)
    .mock.calls.filter((call) => Array.isArray(call[1]) && call[1].includes(script)).length;
}

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_RUNTIME = path.join(FIXTURES, "fake-antigravity-acp.mjs");
const FAKE_CHROME = path.join(FIXTURES, "fake-chrome.mjs");
const PLANTED = "BB_TEST_PLANTED_SECRET";

const cleanups: Array<() => Promise<void>> = [];
const logins: GeminiLogin[] = [];

afterEach(async () => {
  delete process.env[PLANTED];
  for (const login of logins.splice(0)) await login.dispose();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface RuntimeConfig {
  version?: string | null;
  offerOAuth?: boolean;
  url?: string;
  browserMode?: "open" | "none";
  token?: unknown;
  lingerOnTerm?: boolean;
}

async function setup(
  options: {
    runtime?: RuntimeConfig;
    timeoutMs?: number;
    importAccount?: GeminiLoginOptions["importAccount"];
    resolveRuntime?: GeminiLoginOptions["resolveRuntime"];
    now?: () => number;
  } = {},
) {
  const base = await fs.mkdtemp(path.join(tmpdir(), "bb-gemini-login-"));
  cleanups.push(() => fs.rm(base, { recursive: true, force: true }));
  const dataDir = path.join(base, "data");
  const control = path.join(base, "control");
  await fs.mkdir(dataDir);
  await fs.mkdir(control);
  await fs.writeFile(
    path.join(control, "config.json"),
    JSON.stringify({ version: "1.5.0", ...options.runtime }),
  );
  const imports: Array<{ home: string; target: GeminiLoginTarget; token: string }> = [];
  const importAccount =
    options.importAccount ??
    (async (home: string, target: GeminiLoginTarget): Promise<GeminiLoginAccount> => {
      const token = await fs.readFile(
        path.join(home, "antigravity-acp", "acp_token.json"),
        "utf8",
      );
      imports.push({ home, target, token });
      return { id: "acct-1", label: target.label ?? "gemini@example.com" };
    });
  const login = new GeminiLogin({
    dataDir,
    resolveRuntime:
      options.resolveRuntime ??
      (async () => ({ command: process.execPath, args: [FAKE_RUNTIME, control] })),
    browser: { command: process.execPath, args: [FAKE_CHROME, control] },
    importAccount,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  logins.push(login);
  const root = path.join(dataDir, "gemini-login");
  return {
    login,
    control,
    dataDir,
    root,
    imports,
    approve: () => fs.writeFile(path.join(control, "approve"), ""),
    deny: () => fs.writeFile(path.join(control, "deny"), ""),
    readJson: async (name: string) =>
      JSON.parse(await fs.readFile(path.join(control, name), "utf8")) as Record<
        string,
        unknown
      >,
    leftovers: async () => fs.readdir(root).catch(() => [] as string[]),
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectNothingLeft(fixture: Awaited<ReturnType<typeof setup>>) {
  expect(await fixture.leftovers()).toEqual([]);
  const browser = existsSync(path.join(fixture.control, "browser.json"))
    ? await fixture.readJson("browser.json")
    : null;
  if (browser !== null) expect(isAlive(browser.pid as number)).toBe(false);
  const runtime = existsSync(path.join(fixture.control, "env.json"))
    ? await fixture.readJson("env.json")
    : null;
  if (runtime !== null) expect(isAlive(runtime.pid as number)).toBe(false);
}

describe("antigravityLaunchFromCustomAgents", () => {
  it("reads the antigravity-acp entry from the JSON string provider-acp stores", () => {
    expect(
      antigravityLaunchFromCustomAgents(
        JSON.stringify([
          { id: "other", command: "/bin/other" },
          { id: "antigravity-acp", command: "/opt/agy/1.5.0/agy_acp_server.par", args: ["--x", 3] },
        ]),
      ),
    ).toEqual({ command: "/opt/agy/1.5.0/agy_acp_server.par", args: ["--x"] });
  });

  it("returns null when the entry is missing, malformed, or has no command", () => {
    expect(antigravityLaunchFromCustomAgents(undefined)).toBeNull();
    expect(antigravityLaunchFromCustomAgents("not json")).toBeNull();
    expect(antigravityLaunchFromCustomAgents("[]")).toBeNull();
    expect(
      antigravityLaunchFromCustomAgents([{ id: "antigravity-acp", command: "" }]),
    ).toBeNull();
  });
});

describe("GeminiLogin", () => {
  it("signs in through a dedicated profile, imports the account, and deletes the folder", async () => {
    process.env[PLANTED] = "must-not-reach-the-runtime";
    const fixture = await setup();
    const started = await fixture.login.start({ label: "ultra", priority: 3 });
    expect(started.authorizeUrl).toMatch(/^https:\/\/accounts\.google\.com\//u);
    const dir = path.join(fixture.root, started.sessionId);

    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect(
      JSON.parse(
        await fs.readFile(path.join(dir, "home", "antigravity-acp", "settings.json"), "utf8"),
      ),
    ).toEqual({ auth: { type: "oauth-personal" } });

    const env = await fixture.readJson("env.json");
    expect(env.home).toBe(path.join(dir, "home"));
    expect(env.geminiHome).toBe(path.join(dir, "home"));
    expect(env.fileStorage).toBe("1");
    expect(env.cwd).toBe(await fs.realpath(dir));
    const names = env.names as string[];
    expect(names).not.toContain(PLANTED);
    for (const name of names)
      expect(["AGY_ACP_FORCE_FILE_STORAGE", "BROWSER", "GEMINI_HOME", "HOME", "PATH", "TMPDIR"]).toContain(name);

    await vi.waitFor(() =>
      expect(existsSync(path.join(fixture.control, "browser.json"))).toBe(true),
    );
    const browser = await fixture.readJson("browser.json");
    const args = browser.args as string[];
    expect(args).toContain(`--user-data-dir=${path.join(dir, "chrome-profile")}`);
    expect(args).toContain("--no-first-run");
    expect(args).toContain("--use-mock-keychain");
    expect(args.at(-1)).toBe(started.authorizeUrl);
    expect(args.some((arg) => arg.includes("remote-debugging"))).toBe(false);
    await vi.waitFor(() =>
      expect(existsSync(path.join(dir, "chrome-profile", "Default", "Cookies"))).toBe(true),
    );

    await fixture.approve();
    const result = await fixture.login.wait(started.sessionId);
    expect(result).toEqual({
      status: "complete",
      account: { id: "acct-1", label: "ultra" },
    });
    expect(fixture.imports).toEqual([
      {
        home: path.join(dir, "home"),
        target: { label: "ultra", priority: 3 },
        token: JSON.stringify({ fake: "token" }),
      },
    ]);
    expect(existsSync(dir)).toBe(false);
    await expectNothingLeft(fixture);
  });

  it("adds nothing and cleans up when Google declines the sign-in", async () => {
    const fixture = await setup();
    const started = await fixture.login.start({ label: null });
    await fixture.deny();
    const result = await fixture.login.wait(started.sessionId);
    expect(result).toMatchObject({ status: "error", reason: "sign_in_failed" });
    expect(JSON.stringify(result)).not.toContain("secret-looking");
    expect(fixture.imports).toEqual([]);
    await expectNothingLeft(fixture);
  });

  it("cancels when the sign-in window is closed", async () => {
    const fixture = await setup();
    await fs.writeFile(path.join(fixture.control, "close-window"), "");
    const started = await fixture.login.start({ label: null });
    const result = await fixture.login.wait(started.sessionId);
    expect(result).toMatchObject({ status: "error", reason: "sign_in_cancelled" });
    await fixture.approve();
    expect(fixture.imports).toEqual([]);
    await expectNothingLeft(fixture);
  });

  it("cancels when the waiting command is interrupted", async () => {
    const fixture = await setup();
    const started = await fixture.login.start({ label: null });
    const controller = new AbortController();
    const waiting = fixture.login.wait(started.sessionId, controller.signal);
    controller.abort();
    expect(await waiting).toMatchObject({ status: "error", reason: "sign_in_cancelled" });
    await fixture.approve();
    expect(fixture.imports).toEqual([]);
    await expectNothingLeft(fixture);
  });

  it("adds nothing when the command is interrupted while the signed-in runtime is stopping", async () => {
    const fixture = await setup({ runtime: { lingerOnTerm: true } });
    const started = await fixture.login.start({ label: null });
    const controller = new AbortController();
    const waiting = fixture.login.wait(started.sessionId, controller.signal);
    await fixture.approve();
    const terminating = path.join(fixture.control, "terminating");
    while (!existsSync(terminating)) await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(await waiting).toMatchObject({ status: "error", reason: "sign_in_cancelled" });
    expect(fixture.imports).toEqual([]);
    await expectNothingLeft(fixture);
  });

  it("times out, adds nothing, and cleans up", async () => {
    const fixture = await setup({ timeoutMs: 1_500 });
    const started = await fixture.login.start({ label: null });
    const result = await fixture.login.wait(started.sessionId);
    expect(result).toMatchObject({ status: "error", reason: "sign_in_timeout" });
    expect(fixture.imports).toEqual([]);
    await expectNothingLeft(fixture);
  });

  it("refuses a second sign-in while one is pending", async () => {
    const fixture = await setup();
    const started = await fixture.login.start({ label: null });
    await expect(fixture.login.start({ label: null })).rejects.toThrow(started.sessionId);
    fixture.login.cancel(started.sessionId);
    await fixture.login.wait(started.sessionId);
    await expectNothingLeft(fixture);
  });

  it.each([
    ["no agent configured", async () => null],
    ["a relative command", async () => ({ command: "agy_acp_server.par", args: [] })],
    ["a command that does not exist", async () => ({ command: "/nonexistent/agy_acp_server.par", args: [] })],
  ])("fails with runtime_missing for %s and opens nothing", async (_name, resolveRuntime) => {
    const fixture = await setup({ resolveRuntime });
    const error = await fixture.login.start({ label: null }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiLoginError);
    expect((error as GeminiLoginError).reason).toBe("runtime_missing");
    expect(existsSync(path.join(fixture.control, "browser.json"))).toBe(false);
    await expectNothingLeft(fixture);
  });

  it.each([
    ["an older version", { version: "1.4.0" }],
    ["no oauth-personal method", { offerOAuth: false }],
  ])("fails with runtime_version for %s, before any browser opens", async (_name, runtime) => {
    const fixture = await setup({ runtime });
    const error = await fixture.login.start({ label: null }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiLoginError);
    expect((error as GeminiLoginError).reason).toBe("runtime_version");
    expect(existsSync(path.join(fixture.control, "browser.json"))).toBe(false);
    await expectNothingLeft(fixture);
  });

  it("does not open a page that is not Google's sign-in page", async () => {
    const fixture = await setup({ runtime: { url: "https://example.com/phish" } });
    const error = await fixture.login.start({ label: null }).catch((e: unknown) => e);
    expect((error as GeminiLoginError).reason).toBe("sign_in_failed");
    expect(existsSync(path.join(fixture.control, "browser.json"))).toBe(false);
    await expectNothingLeft(fixture);
  });

  it("adds nothing when the runtime finishes without writing a token", async () => {
    const fixture = await setup({ runtime: { token: false } });
    const started = await fixture.login.start({ label: null });
    await fixture.approve();
    expect(await fixture.login.wait(started.sessionId)).toMatchObject({
      status: "error",
      reason: "token_missing",
    });
    expect(fixture.imports).toEqual([]);
    await expectNothingLeft(fixture);
  });

  it("reports a refused import and still deletes the folder", async () => {
    const fixture = await setup({
      importAccount: async () => {
        throw new Error("This current login is already in the account pool.");
      },
    });
    const started = await fixture.login.start({ label: null });
    await fixture.approve();
    const result = await fixture.login.wait(started.sessionId);
    expect(result).toMatchObject({ status: "error", reason: "import_failed" });
    expect(result.status === "error" && result.message).toContain("already in the account pool");
    await expectNothingLeft(fixture);
  });

  it("sweeps folders a crashed earlier run left behind", async () => {
    const fixture = await setup();
    const stale = path.join(fixture.root, "stale-session", "chrome-profile");
    await fs.mkdir(stale, { recursive: true });
    const started = await fixture.login.start({ label: null });
    expect(await fixture.leftovers()).toEqual([started.sessionId]);
    fixture.login.cancel(started.sessionId);
    await fixture.login.wait(started.sessionId);
    await expectNothingLeft(fixture);
  });

  it("cancels a pending sign-in on dispose", async () => {
    const fixture = await setup();
    const started = await fixture.login.start({ label: null });
    const waiting = fixture.login.wait(started.sessionId);
    await fixture.login.dispose();
    expect(await waiting).toMatchObject({ status: "error", reason: "sign_in_cancelled" });
    await expectNothingLeft(fixture);
  });

  it("resolves dispose and starts nothing while the runtime is still being resolved", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let control = "";
    const fixture = await setup({
      resolveRuntime: async () => {
        await gate;
        return { command: process.execPath, args: [FAKE_RUNTIME, control] };
      },
    });
    control = fixture.control;
    const starting = fixture.login.start({ label: null }).catch((e: unknown) => e);
    await fixture.login.dispose();
    const error = await starting;
    release();
    expect(error).toBeInstanceOf(GeminiLoginError);
    expect((error as GeminiLoginError).reason).toBe("sign_in_cancelled");
    expect(existsSync(path.join(fixture.control, "env.json"))).toBe(false);
    expect(existsSync(path.join(fixture.control, "browser.json"))).toBe(false);
    expect(await fixture.leftovers()).toEqual([]);
  });

  it("never spawns the runtime when the caller aborts after the runtime is resolved but before it starts", async () => {
    const abort = new AbortController();
    let armed = false;
    let abortedAfterSession = false;
    let control = "";
    const fixture = await setup({
      resolveRuntime: async () => {
        armed = true;
        return { command: process.execPath, args: [FAKE_RUNTIME, control] };
      },
      now: () => {
        if (armed && !abort.signal.aborted) {
          abortedAfterSession = true;
          abort.abort();
        }
        return Date.now();
      },
    });
    control = fixture.control;
    const runtimesBefore = spawnsOf(FAKE_RUNTIME);
    const browsersBefore = spawnsOf(FAKE_CHROME);
    const error = await fixture.login
      .start({ label: null }, abort.signal)
      .catch((e: unknown) => e);
    expect(abortedAfterSession).toBe(true);
    expect(spawnsOf(FAKE_RUNTIME)).toBe(runtimesBefore);
    expect(spawnsOf(FAKE_CHROME)).toBe(browsersBefore);
    expect(error).toBeInstanceOf(GeminiLoginError);
    expect((error as GeminiLoginError).reason).toBe("sign_in_cancelled");
    expect(existsSync(path.join(fixture.control, "env.json"))).toBe(false);
    expect(existsSync(path.join(fixture.control, "browser.json"))).toBe(false);
    expect(await fixture.leftovers()).toEqual([]);
    expect(fixture.imports).toEqual([]);
  });

  it("resolves dispose only after a sign-in that is still opening is stopped and removed", async () => {
    const fixture = await setup({ runtime: { version: null } });
    const starting = fixture.login.start({ label: null }).catch((e: unknown) => e);
    await vi.waitFor(() =>
      expect(existsSync(path.join(fixture.control, "env.json"))).toBe(true),
    );
    const runtime = await fixture.readJson("env.json");
    await fixture.login.dispose();
    expect(await fixture.leftovers()).toEqual([]);
    expect(isAlive(runtime.pid as number)).toBe(false);
    expect(existsSync(path.join(fixture.control, "browser.json"))).toBe(false);
    expect(((await starting) as GeminiLoginError).reason).toBe("sign_in_cancelled");
  });
});
