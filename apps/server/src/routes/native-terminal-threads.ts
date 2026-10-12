import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import { runAgentToolCall } from "../internal/tool-calls.js";
import {
  findNativeTerminalThreadView,
  listNativeTerminalAgentTools,
  requireNativeTerminalAgentToolCall,
  openNativeTerminal,
  recordNativeTerminalSession,
  takeNativeTerminalLaunchSpec,
} from "../services/threads/native-terminal-threads.js";
import { recordNativeTerminalActivity } from "../services/threads/native-terminal-activity.js";
import { switchNativeTerminalMode } from "../services/threads/native-terminal-mode.js";
import type { AppDeps } from "../types.js";

export function registerNativeTerminalThreadRoutes(
  app: Hono,
  deps: AppDeps,
): void {
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });
  const routes = publicApiRoutes.nativeTerminalThreads;

  get(routes.get, (context) =>
    context.json(findNativeTerminalThreadView(deps, context.req.param("id"))),
  );

  post(routes.open, async (context, payload) =>
    context.json(
      await openNativeTerminal(deps, {
        threadId: context.req.param("id"),
        request: payload,
      }),
    ),
  );

  post(routes.launch, (context) =>
    context.json(takeNativeTerminalLaunchSpec(deps, context.req.param("id"))),
  );

  get(routes.agentTools, async (context) =>
    context.json(
      await listNativeTerminalAgentTools(deps, context.req.param("id")),
    ),
  );

  post(routes.callAgentTool, async (context, payload) => {
    const { environment, thread } = await requireNativeTerminalAgentToolCall(
      deps,
      { threadId: context.req.param("id"), tool: context.req.param("tool") },
    );
    return runAgentToolCall(deps, {
      callId: payload.callId,
      environment,
      input: payload.arguments,
      requestSignal: context.req.raw.signal,
      thread,
      tool: context.req.param("tool"),
      turnId: null,
    });
  });

  post(routes.switchMode, async (context, payload) =>
    context.json(
      await switchNativeTerminalMode(deps, {
        threadId: context.req.param("id"),
        mode: payload.mode,
      }),
    ),
  );

  post(routes.reportActivity, (context, payload) => {
    recordNativeTerminalActivity(deps, {
      threadId: context.req.param("id"),
      ...payload,
    });
    return context.json({ ok: true as const });
  });

  post(routes.recordSession, (context, payload) =>
    context.json(
      recordNativeTerminalSession(deps, {
        threadId: context.req.param("id"),
        nativeSessionId: payload.nativeSessionId,
      }),
    ),
  );
}
