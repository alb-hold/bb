import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readIsolatedClaudeContextUsage } from "./context-usage-probe.js";
import { probeClaudeInitialization } from "./initialization-probe.js";
import { SdkSession } from "./sdk-session.js";
import {
  buildSessionOptions,
  resolveClaudeCodeExecutable,
  type BuildSessionOptionsArgs,
} from "./session-options.js";

import { trackTestProcess } from "./test-processes.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...original,
    query: (args: Parameters<typeof original.query>[0]) =>
      original.query({
        ...args,
        options: {
          ...args.options,
          spawnClaudeCodeProcess: (options) => {
            const child = spawn(options.command, options.args, {
              cwd: options.cwd,
              env: options.env,
              signal: options.signal,
              detached: process.platform !== "win32",
              stdio: ["pipe", "pipe", "pipe"],
            });
            cleanups.push(trackTestProcess(child));
            return child;
          },
        },
      }),
  };
});

const POOL_TOKEN = "poolTokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const HOST_PREFIX = "sk-ant-dummy-";

const POOL_ENV: Record<string, string> = {
  CLAUDE_CODE_OAUTH_TOKEN: POOL_TOKEN,
  ANTHROPIC_AUTH_TOKEN: "",
  ANTHROPIC_API_KEY: "",
  ENABLE_TOOL_SEARCH: "true",
  BB_CLAUDE_SETTINGS_ENV_PIN:
    "ANTHROPIC_BASE_URL,CLAUDE_CODE_OAUTH_TOKEN,ENABLE_TOOL_SEARCH,ANTHROPIC_AUTH_TOKEN,ANTHROPIC_API_KEY",
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
  sandboxEnabled: true,
};

function cleanBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (
      name.startsWith("ANTHROPIC_") ||
      name.startsWith("CLAUDE_CODE_") ||
      /^(https?|all|no)_proxy$/iu.test(name)
    ) {
      delete env[name];
    }
  }
  env.NO_PROXY = "127.0.0.1,localhost";
  return env;
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-pinned-settings-test-"));
  cleanups.push(() => rmSync(directory, { force: true, recursive: true }));
  return directory;
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

function fakeCli(directory: string): { executable: string; record: string } {
  const executable = join(directory, "fake-claude");
  const record = join(directory, "record.json");
  writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const argv = process.argv.slice(2);",
      'const at = argv.indexOf("--settings");',
      "const value = at >= 0 ? argv[at + 1] : null;",
      'const isFile = value !== null && !value.startsWith("{");',
      "const entry = {",
      "  argv,",
      "  store: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? null,",
      "  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,",
      "  value,",
      "  mode: isFile ? fs.statSync(value).mode & 0o777 : null,",
      '  contents: isFile ? fs.readFileSync(value, "utf8") : value,',
      "};",
      `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(entry));`,
      "if (process.env.FAKE_CLI_EXIT) process.exit(1);",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  chmodSync(executable, 0o755);
  return { executable, record };
}

interface FakeLaunch {
  argv: string[];
  store: string | null;
  configDir: string | null;
  value: string | null;
  mode: number | null;
  contents: string;
}

async function launchFake(
  env: NodeJS.ProcessEnv,
  params: BuildSessionOptionsArgs = SESSION_PARAMS,
): Promise<{ launch: FakeLaunch; session: SdkSession }> {
  const directory = scratch();
  const { executable, record } = fakeCli(directory);
  const options = buildSessionOptions(params, {
    ...env,
    BB_CLAUDE_CODE_EXECUTABLE: executable,
  });
  const session = new SdkSession(
    options,
    () => {},
    () => {},
  );
  cleanups.push(() => session.stop());
  session.start();
  const launch = await waitFor(
    () =>
      existsSync(record)
        ? (JSON.parse(readFileSync(record, "utf8")) as FakeLaunch)
        : undefined,
    20_000,
  );
  return { launch, session };
}

