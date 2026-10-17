import { Buffer } from "node:buffer";
import { getThread, updateThread } from "@bb/db";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";

export function registerDeviceHandoffRoutes(app: Hono, deps: AppDeps): void {
  const { post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(
        400,
        "invalid_request",
        `Invalid device handoff: ${message}`,
      ),
  });

  post(publicApiRoutes.deviceHandoff.request, (context, request) => {
    if (
      request.kind === "copy-text" &&
      Buffer.byteLength(request.text, "utf8") > 1024 * 1024
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "Copy text exceeds the 1 MiB limit",
      );
    }
    if (
      request.kind === "open-url" &&
      Buffer.byteLength(request.url, "utf8") > 8 * 1024
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "Open URL exceeds the 8 KiB limit",
      );
    }
    const thread = request.origin.threadId
      ? getThread(deps.db, request.origin.threadId)
      : undefined;
    const terminal = request.origin.terminalSessionId
      ? deps.terminalSessions.getTerminal({
          terminalId: request.origin.terminalSessionId,
        })
      : undefined;
    const originLabel = (terminal?.title ?? thread?.title ?? "BB").slice(
      0,
      256,
    );
    const delivered = deps.hub.notifyDeviceHandoff(request, originLabel);
    if (delivered === 0) {
      const attentionThreadId = thread?.id ?? terminal?.threadId;
      if (attentionThreadId !== undefined && attentionThreadId !== null) {
        updateThread(deps.db, deps.hub, attentionThreadId, {
          latestAttentionAt: Date.now(),
        });
      }
    }
    return context.json({ delivered });
  });
}
