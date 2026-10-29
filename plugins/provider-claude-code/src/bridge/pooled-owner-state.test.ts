import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SdkSession } from "./sdk-session.js";
import {
  buildSessionOptions,
  resolveClaudeCodeExecutable,
  type BuildSessionOptionsArgs,
} from "./session-options.js";

const POOL_TOKEN = "poolTokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RULES_MARKER = "POOLED-OWNER-RULES-MARKER-7f3a9c";
const GUARDED_FRAGMENT = "pooled-owner-guarded-fixture";

const POOL_ENV: Record<string, string> = {
  CLAUDE_CODE_OAUTH_TOKEN: POOL_TOKEN,
  ANTHROPIC_AUTH_TOKEN: "",
  ANTHROPIC_API_KEY: "",
  BB_CLAUDE_SETTINGS_ENV_PIN:
    "ANTHROPIC_BASE_URL,CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_AUTH_TOKEN,ANTHROPIC_API_KEY",
};

const SESSION_PARAMS: BuildSessionOptionsArgs = {
  cwd: "/tmp",
  instructionMode: "append",
  permissionMode: "acceptEdits",
  permissionScope: "workspace",
  serviceTier: "default",
  workflowsEnabled: false,
  chromeEnabled: false,
  disable1MContext: false,
  artifactsEnabled: true,
  sandboxEnabled: false,
};

const REAL_CLAUDE = resolveClaudeCodeExecutable({ env: process.env });

const cleanups: Array<() => unknown> = [];

const ownedDirectories = new Set<string>();

afterEach(() => runCleanups(cleanups, ownedDirectories));

class CliStillRunningError extends Error {
  constructor(
    readonly pids: number[],
    message: string,
  ) {
    super(message);
  }
}

const exitWaitCleanups = new WeakSet<object>();

function exitWaitCleanup(wait: () => Promise<void>): () => Promise<void> {
  exitWaitCleanups.add(wait);
  return wait;
}

async function runCleanups(
  list: Array<() => unknown>,
  directories: Set<string>,
): Promise<void> {
  const errors: unknown[] = [];
  const unconfirmed: unknown[] = [];
  while (list.length > 0) {
    const cleanup = list.pop();
    try {
      await cleanup?.();
    } catch (error) {
      errors.push(error);
      if (cleanup !== undefined && exitWaitCleanups.has(cleanup)) {
        unconfirmed.push(error);
      }
    }
  }
  if (unconfirmed.length > 0) {
    for (const error of unconfirmed) {
      for (const directory of directories) {
        if (error instanceof CliStillRunningError) {
          for (const pid of error.pids) {
            errors.push(
              new Error(`kept: process ${pid} still running: ${directory}`),
            );
          }
        } else {
          const reason = error instanceof Error ? error.message : String(error);
          errors.push(
            new Error(`kept: CLI exit not confirmed (${reason}): ${directory}`),
          );
        }
      }
    }
  } else {
    for (const directory of directories) {
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch (error) {
        errors.push(error);
      }
    }
    const leftovers = [...directories].filter((directory) =>
      existsSync(directory),
    );
    if (leftovers.length > 0) {
      errors.push(new Error(`scratch directories left behind: ${leftovers.join(", ")}`));
    }
  }
  directories.clear();
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `${errors.length} cleanups failed`);
  }
}

function stopSessionOnCleanup(session: SdkSession): void {
  cleanups.push(exitWaitCleanup(() => waitForCliExit(REAL_CLAUDE)));
  cleanups.push(() => session.stop());
}

function resolvedPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

type PsRunner = () => string;

const runPs: PsRunner = () =>
  execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
  });