describe("pooled launch settings", () => {
  it("gives a pooled launch one 0600 flag-settings file with the pins, the sandbox and no token on argv", async () => {
    const { launch, session } = await launchFake({
      ...cleanBaseEnv(),
      ...POOL_ENV,
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9/hub",
    });
    expect(launch.value).not.toBeNull();
    expect(launch.value?.startsWith("{")).toBe(false);
    expect(launch.argv.filter((arg) => arg === "--settings")).toHaveLength(1);
    expect(launch.argv.join(" ")).not.toContain(POOL_TOKEN);
    expect(launch.argv.join(" ")).not.toContain("127.0.0.1:9");
    expect(launch.mode).toBe(0o600);
    const settings = JSON.parse(launch.contents) as Record<string, unknown>;
    expect(settings.env).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9/hub",
      CLAUDE_CODE_OAUTH_TOKEN: POOL_TOKEN,
      ENABLE_TOOL_SEARCH: "true",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_API_KEY: "",
    });
    expect(settings.apiKeyHelper).toBe("");
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: false,
    });
    expect(settings).toHaveProperty("autoMemoryEnabled");
    const file = launch.value ?? "";
    session.stop();
    await waitFor(() => (existsSync(file) ? undefined : true), 10_000);
  });

  it("leaves the owner's config dir and credential store variables as inherited", async () => {
    const { launch, session } = await launchFake({
      ...cleanBaseEnv(),
      ...POOL_ENV,
      CLAUDE_CONFIG_DIR: "/owner/config",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9/hub",
    });
    expect(launch.configDir).toBe("/owner/config");
    expect(launch.store).toBeNull();
    session.stop();
  });

  it("leaves a configured credential store variable as inherited", async () => {
    const { launch, session } = await launchFake({
      ...cleanBaseEnv(),
      ...POOL_ENV,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/owner/store",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9/hub",
    });
    expect(launch.store).toBe("/owner/store");
    session.stop();
  });

  it("keeps inline flag settings for a launch that is not pooled", async () => {
    const { launch } = await launchFake({ ...cleanBaseEnv() });
    expect(launch.value?.startsWith("{")).toBe(true);
    expect(JSON.parse(launch.contents)).not.toHaveProperty("env");
  });

  function expectPinnedProbeLaunch(launch: FakeLaunch): void {
    expect(launch.value?.startsWith("{")).toBe(false);
    expect(launch.argv.join(" ")).not.toContain(POOL_TOKEN);
    expect(launch.mode).toBe(0o600);
    const settings = JSON.parse(launch.contents) as { env?: unknown };
    expect(settings.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: POOL_TOKEN,
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_API_KEY: "",
    });
  }

  it("pins the routing into the initialization probe's flag settings", async () => {
    const directory = scratch();
    const { executable, record } = fakeCli(directory);
    await probeClaudeInitialization({
      cwd: directory,
      env: {
        ...cleanBaseEnv(),
        ...POOL_ENV,
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9/hub",
        BB_CLAUDE_CODE_EXECUTABLE: executable,
        FAKE_CLI_EXIT: "1",
      },
    }).catch(() => undefined);
    expectPinnedProbeLaunch(
      JSON.parse(readFileSync(record, "utf8")) as FakeLaunch,
    );
  });

  it("pins the routing into the context-usage probe's flag settings", async () => {
    const directory = scratch();
    const { executable, record } = fakeCli(directory);
    const abort = new AbortController();
    const probe = readIsolatedClaudeContextUsage({
      sessionOptions: buildSessionOptions(SESSION_PARAMS, {
        ...cleanBaseEnv(),
        ...POOL_ENV,
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9/hub",
        BB_CLAUDE_CODE_EXECUTABLE: executable,
      }),
      providerSessionId: "00000000-0000-4000-8000-000000000000",
      dynamicTools: [],
      signal: abort.signal,
    }).catch(() => undefined);
    const launch = await waitFor(
      () =>
        existsSync(record)
          ? (JSON.parse(readFileSync(record, "utf8")) as FakeLaunch)
          : undefined,
      20_000,
    );
    abort.abort();
    await probe;
    expectPinnedProbeLaunch(launch);
    expect(JSON.parse(launch.contents)).toMatchObject({
      disableAllHooks: true,
    });
  });
});

interface HubRecord {
  authorization: string;
  apiKey: string;
  request: string;
}

function credentialed(records: readonly HubRecord[]): HubRecord[] {
  return records.filter(
    (record) => record.authorization !== "" || record.apiKey !== "",
  );
}

function startHub(): Promise<{
  url: string;
  records: HubRecord[];
  server: Server;
}> {
  const records: HubRecord[] = [];
  const server = createServer((request, response) => {
    records.push({
      authorization: String(request.headers.authorization ?? ""),
      apiKey: String(request.headers["x-api-key"] ?? ""),
      request: `${request.method} ${request.url}`,
    });
    request.resume();
    response.statusCode = 401;
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      cleanups.push(() => server.close());
      resolve({ url: `http://127.0.0.1:${port}`, records, server });
    });
  });
}

const REAL_CLAUDE = resolveClaudeCodeExecutable({ env: process.env });

interface Layers {
  userApiKeyHelper?: string;
  projectApiKeyHelper?: string;
  user?: Record<string, string>;
  project?: Record<string, string>;
  local?: Record<string, string>;
}

