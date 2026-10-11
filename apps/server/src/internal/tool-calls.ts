import {
  hostDaemonToolCallRequestSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { ToolCallResponse } from "@bb/domain";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import {
  requireThreadEnvironment,
  type ThreadEnvironmentLookupResult,
} from "../services/lib/entity-lookup.js";
import {
  findPluginAgentTool,
  invokePluginAgentTool,
} from "../services/plugins/plugin-agent-contributions.js";
import { deliverDetachedToolResult } from "../services/plugins/detached-tool-result-delivery.js";
import { requirePluginToolCallRegistry } from "../services/plugins/plugin-tool-calls.js";
import {
  handleUpdateEnvironmentDirectoryToolCall,
  UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME,
} from "../services/threads/thread-environment-directory.js";
import { requireAuthenticatedDaemonSession } from "./session-state.js";

const textEncoder = new TextEncoder();

function streamToolCallResponse(
  result: Promise<ToolCallResponse>,
  abortController: AbortController,
): Response {
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      abortController.abort();
    },
    start(controller) {
      void result.then(
        (response) => {
          try {
            controller.enqueue(textEncoder.encode(JSON.stringify(response)));
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
        (error) => controller.error(error),
      );
    },
  });
  return new Response(body, {
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

export interface RunAgentToolCallArgs extends ThreadEnvironmentLookupResult {
  callId: string;
  input: unknown;
  requestSignal: AbortSignal;
  tool: string;
  turnId: string | null;
}

export function runAgentToolCall(
  deps: AppDeps,
  args: RunAgentToolCallArgs,
): Response | Promise<Response> {
  if (args.tool === UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME) {
    if (args.turnId === null) {
      return Response.json(
        unsupportedToolResponse(args.tool),
      );
    }
    const turnId = args.turnId;
    return handleUpdateEnvironmentDirectoryToolCall(deps, {
      currentEnvironment: args.environment,
      input: args.input,
      thread: args.thread,
      turnId,
    }).then((response) => Response.json(response));
  }

  const pluginTool = findPluginAgentTool(args.tool);
  if (pluginTool) {
    const roundTrip = new AbortController();
    const response = requirePluginToolCallRegistry().run({
      pluginId: pluginTool.pluginId,
      threadId: args.thread.id,
      callId: args.callId,
      toolName: args.tool,
      roundTrip: AbortSignal.any([args.requestSignal, roundTrip.signal]),
      invoke: (signal) =>
        invokePluginAgentTool(pluginTool, {
          input: args.input,
          ctx: {
            threadId: args.thread.id,
            projectId: args.thread.projectId,
            signal,
          },
        }),
      onDetachedResult: (result) =>
        deliverDetachedToolResult(deps, {
          threadId: args.thread.id,
          toolName: args.tool,
          presentation: pluginTool.record.presentation,
          response: result,
        }),
    });
    return streamToolCallResponse(response, roundTrip);
  }

  return Response.json(unsupportedToolResponse(args.tool));
}

function unsupportedToolResponse(tool: string): ToolCallResponse {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: `Unsupported tool: ${tool}` }],
  };
}

export function registerInternalToolCallRoutes(app: Hono, deps: AppDeps): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post(
    "/session/tool-call",
    hostDaemonToolCallRequestSchema,
    async (context, payload) => {
      const session = requireAuthenticatedDaemonSession({
        context,
        db: deps.db,
        sessionId: payload.sessionId,
      });
      const { environment, thread } = requireThreadEnvironment(
        deps.db,
        payload.threadId,
      );
      if (environment.hostId !== session.hostId) {
        throw new ApiError(
          403,
          "invalid_request",
          "Thread does not belong to the session host",
        );
      }

      return runAgentToolCall(deps, {
        callId: payload.callId,
        environment,
        input: payload.arguments,
        requestSignal: context.req.raw.signal,
        thread,
        tool: payload.tool,
        turnId: payload.turnId,
      });
    },
  );
}