function liveCliProcessIds(
  executable: string,
  ps: PsRunner = runPs,
): number[] {
  const wanted = new Set([executable, resolvedPath(executable)]);
  const table = ps();
  const parentOf = new Map<number, number>();
  const cliPids: number[] = [];
  let rowCount = 0;
  for (const line of table.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (match === null) {
      if (rowCount === 0) {
        throw new Error(`unparsable ps output: ${line.slice(0, 80)}`);
      }
      continue;
    }
    rowCount += 1;
    const pid = Number(match[1]);
    parentOf.set(pid, Number(match[2]));
    const program = (match[3] ?? "").split(" ", 1)[0] ?? "";
    if (wanted.has(program) || wanted.has(resolvedPath(program))) {
      cliPids.push(pid);
    }
  }
  if (!parentOf.has(process.pid)) {
    throw new Error("unparsable ps output: this process is not listed");
  }
  return cliPids.filter((pid) => {
    let ancestor = parentOf.get(pid);
    while (ancestor !== undefined && ancestor > 1) {
      if (ancestor === process.pid) return true;
      ancestor = parentOf.get(ancestor);
    }
    return ancestor === undefined;
  });
}

async function cliGoneWithin(
  executable: string,
  timeoutMs: number,
  ps: PsRunner,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (liveCliProcessIds(executable, ps).length > 0) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

function signalCliProcesses(
  executable: string,
  signal: NodeJS.Signals,
  ps: PsRunner,
): void {
  for (const pid of liveCliProcessIds(executable, ps)) {
    try {
      process.kill(pid, signal);
    } catch {
      continue;
    }
  }
}

async function terminateCliProcesses(
  executable: string,
  graceMs: number,
  ps: PsRunner,
): Promise<number[]> {
  signalCliProcesses(executable, "SIGTERM", ps);
  if (await cliGoneWithin(executable, graceMs, ps)) return [];
  signalCliProcesses(executable, "SIGKILL", ps);
  await cliGoneWithin(executable, graceMs, ps);
  return liveCliProcessIds(executable, ps);
}

async function waitForCliExit(
  executable: string | null,
  timeoutMs = 20_000,
  graceMs = 2_000,
  ps: PsRunner = runPs,
): Promise<void> {
  if (executable === null) {
    throw new Error(
      "no Claude executable resolved: cannot confirm the CLI exited before cleanup",
    );
  }
  if (await cliGoneWithin(executable, timeoutMs, ps)) return;
  const survivors = await terminateCliProcesses(executable, graceMs, ps);
  const message = `the Claude CLI did not exit within ${timeoutMs} ms of stop()`;
  if (survivors.length === 0) throw new Error(`${message}; it was terminated`);
  throw new CliStillRunningError(
    survivors,
    `${message}; process ${survivors.join(", ")} survived SIGKILL`,
  );
}

const scratchDirectories = new Set<string>();

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-pooled-owner-state-test-"));
  scratchDirectories.add(directory);
  scratchDirectories.add(realpathSync(directory));
  ownedDirectories.add(directory);
  return directory;
}

function assertInsideScratch(path: string): void {
  const resolved = resolve(path);
  const inside = [...scratchDirectories].some(
    (directory) =>
      resolved === directory || resolved.startsWith(`${directory}${sep}`),
  );
  if (!inside) {
    throw new Error(
      `refusing to use ${resolved}: not inside a directory this test created`,
    );
  }
}

function cleanBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (
      name.startsWith("ANTHROPIC_") ||
      name.startsWith("CLAUDE_CODE_") ||
      name === "CLAUDE_SECURESTORAGE_CONFIG_DIR" ||
      /^(https?|all|no)_proxy$/iu.test(name)
    ) {
      delete env[name];
    }
  }
  env.NO_PROXY = "127.0.0.1,localhost";
  return env;
}

async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function sse(events: ReadonlyArray<[string, unknown]>): string {
  return events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

function messageStart(): [string, unknown] {
  return [
    "message_start",
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
}

function toolUseResponse(command: string): string {
  return sse([
    messageStart(),
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({ command }),
        },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]);
}

function textResponse(): string {
  return sse([
    messageStart(),
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "done" },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]);
}

type HubReply = { tool: string } | "text" | "unauthorized";

interface ScriptedHub {
  url: string;
  bodies: string[];
  server: Server;
}