function writeLayers(layers: Layers): string {
  const project = scratch();
  mkdirSync(join(project, ".claude"), { recursive: true });
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? "";
  mkdirSync(configDir, { recursive: true });
  const settingsFile = join(configDir, "settings.json");
  const previous = existsSync(settingsFile)
    ? readFileSync(settingsFile, "utf8")
    : null;
  cleanups.push(() => {
    if (previous === null) rmSync(settingsFile, { force: true });
    else writeFileSync(settingsFile, previous);
  });
  if (layers.user || layers.userApiKeyHelper)
    writeFileSync(
      settingsFile,
      JSON.stringify({
        env: layers.user ?? {},
        apiKeyHelper: layers.userApiKeyHelper,
      }),
    );
  if (layers.project || layers.projectApiKeyHelper)
    writeFileSync(
      join(project, ".claude", "settings.json"),
      JSON.stringify({
        env: layers.project ?? {},
        apiKeyHelper: layers.projectApiKeyHelper,
      }),
    );
  if (layers.local)
    writeFileSync(
      join(project, ".claude", "settings.local.json"),
      JSON.stringify({ env: layers.local }),
    );
  return project;
}

async function presentedCredentials(
  layersFor: (elsewhereUrl: string) => Layers,
): Promise<{
  hub: HubRecord[];
  elsewhere: HubRecord[];
}> {
  const hub = await startHub();
  const elsewhere = await startHub();
  const project = writeLayers(layersFor(elsewhere.url));
  const options = buildSessionOptions(
    { ...SESSION_PARAMS, cwd: project, sandboxEnabled: false },
    {
      ...cleanBaseEnv(),
      ...POOL_ENV,
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
  await waitFor(
    () => (credentialed(hub.records).length > 0 ? true : undefined),
    40_000,
  );
  session.stop();
  return { hub: hub.records, elsewhere: elsewhere.records };
}

describe.skipIf(REAL_CLAUDE === null)("settings layers on the real CLI", () => {
  const dummy = (layer: string) => `${HOST_PREFIX}${layer}-${"x".repeat(40)}`;

  it.each(["user", "project", "local"] as const)(
    "the pool token beats a %s settings env CLAUDE_CODE_OAUTH_TOKEN",
    async (layer) => {
      const { hub } = await presentedCredentials(() => ({
        [layer]: { CLAUDE_CODE_OAUTH_TOKEN: dummy(layer) },
      }));
      const sent = credentialed(hub);
      expect(sent.length).toBeGreaterThan(0);
      for (const record of sent) {
        expect(record.authorization, record.request).toBe(
          `Bearer ${POOL_TOKEN}`,
        );
        expect(record.apiKey, record.request).toBe("");
      }
    },
    90_000,
  );

  it("leak: a host token in settings env is never sent to the hub", async () => {
    const { hub, elsewhere } = await presentedCredentials((elsewhereUrl) => ({
      user: {
        CLAUDE_CODE_OAUTH_TOKEN: dummy("user"),
        ANTHROPIC_AUTH_TOKEN: dummy("user-auth"),
      },
      project: {
        CLAUDE_CODE_OAUTH_TOKEN: dummy("project"),
        ANTHROPIC_API_KEY: dummy("project-key"),
        ANTHROPIC_BASE_URL: elsewhereUrl,
      },
      local: {
        CLAUDE_CODE_OAUTH_TOKEN: dummy("local"),
        ANTHROPIC_AUTH_TOKEN: dummy("local-auth"),
      },
    }));
    const sent = credentialed(hub);
    expect(sent.length).toBeGreaterThan(0);
    for (const record of sent) {
      expect(record.authorization, record.request).toBe(`Bearer ${POOL_TOKEN}`);
      expect(record.apiKey, record.request).toBe("");
    }
    for (const record of hub) {
      expect(record.authorization).not.toContain(HOST_PREFIX);
      expect(record.apiKey).not.toContain(HOST_PREFIX);
    }
    expect(elsewhere).toEqual([]);
  }, 90_000);

  it("leak: a host apiKeyHelper key is never sent to the hub", async () => {
    const helper = join(scratch(), "helper.sh");
    writeFileSync(helper, `#!/bin/sh\nprintf %s ${dummy("helper")}\n`);
    chmodSync(helper, 0o755);
    const { hub } = await presentedCredentials(() => ({
      userApiKeyHelper: helper,
      projectApiKeyHelper: helper,
    }));
    const sent = credentialed(hub);
    expect(sent.length).toBeGreaterThan(0);
    for (const record of sent) {
      expect(record.authorization, record.request).toBe(`Bearer ${POOL_TOKEN}`);
      expect(record.apiKey, record.request).toBe("");
    }
    for (const record of hub) {
      expect(record.authorization).not.toContain(HOST_PREFIX);
      expect(record.apiKey).not.toContain(HOST_PREFIX);
    }
  }, 90_000);
});
