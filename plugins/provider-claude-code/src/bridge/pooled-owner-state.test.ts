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

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  const leftovers = [...scratchDirectories].filter((directory) =>
    existsSync(directory),
  );
  expect(leftovers).toEqual([]);
});

function stopSessionOnCleanup(session: SdkSession): void {
  cleanups.push(() => waitForCliExit(REAL_CLAUDE));
  cleanups.push(() => session.stop());
}

function resolvedPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function liveCliProcessIds(executable: string): number[] {
  const wanted = new Set([executable, resolvedPath(executable)]);
  const table = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
  });
  const parentOf = new Map<number, number>();
  const cliPids: number[] = [];
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    parentOf.set(pid, Number(match[2]));
    const program = (match[3] ?? "").split(" ", 1)[0] ?? "";
    if (wanted.has(program) || wanted.has(resolvedPath(program))) {
      cliPids.push(pid);
    }
  }
  return cliPids.filter((pid) => {
    for (
      let ancestor = parentOf.get(pid);
      ancestor !== undefined && ancestor > 1;
      ancestor = parentOf.get(ancestor)
    ) {
      if (ancestor === process.pid) return true;
    }
    return false;
  });
}

async function waitForCliExit(
  executable: string | null,
  timeoutMs = 20_000,
): Promise<void> {
  if (executable === null) {
    throw new Error(
      "no Claude executable resolved: cannot confirm the CLI exited before cleanup",
    );
  }
  const deadline = Date.now() + timeoutMs;
  while (liveCliProcessIds(executable).length > 0) {
    if (Date.now() > deadline) {
      throw new Error(
        `the Claude CLI did not exit within ${timeoutMs} ms of stop()`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const scratchDirectories = new Set<string>();

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-pooled-owner-state-test-"));
  scratchDirectories.add(directory);
  scratchDirectories.add(realpathSync(directory));
  cleanups.push(() => rmSync(directory, { force: true, recursive: true }));
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
  async function startSleeper(argv0: string): Promise<ChildProcess> {
    const child = spawn("/bin/sleep", ["30"], { argv0, stdio: "ignore" });
    cleanups.push(() => child.kill("SIGKILL"));
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

  it("does not wait for a descendant whose path only shares the executable's prefix", async () => {
    const executable = join(scratch(), "claude");
    await startSleeper(`${executable}-x`);
    await startSleeper(`${executable}.bak`);
    await waitForCliExit(executable, 1_000);
  });

  it("waits for a descendant that runs exactly the executable, and returns once it exits", async () => {
    const executable = join(scratch(), "claude");
    const sleeper = await startSleeper(executable);
    await expect(waitForCliExit(executable, 300)).rejects.toThrow(
      /did not exit/u,
    );
    const exited = new Promise((resolve) => sleeper.once("exit", resolve));
    sleeper.kill("SIGKILL");
    await exited;
    await waitForCliExit(executable, 2_000);
  });

  it("fails instead of passing when no executable was resolved", async () => {
    await expect(waitForCliExit(null)).rejects.toThrow(/no Claude executable/u);
  });
});