function startScriptedHub(reply: HubReply): Promise<ScriptedHub> {
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (!request.url?.startsWith("/v1/messages")) {
        response.statusCode = 404;
        response.end("{}");
        return;
      }
      bodies.push(body);
      if (reply === "unauthorized") {
        response.statusCode = 401;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "invalid" },
          }),
        );
        return;
      }
      const answered = body.includes('"tool_result"');
      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream");
      response.end(
        reply === "text" || answered
          ? textResponse()
          : toolUseResponse(reply.tool),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      cleanups.push(() => server.close());
      resolve({ url: `http://127.0.0.1:${port}`, bodies, server });
    });
  });
}

function startOauthMcpChallengeServer(): Promise<string> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const origin = `http://${request.headers.host}`;
      const path = request.url?.split("?")[0] ?? "";
      response.setHeader("content-type", "application/json");
      if (path.startsWith("/.well-known/oauth-protected-resource")) {
        response.end(
          JSON.stringify({
            resource: `${origin}/mcp`,
            authorization_servers: [origin],
          }),
        );
        return;
      }
      if (path.startsWith("/.well-known/oauth-authorization-server")) {
        response.end(
          JSON.stringify({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          }),
        );
        return;
      }
      response.statusCode = 401;
      response.setHeader(
        "www-authenticate",
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      );
      response.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      cleanups.push(() => server.close());
      resolve(`http://127.0.0.1:${port}/mcp`);
    });
  });
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface OwnerConfig {
  home: string;
  configDir: string;
  hookLog: string;
  guardedMarker: string;
  credentialsFile: string;
}

function writeOwnerConfig(): OwnerConfig {
  const home = scratch();
  const configDir = join(home, ".claude");
  assertInsideScratch(configDir);
  mkdirSync(configDir, { recursive: true });
  const work = scratch();
  const hookLog = join(work, "hook.log");
  const hook = join(work, "guard.cjs");
  writeFileSync(
    hook,
    [
      'const fs = require("node:fs");',
      'let raw = "";',
      'process.stdin.on("data", (c) => (raw += c));',
      'process.stdin.on("end", () => {',
      "  const input = JSON.parse(raw);",
      `  const command = String(input.tool_input && input.tool_input.command);`,
      `  fs.appendFileSync(${JSON.stringify(hookLog)}, command + "\\n");`,
      `  if (command.includes(${JSON.stringify(GUARDED_FRAGMENT)})) {`,
      '    process.stderr.write("blocked by the owner guard");',
      "    process.exit(2);",
      "  }",
      "});",
    ].join("\n"),
  );
  writeFileSync(
    join(configDir, "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: `node ${hook}` }],
          },
        ],
      },
    }),
  );
  writeFileSync(join(configDir, "CLAUDE.md"), `${RULES_MARKER}\n`);
  const credentialsFile = join(configDir, ".credentials.json");
  writeFileSync(
    credentialsFile,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "FAKE-OWNER-ACCESS",
        refreshToken: "FAKE-OWNER-REFRESH",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
  );
  chmodSync(credentialsFile, 0o600);
  return {
    home,
    configDir,
    hookLog,
    guardedMarker: join(work, GUARDED_FRAGMENT),
    credentialsFile,
  };
}

async function runPooledThread(
  hub: ScriptedHub,
  dataDir: string,
  owner: OwnerConfig,
): Promise<SdkSession> {
  const project = scratch();
  assertInsideScratch(owner.home);
  assertInsideScratch(owner.configDir);
  const options = buildSessionOptions(
    { ...SESSION_PARAMS, cwd: project },
    {
      ...cleanBaseEnv(),
      ...POOL_ENV,
      HOME: owner.home,
      CLAUDE_CONFIG_DIR: owner.configDir,
      BB_DATA_DIR: dataDir,
      ANTHROPIC_BASE_URL: hub.url,
      BB_CLAUDE_CODE_EXECUTABLE: REAL_CLAUDE ?? "",
    },
  );
  const session = new SdkSession(
    options,
    () => {},
    () => {},
  );
  stopSessionOnCleanup(session);
  session.start();
  await session.pushInput("hello");
  return session;
}

