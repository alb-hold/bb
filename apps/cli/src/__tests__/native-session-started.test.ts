import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ProviderNativeTerminal } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BbHttpError } from "@bb/sdk";
import { holdNativeHarness } from "../commands/thread/native.js";
import { NativeActivityReader } from "../native-activity-reader.js";
import { createNativeActivityPump } from "../native-activity-wiring.js";
import {
  encodeNativeHolderFrame,
  NativeHolderFrame,
  NativeHolderFrameDecoder,
  waitForNativeHolder,
} from "../native-holder.js";
import { createNativeSessionStartedReporter } from "../native-session-started.js";
import { publishHooks } from "./helpers/hook-spool.js";

interface ClaudePluginTestHost {
  bb: unknown;
  harness: {
    registrations: {
      providerRegistrations: {
        id: string;
        experimental_nativeTerminal?: ProviderNativeTerminal;
      }[];
    };
  };
}

const {
  createFakePluginHost,
}: {
  createFakePluginHost(options: { pluginId: string }): ClaudePluginTestHost;
} = await import(
  new URL(
    "../../../../packages/plugin-sdk/src/testing/fake-plugin-host.ts",
    import.meta.url,
  ).href
);
const { default: claudeCodePlugin }: { default(bb: unknown): void } =
  await import(
    new URL(
      "../../../../plugins/provider-claude-code/server.ts",
      import.meta.url,
    ).href
  );

const SESSION_ID = "019a1f3e-0000-7000-8000-000000000042";

const roots: string[] = [];
const servers: Server[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function claudeDeclaration(): ProviderNativeTerminal {
  const host = createFakePluginHost({ pluginId: "provider-claude-code" });
  claudeCodePlugin(host.bb);
  const cli = host.harness.registrations.providerRegistrations.find(
    (entry) => entry.id === "claude-code",
  )?.experimental_nativeTerminal;
  if (cli === undefined) throw new Error("Claude native declaration missing");
  return cli;
}

function readerFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "bb-session-started-"));
  roots.push(root);
  const events = path.join(root, "events");
  const reader = new NativeActivityReader(
    claudeDeclaration(),
    { HOME: root },
    events,
    { kind: "start", id: SESSION_ID },
    () => undefined,
    () => undefined,
  );
  const hook = (records: object[]) =>
    publishHooks(
      events,
      records.map((record) => JSON.stringify(record)).join("\n"),
    );
  return { reader, hook };
}

function createFakeClaudeExecutable(root: string): string {
  const scriptPath = path.join(root, "fake-claude.mjs");
  const wrapperPath = path.join(root, "fake-claude");
  const script = `import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const sessionId = readArg("--session-id");
const settingsArg = readArg("--settings");
let sessionStartCommand = null;
if (settingsArg !== null) {
  const raw = settingsArg.trim().startsWith("{")
    ? settingsArg
    : readFileSync(settingsArg, "utf8");
  const parsed = JSON.parse(raw);
  sessionStartCommand =
    parsed?.hooks?.SessionStart?.[0]?.hooks?.[0]?.command ?? null;
}

process.stdout.write(
  \`READY hasHook=\${sessionStartCommand !== null ? "1" : "0"}\\n\`,
);

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const command = line.trim();
  if (command === "trust") {
    if (sessionStartCommand === null) {
      process.stdout.write("NO_HOOK\\n");
      return;
    }
    execFileSync("/bin/sh", ["-c", sessionStartCommand], {
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: sessionId,
      }),
      stdio: ["pipe", "ignore", "ignore"],
    });
    process.stdout.write("TRUSTED\\n");
  } else if (command === "activity") {
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    if (configDir === undefined || sessionId === null) {
      process.stdout.write("NO_TRANSCRIPT_DIR\\n");
      return;
    }
    const projectDir = path.join(configDir, "projects", "demo");
    mkdirSync(projectDir, { recursive: true });
    const transcriptPath = path.join(projectDir, \`\${sessionId}.jsonl\`);
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "user",
          origin: { kind: "human" },
          uuid: "u-1",
          promptId: "turn-1",
          timestamp: new Date().toISOString(),
        }),
        JSON.stringify({
          type: "system",
          subtype: "turn_duration",
          isSidechain: false,
          uuid: "s-1",
          parentUuid: "u-1",
          timestamp: new Date().toISOString(),
        }),
      ].join("\\n") + "\\n",
    );
    process.stdout.write("ACTIVITY_WRITTEN\\n");
  } else if (command === "exit") {
    lines.close();
    process.exit(0);
  }
});
`;
  const shellQuote = (value: string) => `'${value.replace(/'/gu, `'\\''`)}'`;
  writeFileSync(scriptPath, script, { mode: 0o600 });
  writeFileSync(
    wrapperPath,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(scriptPath)} "$@"\n`,
    { mode: 0o700 },
  );
  chmodSync(wrapperPath, 0o700);
  return wrapperPath;
}

