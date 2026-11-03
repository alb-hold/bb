import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { DynamicTool, ToolCallResponse } from "@bb/domain";
import { z } from "zod";

export const NATIVE_MCP_SERVER_NAME = "bb-bridge";

const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

export interface NativeMcpBackend {
  callTool(args: {
    arguments: Record<string, unknown>;
    callId: string;
    signal: AbortSignal;
    tool: string;
  }): Promise<ToolCallResponse>;
  listTools(): Promise<DynamicTool[]>;
}

export interface NativeMcpStreams {
  input: Readable;
  output: Writable;
}

const jsonRpcMessageSchema = z.object({
  id: z.union([z.string(), z.number().int()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
});
type JsonRpcMessage = z.infer<typeof jsonRpcMessageSchema>;

const cancellationParamsSchema = z.object({
  requestId: z.union([z.string(), z.number().int()]),
});

const callParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

function normalizeInputSchema(
  inputSchema: unknown,
): Record<string, unknown> & { type: "object" } {
  const parsed = z
    .object({ type: z.literal("object") })
    .passthrough()
    .safeParse(inputSchema);
  return parsed.success ? parsed.data : { type: "object" };
}

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function toMcpContent(response: ToolCallResponse): McpContent[] {
  return response.contentItems.flatMap((item): McpContent[] => {
    if (item.type === "inputText") {
      return item.text === "" ? [] : [{ type: "text", text: item.text }];
    }
    const match = /^data:([^;,]+);base64,(.*)$/su.exec(item.imageUrl);
    return match === null
      ? []
      : [{ type: "image", data: match[2] ?? "", mimeType: match[1] ?? "" }];
  });
}

function toMcpResult(response: ToolCallResponse): {
  content: McpContent[];
  isError?: true;
} {
  const content = toMcpContent(response);
  return response.success ? { content } : { content, isError: true };
}

let nextCallId = 0;

function newCallId(tool: string): string {
  nextCallId += 1;
  return `native-mcp-${tool}-${Date.now()}-${nextCallId}`;
}

export function runNativeMcpServer(
  backend: NativeMcpBackend,
  streams: NativeMcpStreams,
): Promise<void> {
  const pending = new Map<string | number, AbortController>();
  const write = (message: unknown): void => {
    streams.output.write(`${JSON.stringify(message)}\n`);
  };
  const result = (id: string | number, value: unknown): void =>
    write({ jsonrpc: "2.0", id, result: value });
  const failure = (id: string | number, code: number, message: string): void =>
    write({ jsonrpc: "2.0", id, error: { code, message } });

  const handle = async (message: JsonRpcMessage): Promise<void> => {
    if (message.method === "notifications/cancelled") {
      const cancellation = cancellationParamsSchema.safeParse(message.params);
      if (cancellation.success) {
        pending.get(cancellation.data.requestId)?.abort();
      }
      return;
    }
    if (message.id === undefined || message.method === undefined) return;
    const id = message.id;
    switch (message.method) {
      case "initialize": {
        const requested = z
          .object({ protocolVersion: z.string() })
          .safeParse(message.params);
        result(id, {
          protocolVersion: requested.success
            ? requested.data.protocolVersion
            : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: NATIVE_MCP_SERVER_NAME, version: "1.0.0" },
        });
        return;
      }
      case "ping":
        result(id, {});
        return;
      case "tools/list":
        try {
          const tools = await backend.listTools();
          result(id, {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: normalizeInputSchema(tool.inputSchema),
            })),
          });
        } catch (error) {
          failure(
            id,
            -32603,
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      case "tools/call": {
        const params = callParamsSchema.safeParse(message.params);
        if (!params.success) {
          failure(id, -32602, "Invalid tools/call params");
          return;
        }
        const controller = new AbortController();
        pending.set(id, controller);
        try {
          const response = await backend.callTool({
            arguments: params.data.arguments ?? {},
            callId: newCallId(params.data.name),
            signal: controller.signal,
            tool: params.data.name,
          });
          if (controller.signal.aborted) return;
          result(id, toMcpResult(response));
        } catch (error) {
          if (controller.signal.aborted) return;
          result(id, {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
          });
        } finally {
          pending.delete(id);
        }
        return;
      }
      default:
        failure(id, -32601, `Unsupported MCP method: ${message.method}`);
    }
  };

  return new Promise((resolve) => {
    const lines = createInterface({ input: streams.input, terminal: false });
    const inflight = new Set<Promise<void>>();
    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let message: JsonRpcMessage;
      try {
        message = jsonRpcMessageSchema.parse(JSON.parse(trimmed));
      } catch {
        return;
      }
      const task = handle(message).finally(() => inflight.delete(task));
      inflight.add(task);
    });
    lines.on("close", () => {
      for (const controller of pending.values()) controller.abort();
      void Promise.allSettled([...inflight]).then(() => resolve());
    });
  });
}