describe.skipIf(REAL_CLAUDE === null)(
  "a pooled thread on the real CLI keeps the owner's rules, guards and stored login",
  () => {
    it("still runs the owner's PreToolUse guard, which blocks a guarded command before it executes", async () => {
      const owner = writeOwnerConfig();
      const hub = await startScriptedHub({ tool: `touch ${owner.guardedMarker}` });
      await runPooledThread(hub, scratch(), owner);
      await waitFor(
        () =>
          hub.bodies.some((body) => body.includes('"tool_result"'))
            ? true
            : undefined,
        60_000,
      );
      expect(readFileSync(owner.hookLog, "utf8")).toContain(GUARDED_FRAGMENT);
      expect(existsSync(owner.guardedMarker)).toBe(false);
      const answered = hub.bodies.find((body) => body.includes('"tool_result"'));
      expect(answered).toContain("blocked by the owner guard");
    }, 90_000);

    it("still loads the owner's global rules into the model request", async () => {
      const owner = writeOwnerConfig();
      const hub = await startScriptedHub("unauthorized");
      await runPooledThread(hub, scratch(), owner);
      await waitFor(() => (hub.bodies.length > 0 ? true : undefined), 60_000);
      expect(hub.bodies.some((body) => body.includes(RULES_MARKER))).toBe(true);
    }, 90_000);

    it("leaves the owner's stored login untouched after the hub answers 401", async () => {
      const owner = writeOwnerConfig();
      const before = {
        digest: digest(owner.credentialsFile),
        size: statSync(owner.credentialsFile).size,
        mtimeMs: statSync(owner.credentialsFile).mtimeMs,
      };
      const hub = await startScriptedHub("unauthorized");
      const session = await runPooledThread(hub, scratch(), owner);
      await waitFor(() => (hub.bodies.length > 1 ? true : undefined), 60_000);
      session.stop();
      expect(digest(owner.credentialsFile)).toBe(before.digest);
      expect(statSync(owner.credentialsFile).size).toBe(before.size);
      expect(statSync(owner.credentialsFile).mtimeMs).toBe(before.mtimeMs);
    }, 90_000);
  },
);

interface DisposableKeychain {
  home: string;
  configDir: string;
  service: string;
  assertIsolated(): void;
  read(): { claudeAiOauth?: unknown } | undefined;
  modified(): string;
}

function runSecurity(home: string, args: string[]): string {
  return execFileSync("/usr/bin/security", args, {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: home, USER: userInfo().username },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const SECURITY_ITEM_NOT_FOUND = 44;

function isMissingKeychainItem(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === SECURITY_ITEM_NOT_FOUND
  );
}

function createDisposableKeychain(seed: unknown): DisposableKeychain {
  const home = realpathSync(scratch());
  const configDir = join(home, "config");
  assertInsideScratch(home);
  assertInsideScratch(configDir);
  mkdirSync(configDir, { recursive: true });
  const keychains = join(home, "Library", "Keychains");
  mkdirSync(keychains, { recursive: true });
  const file = join(keychains, "login.keychain-db");
  runSecurity(home, ["create-keychain", "-p", "disposable", file]);
  cleanups.push(() => {
    try {
      runSecurity(home, ["delete-keychain", file]);
    } catch {}
  });
  const assertIsolated = (): void => {
    const resolved = runSecurity(home, ["default-keychain", "-d", "user"])
      .trim()
      .replace(/^"|"$/gu, "");
    if (resolved !== file) {
      throw new Error(
        `default keychain under the disposable HOME is ${resolved}, expected ${file}`,
      );
    }
  };
  assertIsolated();
  runSecurity(home, ["set-keychain-settings", file]);
  const service = `Claude Code-credentials-${createHash("sha256")
    .update(configDir)
    .digest("hex")
    .slice(0, 8)}`;
  runSecurity(home, [
    "add-generic-password",
    "-s",
    service,
    "-a",
    userInfo().username,
    "-w",
    JSON.stringify(seed),
    "-U",
    file,
  ]);
  return {
    home,
    configDir,
    service,
    assertIsolated,
    read: () => {
      let stored: string;
      try {
        stored = runSecurity(home, [
          "find-generic-password",
          "-s",
          service,
          "-w",
          file,
        ]);
      } catch (error) {
        if (isMissingKeychainItem(error)) return undefined;
        throw error;
      }
      return JSON.parse(stored) as { claudeAiOauth?: unknown };
    },
    modified: () => {
      const stamp = /"mdat"<timedate>=0x[0-9A-F]+\s+"([^"\\]+)/u.exec(
        runSecurity(home, ["find-generic-password", "-s", service, file]),
      )?.[1];
      if (stamp === undefined) {
        throw new Error(`no mdat in the keychain item ${service}`);
      }
      return stamp;
    },
  };
}

