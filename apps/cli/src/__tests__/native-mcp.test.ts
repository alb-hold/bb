import { PassThrough } from "node:stream";
import {
  providerNativeTerminalSchema,
  type DynamicTool,
  type ProviderNativeTerminal,
  type ToolCallResponse,
} from "@bb/domain";
import { describe, expect, it } from "vitest";
import { nativeMcpArgs } from "../native-harness.js";
import { runNativeMcpServer, type NativeMcpBackend } from "../native-mcp.js";

const TOOLS: DynamicTool[] = [
  {
    name: "browser_instances",
    description: "List browser instances",
    inputSchema: { type: "object", properties: {} },
  },
  { name: "schemaless", description: "No schema", inputSchema: undefined },
];

interface Session {
  finish(): Promise<void>;
  request(message: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function startServer(backend: NativeMcpBackend): Session {
  const input = new PassThrough();
  const output = new PassThrough();
  const waiting = new Map<
    string | number,
    (message: Record<string, unknown>) => void
  >();
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const message = JSON.parse(buffer.slice(0, newline)) as Record<
        string,
        unknown
      >;
      buffer = buffer.slice(newline + 1);
      const resolve = waiting.get(message.id as number);
      resolve?.(message);
      newline = buffer.indexOf("\n");
    }
  });
  const done = runNativeMcpServer(backend, { input, output });
  let nextId = 0;
  return {
    request(message) {
      nextId += 1;
      const id = nextId;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        input.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...message })}\n`);
      });
    },
    async finish() {
      input.end();
      await done;
    },
  };
}

function backend(
  calls: { arguments: Record<string, unknown>; tool: string }[],
  response: ToolCallResponse,
): NativeMcpBackend {
  return {
    listTools: async () => TOOLS,
    callTool: async (call) => {
      calls.push({ tool: call.tool, arguments: call.arguments });
      return response;
    },
  };
}

describe("native MCP server", () => {
  it("initializes, lists the thread's tools and forwards calls", async () => {
    const calls: { arguments: Record<string, unknown>; tool: string }[] = [];
    const session = startServer(
      backend(calls, {
        success: true,
        contentItems: [{ type: "inputText", text: "no instances" }],
      }),
    );
    const init = await session.request({
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect(init.result).toMatchObject({
      protocolVersion: "2025-03-26",
      serverInfo: { name: "bb-bridge" },
    });
    const list = await session.request({ method: "tools/list" });
    expect(list.result).toEqual({
      tools: [
        {
          name: "browser_instances",
          description: "List browser instances",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "schemaless",
          description: "No schema",
          inputSchema: { type: "object" },
        },
      ],
    });
    const call = await session.request({
      method: "tools/call",
      params: { name: "browser_instances", arguments: { all: true } },
    });
    expect(call.result).toEqual({
      content: [{ type: "text", text: "no instances" }],
    });
    expect(calls).toEqual([
      { tool: "browser_instances", arguments: { all: true } },
    ]);
    await session.finish();
  });

  it("reports tool failures, images and transport errors as MCP errors", async () => {
    const failing = startServer(
      backend([], {
        success: false,
        contentItems: [
          { type: "inputText", text: "denied" },
          { type: "inputImage", imageUrl: "data:image/png;base64,QUJD" },
        ],
      }),
    );
    const failed = await failing.request({
      method: "tools/call",
      params: { name: "x" },
    });
    expect(failed.result).toEqual({
      content: [
        { type: "text", text: "denied" },
        { type: "image", data: "QUJD", mimeType: "image/png" },
      ],
      isError: true,
    });
    await failing.finish();

    const broken = startServer({
      listTools: async () => {
        throw new Error("409 native terminal is not running");
      },
      callTool: async () => {
        throw new Error("409 native terminal is not running");
      },
    });
    const call = await broken.request({
      method: "tools/call",
      params: { name: "x" },
    });
    expect(call.result).toEqual({
      content: [{ type: "text", text: "409 native terminal is not running" }],
      isError: true,
    });
    const list = await broken.request({ method: "tools/list" });
    expect(list.error).toMatchObject({
      message: "409 native terminal is not running",
    });
    await broken.finish();
  });
});

const SERVER = {
  command: "/usr/local/bin/node",
  args: ["/opt/bb/cli.js", "thread", "native-mcp", "thr_abc"],
};

describe("native MCP launch arguments", () => {
  const claude: ProviderNativeTerminal = providerNativeTerminalSchema.parse({
    executable: "claude",
    launchArgs: [],
    modelArgs: [],
    pastePlaceholders: [],
    sessionRoot: { env: null, home: ".claude" },
    session: {
      kind: "assigned",
      startArgs: ["--session-id", "{sessionId}"],
      resumeArgs: ["--resume", "{sessionId}"],
      transcript: "projects/*/{sessionId}.jsonl",
    },
    mcp: [
      "--mcp-config",
      '{"mcpServers":{"bb-bridge":{"command":{commandJson},"args":{argsJson}}}}',
    ],
  });

  it("renders claude's inline MCP config with no secret in it", () => {
    const [flag, config] = nativeMcpArgs(claude, SERVER);
    expect(flag).toBe("--mcp-config");
    expect(JSON.parse(config ?? "")).toEqual({
      mcpServers: {
        "bb-bridge": { command: SERVER.command, args: SERVER.args },
      },
    });
  });

  it("renders codex's config overrides as TOML values", () => {
    const codex = providerNativeTerminalSchema.parse({
      ...claude,
      executable: "codex",
      mcp: [
        "-c",
        "mcp_servers.bb-bridge.command={commandJson}",
        "-c",
        "mcp_servers.bb-bridge.args={argsJson}",
      ],
    });
    expect(nativeMcpArgs(codex, SERVER)).toEqual([
      "-c",
      'mcp_servers.bb-bridge.command="/usr/local/bin/node"',
      "-c",
      'mcp_servers.bb-bridge.args=["/opt/bb/cli.js","thread","native-mcp","thr_abc"]',
    ]);
  });

  it("adds nothing for a provider that declares no MCP arguments", () => {
    expect(nativeMcpArgs({ ...claude, mcp: undefined }, SERVER)).toEqual([]);
  });

  it("rejects an mcp declaration that omits the command or arguments", () => {
    const parsed = providerNativeTerminalSchema.safeParse({
      ...claude,
      mcp: ["--mcp-config", "{commandJson}"],
    });
    expect(parsed.success).toBe(false);
  });
});
