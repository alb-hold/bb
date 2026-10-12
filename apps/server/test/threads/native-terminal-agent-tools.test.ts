import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEnvironment, getNativeTerminalThread, threads } from "@bb/db";
import {
  nativeTerminalAgentToolsSchema,
  threadResponseSchema,
} from "@bb/server-contract";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildExecutionOptions,
  prepareTurnSubmitCommandPayload,
} from "../../src/services/threads/thread-commands.js";
import { UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME } from "../../src/services/threads/thread-environment-directory.js";
import {
  internalAuthHeaders,
  registerTestHostRpcCapture,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

interface Fixture {
  environmentId: string;
  harness: TestAppHarness;
  hostId: string;
  pluginsDir: string;
  projectId: string;
  sessionId: string;
  terminalOpens: { requestId: string; terminalId: string }[];
}

const harnesses: TestAppHarness[] = [];
const pluginDirs: string[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
  for (const dir of pluginDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const PLUGIN_SOURCE = `
  export default function plugin(bb: any) {
    bb.agents.registerTool({
      name: "echo_context",
      description: "Echo params and call context",
      parameters: { type: "object" },
      execute: (params: any, ctx: any) =>
        "thread=" + ctx.threadId +
        " project=" + ctx.projectId +
        " params=" + JSON.stringify(params),
    });
    bb.agents.registerTool({
      name: "unselected_tool",
      description: "Registered but never selected",
      parameters: { type: "object" },
      execute: () => "must not run",
    });
    bb.agents.configure(() => ({ tools: ["echo_context"], skills: [] }));
  }
`;

async function createFixture(): Promise<Fixture> {
  const harness = await createTestAppHarness();
  harnesses.push(harness);
  const pluginsDir = await mkdtemp(join(tmpdir(), "bb-native-tools-"));
  pluginDirs.push(pluginsDir);
  const rootDir = join(pluginsDir, "bb-plugin-native-tools");
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: "bb-plugin-native-tools",
      version: "0.1.0",
      bb: {
        name: "Native tools fixture",
        description: "Agent tool fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), PLUGIN_SOURCE);
  expect((await harness.pluginService.installPath(rootDir)).status).toBe(
    "running",
  );
  const seeded = seedHostSession(harness.deps, { id: "native-tools-host" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: seeded.host.id,
    path: "/tmp/native-tools-project",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: seeded.host.id,
    path: "/tmp/native-tools-workspace",
    projectId: project.id,
    status: "ready",
  });
  const terminalOpens: { requestId: string; terminalId: string }[] = [];
  harness.hub.registerDaemon(seeded.session.id, seeded.host.id, {
    close: vi.fn(),
    send: vi.fn((data: string) => {
      const message = JSON.parse(data) as {
        requestId?: string;
        terminalId?: string;
        type: string;
      };
      if (
        message.type === "terminal.open" &&
        message.terminalId &&
        message.requestId
      ) {
        terminalOpens.push({
          requestId: message.requestId,
          terminalId: message.terminalId,
        });
      }
    }),
  });
  return {
    environmentId: environment.id,
    harness,
    hostId: seeded.host.id,
    pluginsDir,
    projectId: project.id,
    sessionId: seeded.session.id,
    terminalOpens,
  };
}

async function createNativeThread(fixture: Fixture): Promise<string> {
  const response = await fixture.harness.app.request("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: fixture.projectId,
      providerId: "claude-code",
      origin: "cli",
      input: [],
      environment: { type: "reuse", environmentId: fixture.environmentId },
      nativeTerminal: true,
    }),
  });
  expect(response.status).toBe(201);
  const thread = threadResponseSchema.parse(await readJson(response));
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (fixture.terminalOpens.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const open = fixture.terminalOpens[0];
  if (open === undefined) throw new Error("terminal never opened");
  const terminalId = open.terminalId;
  fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
    hostId: fixture.hostId,
    sessionId: fixture.sessionId,
    message: {
      type: "terminal.opened",
      requestId: open.requestId,
      terminalId,
      shell: "/bin/zsh",
      title: "zsh",
      initialCwd: "/tmp/native-tools-workspace",
      cols: 80,
      rows: 24,
    },
  });
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (
      getNativeTerminalThread(fixture.harness.db, thread.id)
        ?.terminalSessionId === terminalId
    ) {
      return thread.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("terminal never bound");
}

type Surface = "native-terminal" | "chat-internal";

interface ToolResponse {
  contentItems: { type: string; text?: string }[];
  success: boolean;
}

async function callTool(
  fixture: Fixture,
  surface: Surface,
  threadId: string,
  tool: string,
  args: unknown,
): Promise<ToolResponse> {
  const response =
    surface === "native-terminal"
      ? await fixture.harness.app.request(
          `/api/v1/threads/${threadId}/native-terminal/agent-tools/${tool}/call`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ callId: "call-1", arguments: args }),
          },
        )
      : await fixture.harness.app.request("/internal/session/tool-call", {
          method: "POST",
          headers: internalAuthHeaders(fixture.harness),
          body: JSON.stringify({
            sessionId: fixture.sessionId,
            threadId,
            providerThreadId: "provider-thread",
            turnId: "turn-1",
            callId: "call-1",
            tool,
            arguments: args,
          }),
        });
  expect(response.status).toBe(200);
  return (await readJson(response)) as ToolResponse;
}