const SEEDED_LOGIN = {
  accessToken: "FAKE-OWNER-ACCESS-0000000000000000000000000000000000",
  refreshToken: "FAKE-OWNER-REFRESH-000000000000000000000000000000000",
  expiresAt: 4_102_444_800_000,
  scopes: ["user:inference", "user:profile"],
  subscriptionType: "max",
};

async function runPooledThreadAgainstKeychain(
  keychain: DisposableKeychain,
  hub: ScriptedHub,
  mcpUrl: string,
): Promise<void> {
  writeFileSync(
    join(keychain.configDir, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      mcpServers: { standin: { type: "http", url: mcpUrl } },
    }),
  );
  keychain.assertIsolated();
  expect(keychain.read()?.claudeAiOauth).toEqual(SEEDED_LOGIN);
  const before = keychain.modified();
  expect(before).not.toBe("");
  const options = buildSessionOptions(
    { ...SESSION_PARAMS, cwd: scratch() },
    {
      ...cleanBaseEnv(),
      ...POOL_ENV,
      HOME: keychain.home,
      CLAUDE_CONFIG_DIR: keychain.configDir,
      ANTHROPIC_BASE_URL: hub.url,
      BB_CLAUDE_CODE_EXECUTABLE: REAL_CLAUDE ?? "",
    },
  );
  const session = new SdkSession(
    options,
    () => {},
    () => {},
  );
  stopSessionOnCleanup(session);
  session.start();
  await session.pushInput("hello");
  await waitFor(() => (hub.bodies.length > 0 ? true : undefined), 60_000);
  await waitFor(
    () => (keychain.modified() !== before ? true : undefined),
    60_000,
  );
  session.stop();
}