async function startFakeSdkServer(args: {
  executable: string;
  sessionId: string;
  threadId: string;
}) {
  const launchUrls: string[] = [];
  const recordSessionCalls: Array<{
    authorization: string | undefined;
    body: Record<string, unknown>;
  }> = [];
  const activityCalls: Array<{
    authorization: string | undefined;
    body: Record<string, unknown>;
  }> = [];
  let awaitedTerminalId: string | null = null;
  let settleCount = 0;
  const cli: ProviderNativeTerminal = {
    ...claudeDeclaration(),
    executable: args.executable,
  };
  const threadView = {
    threadId: args.threadId,
    providerId: "claude-code",
    displayName: "Claude Code",
    model: null,
    nativeSessionId: args.sessionId,
    canReturnToChat: false,
    terminal: {
      id: "term_holder",
      threadId: args.threadId,
      status: "running",
      closeReason: null,
      exitCode: null,
      createdAt: Date.now(),
    },
  };
  const settleIfAwaiting = (authorization: string | undefined) => {
    if (
      authorization === "Bearer test-holder-credential" &&
      awaitedTerminalId === threadView.terminal.id
    ) {
      awaitedTerminalId = null;
      settleCount += 1;
    }
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const parsedBody =
        rawBody.length > 0
          ? (JSON.parse(rawBody) as Record<string, unknown>)
          : {};
      const url = request.url ?? "";
      response.setHeader("content-type", "application/json");
      if (
        request.method === "POST" &&
        url.startsWith(
          `/api/v1/threads/${args.threadId}/native-terminal/launch`,
        )
      ) {
        launchUrls.push(url);
        if (url.includes("sessionStart=reported")) {
          awaitedTerminalId = threadView.terminal.id;
        }
        response.end(
          JSON.stringify({
            threadId: args.threadId,
            providerId: "claude-code",
            cli,
            nativeSessionId: args.sessionId,
            initialPrompt: null,
            model: null,
          }),
        );
        return;
      }
      if (
        request.method === "POST" &&
        url === `/api/v1/threads/${args.threadId}/native-terminal/session`
      ) {
        recordSessionCalls.push({
          authorization: request.headers.authorization,
          body: parsedBody,
        });
        settleIfAwaiting(request.headers.authorization);
        response.end(JSON.stringify(threadView));
        return;
      }
      if (
        request.method === "POST" &&
        url === `/api/v1/threads/${args.threadId}/native-terminal/activity`
      ) {
        activityCalls.push({
          authorization: request.headers.authorization,
          body: parsedBody,
        });
        if (parsedBody.confirms !== false) {
          settleIfAwaiting(request.headers.authorization);
        }
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (
        request.method === "GET" &&
        url === `/api/v1/threads/${args.threadId}/native-terminal`
      ) {
        response.end(JSON.stringify(threadView));
        return;
      }
      response.statusCode = 404;
      response.end(
        JSON.stringify({ error: `unexpected ${request.method} ${url}` }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return {
    activityCalls,
    get awaitedTerminalId() {
      return awaitedTerminalId;
    },
    baseUrl: `http://127.0.0.1:${address.port}`,
    launchUrls,
    recordSessionCalls,
    get settleCount() {
      return settleCount;
    },
  };
}

class HolderTestClient {
  private readonly decoder = new NativeHolderFrameDecoder();
  output = "";

  constructor(private readonly socket: net.Socket) {
    sockets.push(socket);
    socket.on("data", (chunk: Buffer) => {
      for (const message of this.decoder.push(chunk)) {
        if (message.type === NativeHolderFrame.output) {
          this.output += message.payload.toString("utf8");
        }
      }
    });
  }

  attach(credential: string): void {
    this.socket.write(
      encodeNativeHolderFrame(
        NativeHolderFrame.credential,
        Buffer.from(credential, "utf8"),
      ),
    );
    this.socket.write(
      encodeNativeHolderFrame(
        NativeHolderFrame.resize,
        Buffer.from(JSON.stringify({ cols: 80, rows: 24 })),
      ),
    );
  }

  type(text: string): void {
    this.socket.write(
      encodeNativeHolderFrame(NativeHolderFrame.input, Buffer.from(text)),
    );
  }

  async waitFor(pattern: RegExp): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (pattern.test(this.output)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      `timed out waiting for ${pattern}; saw ${JSON.stringify(this.output)}`,
    );
  }
}

async function waitUntil(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function cleanHolderEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.XDG_RUNTIME_DIR;
  delete env.BB_CLAUDE_SETTINGS_ENV_PIN;
  delete env.BB_CLAUDE_SETTINGS_ENV_PIN_PROVIDER;
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

describe("Claude declares a started hook", () => {
  it("lists SessionStart so the holder can report that the CLI began", () => {
    expect(claudeDeclaration().activity?.hooks?.started).toEqual([
      "SessionStart",
    ]);
  });
});

describe("NativeActivityReader started signal", () => {
  it("reports the session on SessionStart without changing activity", () => {
    const { reader, hook } = readerFixture();
    expect(reader.takeSessionStarted()).toBeNull();
    hook([{ hook_event_name: "SessionStart", session_id: SESSION_ID }]);
    expect(reader.read()).toEqual([]);
    expect(reader.takeSessionStarted()).toBe(SESSION_ID);
    expect(reader.takeSessionStarted()).toBeNull();
  });

  it("ignores a SessionStart from a different session", () => {
    const { reader, hook } = readerFixture();
    hook([{ hook_event_name: "SessionStart", session_id: "someone-else" }]);
    reader.read();
    expect(reader.takeSessionStarted()).toBeNull();
  });
});

describe("createNativeActivityPump started signal", () => {
  it("hands a taken started session to the callback once", () => {
    const taken = [SESSION_ID, null];
    const sessionStarted = vi.fn();
    const pump = createNativeActivityPump({
      reader: () => ({
        read: () => [],
        takeSessionStarted: () => taken.shift() ?? null,
      }),
      report: () => undefined,
      sessionStarted,
    });
    pump();
    pump();
    expect(sessionStarted).toHaveBeenCalledTimes(1);
    expect(sessionStarted).toHaveBeenCalledWith(SESSION_ID);
  });
});

describe("createNativeSessionStartedReporter", () => {
  function setup(
    recordSession: (args: {
      authorization: string;
      nativeSessionId: string;
    }) => Promise<unknown>,
    credential: string | null = "cred",
  ) {
    const log = vi.fn();
    const reporter = createNativeSessionStartedReporter({
      currentCredential: () => credential,
      log,
      recordSession,
    });
    return { log, reporter };
  }

  it("records the session with the credential and stops after success", async () => {
    const recordSession = vi.fn().mockResolvedValue({});
    const { reporter } = setup(recordSession);
    reporter.note(SESSION_ID);
    await reporter.settled();
    reporter.retry();
    await reporter.settled();
    expect(recordSession).toHaveBeenCalledTimes(1);
    expect(recordSession).toHaveBeenCalledWith({
      authorization: "Bearer cred",
      nativeSessionId: SESSION_ID,
    });
  });

  it("retries after a transient failure", async () => {
    const recordSession = vi
      .fn()
      .mockRejectedValueOnce(
        new BbHttpError({
          status: 503,
          code: null,
          message: "unavailable",
          body: {},
        }),
      )
      .mockResolvedValue({});
    const { reporter } = setup(recordSession);
    reporter.note(SESSION_ID);
    await reporter.settled();
    reporter.retry();
    await reporter.settled();
    reporter.retry();
    await reporter.settled();
    expect(recordSession).toHaveBeenCalledTimes(2);
  });

  it("gives up on a permanent refusal and logs it", async () => {
    const recordSession = vi.fn().mockRejectedValue(
      new BbHttpError({
        status: 409,
        code: "native_session_claimed",
        message: "claimed",
        body: {},
      }),
    );
    const { log, reporter } = setup(recordSession);
    reporter.note(SESSION_ID);
    await reporter.settled();
    reporter.retry();
    await reporter.settled();
    expect(recordSession).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "session-started-refused",
      expect.objectContaining({ sessionId: SESSION_ID }),
    );
  });

  it("waits for a credential before sending", async () => {
    const recordSession = vi.fn().mockResolvedValue({});
    const { reporter } = setup(recordSession, null);
    reporter.note(SESSION_ID);
    await reporter.settled();
    expect(recordSession).not.toHaveBeenCalled();
  });
});

describe("holdNativeHarness preassigned start ordering", () => {
  it("sends no recordSession before SessionStart when hook capture is available, then sends exactly one after SessionStart", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bb-hs-ok-"));
    roots.push(root);
    const home = path.join(root, "home");
    const tmpDir = path.join(root, "tmp");
    const socketPath = path.join(root, "t.sock");
    const executable = createFakeClaudeExecutable(root);
    const threadId = "thr_holder_hook_ok";
    const sdkServer = await startFakeSdkServer({
      executable,
      sessionId: SESSION_ID,
      threadId,
    });

    const holderDone = holdNativeHarness(
      sdkServer.baseUrl,
      threadId,
      socketPath,
      {
        activityPollIntervalMs: 25,
        cwd: root,
        env: cleanHolderEnv(home),
        home,
        tmpDir,
      },
    );

    const attached = await waitForNativeHolder(socketPath, 5_000);
    expect(attached).not.toBeNull();
    const client = new HolderTestClient(attached!);
    client.attach("test-holder-credential");
    await client.waitFor(/READY hasHook=1/u);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sdkServer.launchUrls).toEqual([
      `/api/v1/threads/${threadId}/native-terminal/launch?images=argv&sessionStart=reported`,
    ]);
    expect(sdkServer.recordSessionCalls).toEqual([]);
    expect(sdkServer.activityCalls).toEqual([]);

    client.type("trust\n");
    await client.waitFor(/TRUSTED/u);
    await waitUntil(
      () => sdkServer.recordSessionCalls.length === 1,
      "recordSession after SessionStart",
    );
    expect(sdkServer.recordSessionCalls).toEqual([
      {
        authorization: "Bearer test-holder-credential",
        body: { nativeSessionId: SESSION_ID },
      },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sdkServer.recordSessionCalls).toHaveLength(1);

    client.type("exit\n");
    expect(await holderDone).toBe(0);
    expect(sdkServer.recordSessionCalls).toHaveLength(1);
  });

  it("does not recordSession or settle before terminal-scoped proof of life when hook capture is unavailable, then settles once after proof of life", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bb-hs-fb-"));
    roots.push(root);
    const blockedPath = path.join(root, "blocked-file");
    writeFileSync(blockedPath, "not-a-directory", { mode: 0o600 });
    const claudeConfigDir = path.join(root, "claude-config");
    const socketPath = path.join(root, "t.sock");
    const executable = createFakeClaudeExecutable(root);
    const threadId = "thr_holder_hook_unavailable";
    const sdkServer = await startFakeSdkServer({
      executable,
      sessionId: SESSION_ID,
      threadId,
    });

    const holderDone = holdNativeHarness(
      sdkServer.baseUrl,
      threadId,
      socketPath,
      {
        activityPollIntervalMs: 25,
        cwd: root,
        env: {
          ...cleanHolderEnv(blockedPath),
          CLAUDE_CONFIG_DIR: claudeConfigDir,
        },
        home: blockedPath,
        tmpDir: path.join(blockedPath, "tmp"),
      },
    );

    const attached = await waitForNativeHolder(socketPath, 5_000);
    expect(attached).not.toBeNull();
    const client = new HolderTestClient(attached!);
    client.attach("test-holder-credential");
    await client.waitFor(/READY hasHook=0/u);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sdkServer.launchUrls).toEqual([
      `/api/v1/threads/${threadId}/native-terminal/launch?images=argv&sessionStart=reported`,
    ]);
    expect(sdkServer.recordSessionCalls).toEqual([]);
    expect(sdkServer.activityCalls).toEqual([]);
    expect(sdkServer.awaitedTerminalId).toBe("term_holder");
    expect(sdkServer.settleCount).toBe(0);

    client.type("activity\n");
    await client.waitFor(/ACTIVITY_WRITTEN/u);
    await waitUntil(
      () => sdkServer.activityCalls.length === 1,
      "terminal-scoped activity proof of life",
    );
    expect(sdkServer.recordSessionCalls).toEqual([]);
    expect(sdkServer.activityCalls).toHaveLength(1);
    expect(sdkServer.activityCalls[0]?.authorization).toBe(
      "Bearer test-holder-credential",
    );
    expect(sdkServer.activityCalls[0]?.body.state).toBe("idle");
    expect(sdkServer.activityCalls[0]?.body.confirms).not.toBe(false);
    expect(sdkServer.awaitedTerminalId).toBeNull();
    expect(sdkServer.settleCount).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sdkServer.recordSessionCalls).toEqual([]);
    expect(sdkServer.settleCount).toBe(1);

    client.type("exit\n");
    expect(await holderDone).toBe(0);
    expect(sdkServer.recordSessionCalls).toEqual([]);
    expect(sdkServer.settleCount).toBe(1);
  });
});