describe("native terminal agent tools", () => {
  it("gives a native terminal the same tool results as the chat tool-call path", async () => {
    const fixture = await createFixture();
    const threadId = await createNativeThread(fixture);
    const table: { args: unknown; tool: string }[] = [
      { tool: "echo_context", args: { foo: 1 } },
      { tool: "echo_context", args: {} },
    ];
    for (const row of table) {
      const native = await callTool(
        fixture,
        "native-terminal",
        threadId,
        row.tool,
        row.args,
      );
      const chat = await callTool(
        fixture,
        "chat-internal",
        threadId,
        row.tool,
        row.args,
      );
      expect(native).toEqual(chat);
    }
    const echo = await callTool(
      fixture,
      "native-terminal",
      threadId,
      "echo_context",
      { foo: 1 },
    );
    expect(echo.success).toBe(true);
    expect(echo.contentItems[0]?.text).toContain(`thread=${threadId}`);
  });

  it("lists the tools a chat turn on the same thread receives", async () => {
    const fixture = await createFixture();
    const threadId = await createNativeThread(fixture);
    const listed = nativeTerminalAgentToolsSchema.parse(
      await readJson(
        await fixture.harness.app.request(
          `/api/v1/threads/${threadId}/native-terminal/agent-tools`,
        ),
      ),
    );
    const thread = fixture.harness.db
      .select()
      .from(threads)
      .where(eq(threads.id, threadId))
      .get();
    if (thread === undefined) throw new Error("thread missing");
    fixture.harness.hub.unregisterDaemon(fixture.sessionId);
    registerTestHostRpcCapture(fixture.harness, {
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
    });
    const environment = getEnvironment(
      fixture.harness.db,
      thread.environmentId ?? "",
    );
    if (environment === null) throw new Error("environment missing");
    const execution = await buildExecutionOptions(
      fixture.harness.deps,
      { model: "claude-sonnet-5-5" },
      { threadId },
    );
    const chatTools = (
      await prepareTurnSubmitCommandPayload(fixture.harness.deps, {
        environment,
        execution,
        permissionEscalation: "ask",
        input: [],
        providerThreadId: "provider-thread",
        target: { mode: "start" },
        thread,
      })
    ).resumeContext.dynamicTools;
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      chatTools
        .map((tool) => tool.name)
        .filter((name) => name !== UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME),
    );
    expect(listed.tools.map((tool) => tool.name)).toContain("echo_context");
  });

  it("rejects a tool outside the thread's resolved list without invoking it", async () => {
    const fixture = await createFixture();
    const threadId = await createNativeThread(fixture);
    for (const tool of [
      "unselected_tool",
      UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME,
    ]) {
      const response = await fixture.harness.app.request(
        `/api/v1/threads/${threadId}/native-terminal/agent-tools/${tool}/call`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callId: "c", arguments: {} }),
        },
      );
      expect(response.status).toBe(404);
    }
  });

  it("answers 404 for a chat thread", async () => {
    const fixture = await createFixture();
    const chat = seedThread(fixture.harness.deps, {
      projectId: fixture.projectId,
      environmentId: fixture.environmentId,
      status: "idle",
    });
    const list = await fixture.harness.app.request(
      `/api/v1/threads/${chat.id}/native-terminal/agent-tools`,
    );
    expect(list.status).toBe(404);
    const call = await fixture.harness.app.request(
      `/api/v1/threads/${chat.id}/native-terminal/agent-tools/echo_context/call`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId: "c", arguments: {} }),
      },
    );
    expect(call.status).toBe(404);
  });

  it("answers 409 once the terminal exited or the thread is archived", async () => {
    const fixture = await createFixture();
    const threadId = await createNativeThread(fixture);
    const call = () =>
      fixture.harness.app.request(
        `/api/v1/threads/${threadId}/native-terminal/agent-tools/echo_context/call`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callId: "c", arguments: {} }),
        },
      );
    expect((await call()).status).toBe(200);
    fixture.harness.db
      .update(threads)
      .set({ archivedAt: Date.now() })
      .where(eq(threads.id, threadId))
      .run();
    expect((await call()).status).toBe(409);
    fixture.harness.db
      .update(threads)
      .set({ archivedAt: null })
      .where(eq(threads.id, threadId))
      .run();
    fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.hostId,
      sessionId: fixture.sessionId,
      message: {
        type: "terminal.exited",
        terminalId: fixture.terminalOpens[0]?.terminalId ?? "",
        exitCode: 0,
        closeReason: "process-exit",
      },
    });
    const exited = await call();
    expect(exited.status).toBe(409);
    expect(
      await fixture.harness.app.request(
        `/api/v1/threads/${threadId}/native-terminal/agent-tools`,
      ),
    ).toHaveProperty("status", 409);
  });

  it("applies the public API origin guard to both routes", async () => {
    const fixture = await createFixture();
    const threadId = await createNativeThread(fixture);
    const list = await fixture.harness.app.request(
      `/api/v1/threads/${threadId}/native-terminal/agent-tools`,
      { headers: { origin: "https://evil.example" } },
    );
    expect(list.status).toBe(403);
    const call = await fixture.harness.app.request(
      `/api/v1/threads/${threadId}/native-terminal/agent-tools/echo_context/call`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify({ callId: "c", arguments: {} }),
      },
    );
    expect(call.status).toBe(403);
  });
});