describe.skipIf(REAL_CLAUDE === null || process.platform !== "darwin")(
  "a pooled thread on the real CLI against a disposable macOS keychain",
  () => {
    it("rewrites the stored item when it connects an OAuth MCP server but never changes the stored login", async () => {
      const keychain = createDisposableKeychain({
        claudeAiOauth: SEEDED_LOGIN,
        mcpOAuth: {},
      });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const hub = await startScriptedHub("text");
      await runPooledThreadAgainstKeychain(
        keychain,
        hub,
        await startOauthMcpChallengeServer(),
      );
      expect(keychain.read()?.claudeAiOauth).toEqual(SEEDED_LOGIN);
    }, 150_000);

    it("never changes the stored login when the hub answers 401", async () => {
      const keychain = createDisposableKeychain({
        claudeAiOauth: SEEDED_LOGIN,
        mcpOAuth: {},
      });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const hub = await startScriptedHub("unauthorized");
      await runPooledThreadAgainstKeychain(
        keychain,
        hub,
        await startOauthMcpChallengeServer(),
      );
      expect(keychain.read()?.claudeAiOauth).toEqual(SEEDED_LOGIN);
    }, 150_000);

    it("would notice a real login change: a CLI logout changes the same item", async () => {
      const keychain = createDisposableKeychain({
        claudeAiOauth: SEEDED_LOGIN,
        mcpOAuth: {},
      });
      expect(keychain.read()?.claudeAiOauth).toEqual(SEEDED_LOGIN);
      keychain.assertIsolated();
      const logout = spawnSync(REAL_CLAUDE ?? "", ["auth", "logout"], {
        env: {
          ...cleanBaseEnv(),
          HOME: keychain.home,
          CLAUDE_CONFIG_DIR: keychain.configDir,
        },
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(logout.status).toBe(0);
      expect(keychain.read()).toBeUndefined();
    }, 90_000);
  },
);

describe("waiting for the Claude CLI to exit before cleanup", () => {
  const IGNORES_SIGTERM = "trap '' TERM; while :; do sleep 1; done";

  async function startProcess(
    argv0: string,
    command: string,
    args: string[],
  ): Promise<ChildProcess> {
    const child = spawn(command, args, { argv0, stdio: "ignore" });
    const deadline = Date.now() + 5_000;
    for (;;) {
      const shown = spawnSync("/bin/ps", ["-p", String(child.pid), "-o", "command="], {
        encoding: "utf8",
      }).stdout.trim();
      if (shown.startsWith(argv0)) return child;
      if (Date.now() > deadline) throw new Error(`sleeper never showed ${argv0}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function startSleeper(argv0: string): Promise<ChildProcess> {
    const child = await startProcess(argv0, "/bin/sleep", ["30"]);
    cleanups.push(() => child.kill("SIGKILL"));
    return child;
  }

  it("does not wait for a descendant whose path only shares the executable's prefix", async () => {
    const executable = join(scratch(), "claude");
    await startSleeper(`${executable}-x`);
    await startSleeper(`${executable}.bak`);
    await waitForCliExit(executable, 1_000);
  });

  it("waits for a descendant whose argv[0] is exactly the executable, and returns once it exits", async () => {
    const executable = join(scratch(), "claude");
    const sleeper = await startSleeper(executable);
    const exited = new Promise((resolve) => sleeper.once("exit", resolve));
    await expect(waitForCliExit(executable, 300)).rejects.toThrow(
      /did not exit/u,
    );
    await exited;
    expect(sleeper.signalCode).toBe("SIGTERM");
    await waitForCliExit(executable, 2_000);
  });

  it("fails instead of passing when no executable was resolved", async () => {
    await expect(waitForCliExit(null)).rejects.toThrow(/no Claude executable/u);
  });

  function failureOf(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  function aggregateOf(failure: unknown): AggregateError {
    if (!(failure instanceof AggregateError)) {
      throw new Error("expected an AggregateError");
    }
    return failure;
  }

  function tableRow(pid: number, ppid: number, command: string): string {
    return `${pid} ${ppid} ${command}`;
  }

  const OWN_ROW = tableRow(process.pid, 1, "node");
  const FAKE_PID = 2_000_000_000;

  it("runs every later cleanup and still fails with the timeout when the wait for the CLI throws, keeping the directories even though the CLI was killed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-pooled-owner-state-test-"));
    const executable = join(directory, "claude");
    const stubborn = await startProcess(executable, "/bin/sh", [
      "-c",
      IGNORES_SIGTERM,
    ]);
    const exited = new Promise((resolve) => stubborn.once("exit", resolve));
    const ran: string[] = [];
    const list: Array<() => unknown> = [
      () => ran.push("session.stop"),
      () => ran.push("server.close"),
      exitWaitCleanup(() => waitForCliExit(executable, 200, 300)),
    ];
    try {
      const failure = aggregateOf(
        await failureOf(runCleanups(list, new Set([directory]))),
      );
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      expect(String(failure.errors[0])).toMatch(/did not exit/u);
      expect(String(failure.errors[1])).toContain(
        `kept: CLI exit not confirmed`,
      );
      expect(String(failure.errors[1])).toContain(directory);
      expect(stubborn.signalCode).toBe("SIGKILL");
      expect(liveCliProcessIds(executable)).toEqual([]);
      expect(ran).toEqual(["server.close", "session.stop"]);
      expect(existsSync(directory)).toBe(true);
      expect(list).toEqual([]);
    } finally {
      stubborn.kill("SIGKILL");
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each([
    {
      name: "the process survives SIGKILL",
      table: (executable: string) => () =>
        [OWN_ROW, tableRow(FAKE_PID, process.pid, `${executable} -c x`)].join(
          "\n",
        ),
      error: /process 2000000000 survived SIGKILL/u,
      kept: (directory: string) =>
        `kept: process ${FAKE_PID} still running: ${directory}`,
    },
    {
      name: "ps throws",
      table: () => () => {
        throw new Error("ps failed");
      },
      error: /^Error: ps failed$/u,
      kept: (directory: string) =>
        `kept: CLI exit not confirmed (ps failed): ${directory}`,
    },
    {
      name: "ps returns output that is not a process table",
      table: () => () => "this is not a process table",
      error: /unparsable ps output: this is not a process table/u,
      kept: (directory: string) =>
        `kept: CLI exit not confirmed (unparsable ps output: this is not a process table): ${directory}`,
    },
    {
      name: "ps output does not list this process",
      table: () => () => tableRow(1, 0, "launchd"),
      error: /unparsable ps output: this process is not listed/u,
      kept: (directory: string) =>
        `kept: CLI exit not confirmed (unparsable ps output: this process is not listed): ${directory}`,
    },
    {
      name: "the ancestry of a matching process cannot be resolved",
      table: (executable: string) => () =>
        [OWN_ROW, tableRow(FAKE_PID, 777_777_777, executable)].join("\n"),
      error: /process 2000000000 survived SIGKILL/u,
      kept: (directory: string) =>
        `kept: process ${FAKE_PID} still running: ${directory}`,
    },
  ])(
    "keeps the directories, names them and still runs every other cleanup when $name",
    async ({ table, error, kept }) => {
      const directory = mkdtempSync(
        join(tmpdir(), "bb-pooled-owner-state-test-"),
      );
      const executable = join(directory, "claude");
      const ran: string[] = [];
      const list: Array<() => unknown> = [
        () => ran.push("session.stop"),
        () => ran.push("server.close"),
        exitWaitCleanup(() =>
          waitForCliExit(executable, 100, 100, table(executable)),
        ),
      ];
      try {
        const failure = aggregateOf(
          await failureOf(runCleanups(list, new Set([directory]))),
        );
        expect(failure.errors).toHaveLength(2);
        expect(String(failure.errors[0])).toMatch(error);
        expect(String(failure.errors[1])).toBe(`Error: ${kept(directory)}`);
        expect(ran).toEqual(["server.close", "session.stop"]);
        expect(existsSync(directory)).toBe(true);
        expect(list).toEqual([]);
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );

  it("confirms the exit when the process table lists no matching process, including rows continued over several lines", async () => {
    const executable = join(tmpdir(), "bb-pooled-owner-state-test-none", "claude");
    await waitForCliExit(executable, 100, 100, () => OWN_ROW);
    await waitForCliExit(
      executable,
      100,
      100,
      () => `${OWN_ROW}\n${tableRow(4321, 1, "sh -c echo\ncontinued line")}`,
    );
  });

  it("still removes the directories when only an unrelated cleanup throws and the exit was confirmed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-pooled-owner-state-test-"));
    const executable = join(directory, "claude");
    const ran: string[] = [];
    const list: Array<() => unknown> = [
      () => ran.push("session.stop"),
      exitWaitCleanup(() =>
        waitForCliExit(executable, 100, 100, () => OWN_ROW),
      ),
      () => {
        throw new Error("server.close failed");
      },
    ];
    try {
      await expect(runCleanups(list, new Set([directory]))).rejects.toThrow(
        /^server\.close failed$/u,
      );
      expect(ran).toEqual(["session.stop"]);
      expect(existsSync(directory)).toBe(false);
      expect(list).toEqual([]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("reports every failed cleanup together", async () => {
    const list: Array<() => unknown> = [
      () => {
        throw new Error("first");
      },
      () => Promise.reject(new Error("second")),
    ];
    const failure = await runCleanups(list, new Set()).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(failure instanceof AggregateError)) throw new Error("expected an AggregateError");
    expect(failure.errors.map(String)).toEqual([
      "Error: second",
      "Error: first",
    ]);
    expect(list).toEqual([]);
  });
});
