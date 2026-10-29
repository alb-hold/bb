import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SdkSession } from "./sdk-session.js";
import {
  buildSessionOptions,
  resolveClaudeCodeExecutable,
  type BuildSessionOptionsArgs,
} from "./session-options.js";

const POOL_TOKEN = "poolTokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RULES_MARKER = "POOLED-ISOLATION-RULES-MARKER-7f3a9c";
const GUARDED_FRAGMENT = "pooled-isolation-guarded-fixture";

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

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-pooled-store-test-"));
  cleanups.push(() => rmSync(directory, { force: true, recursive: true }));
  return directory;
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

interface ScriptedHub {
  url: string;
  bodies: string[];
  server: Server;
}

function startScriptedHub(toolCommand: string | null): Promise<ScriptedHub> {
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
      if (toolCommand === null) {
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
      response.end(answered ? textResponse() : toolUseResponse(toolCommand));
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

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface OwnerConfig {
  configDir: string;
  hookLog: string;
  guardedMarker: string;
  credentialsFile: string;
}

function writeOwnerConfig(): OwnerConfig {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? "";
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
    configDir,
    hookLog,
    guardedMarker: join(work, GUARDED_FRAGMENT),
    credentialsFile,
  };
}

async function runPooledThread(
  hub: ScriptedHub,
  dataDir: string,
): Promise<SdkSession> {
  const project = scratch();
  const options = buildSessionOptions(
    { ...SESSION_PARAMS, cwd: project },
    {
      ...cleanBaseEnv(),
      ...POOL_ENV,
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
  cleanups.push(() => session.stop());
  session.start();
  await session.pushInput("hello");
  return session;
}

describe.skipIf(REAL_CLAUDE === null)(
  "a pooled thread on the real CLI with a private credential store",
  () => {
    it("still runs the owner's PreToolUse guard, which blocks a guarded command before it executes", async () => {
      const owner = writeOwnerConfig();
      const hub = await startScriptedHub(`touch ${owner.guardedMarker}`);
      await runPooledThread(hub, scratch());
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
      writeOwnerConfig();
      const hub = await startScriptedHub(null);
      await runPooledThread(hub, scratch());
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
      const hub = await startScriptedHub(null);
      const dataDir = scratch();
      const session = await runPooledThread(hub, dataDir);
      await waitFor(() => (hub.bodies.length > 1 ? true : undefined), 60_000);
      session.stop();
      expect(digest(owner.credentialsFile)).toBe(before.digest);
      expect(statSync(owner.credentialsFile).size).toBe(before.size);
      expect(statSync(owner.credentialsFile).mtimeMs).toBe(before.mtimeMs);
      expect(existsSync(join(dataDir, "pooled-claude-credentials"))).toBe(true);
    }, 90_000);
  },
);
