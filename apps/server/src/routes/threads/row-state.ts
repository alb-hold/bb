import {
  getThreadRowProgressOutputSeqs,
  getThreadRowProgressSourceTerminalId,
  getThreadRowState,
  putThreadRowState,
  raiseThreadRowProgressOutputSeqs,
} from "@bb/db";
import {
  publicApiRoutes,
  typedRoutes,
  threadRowStateSchema,
  type PublicApiSchema,
  type ThreadRowState,
  type UpdateThreadRowStateRequest,
} from "@bb/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../../errors.js";
import { requirePublicThread } from "../../services/lib/entity-lookup.js";
import type { AppDeps } from "../../types.js";

function applyUpdate(
  state: ThreadRowState,
  request: UpdateThreadRowStateRequest,
): ThreadRowState {
  switch (request.action) {
    case "status-set":
      return {
        ...state,
        statuses: { ...state.statuses, [request.key]: request.status },
      };
    case "status-clear": {
      if (request.key === undefined) return { ...state, statuses: {} };
      const statuses = { ...state.statuses };
      delete statuses[request.key];
      return { ...state, statuses };
    }
    case "progress-set":
      return { ...state, progress: request.progress };
    case "progress-clear":
      return { ...state, progress: null };
    case "clear":
      return { statuses: {}, progress: null };
  }
}

export function registerThreadRowStateRoutes(app: Hono, deps: AppDeps): void {
  const { get, patch } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  const routes = publicApiRoutes.threads;

  get(routes.rowState, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      threadRowStateSchema.parse(getThreadRowState(deps.db, thread.id)),
    );
  });

  patch(routes.updateRowState, (context, request) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const current = threadRowStateSchema.parse(getThreadRowState(deps.db, thread.id));
    const currentSourceTerminalId = getThreadRowProgressSourceTerminalId(
      deps.db,
      thread.id,
    );
    const reportedSeq =
      (request.action === "progress-set" ||
        request.action === "progress-clear") &&
      request.terminalId !== undefined &&
      request.outputSeq !== undefined
        ? { terminalId: request.terminalId, outputSeq: request.outputSeq }
        : null;
    if (reportedSeq !== null) {
      const mark = getThreadRowProgressOutputSeqs(deps.db, thread.id)[
        reportedSeq.terminalId
      ];
      if (mark !== undefined && reportedSeq.outputSeq <= mark) {
        return context.json(current);
      }
    }
    const raiseOutputSeqs = () => {
      if (reportedSeq !== null) {
        raiseThreadRowProgressOutputSeqs(deps.db, thread.id, {
          [reportedSeq.terminalId]: reportedSeq.outputSeq,
        });
        return;
      }
      if (
        request.action === "progress-set" ||
        request.action === "progress-clear" ||
        request.action === "clear"
      ) {
        raiseThreadRowProgressOutputSeqs(
          deps.db,
          thread.id,
          deps.terminalSessions.latestThreadOutputSeqs(
            thread.id,
            request.action === "clear" ? undefined : request.terminalId,
          ),
        );
      }
    };
    if (
      request.action === "progress-clear" &&
      request.force !== true &&
      (request.terminalId ?? null) !== currentSourceTerminalId
    ) {
      raiseOutputSeqs();
      return context.json(current);
    }
    const next = threadRowStateSchema.safeParse(applyUpdate(current, request));
    if (!next.success) {
      throw new ApiError(
        400,
        "invalid_request",
        next.error.issues[0]?.message ?? "Invalid thread row state",
      );
    }
    const sourceTerminalId =
      request.action === "progress-set"
        ? (request.terminalId ?? null)
        : request.action === "progress-clear" || request.action === "clear"
          ? null
          : currentSourceTerminalId;
    putThreadRowState(deps.db, thread.id, next.data, sourceTerminalId);
    raiseOutputSeqs();
    deps.hub.notifyThread(thread.id, ["status-changed"]);
    deps.hub.notifyProject(thread.projectId, ["threads-changed"]);
    return context.json(next.data);
  });
}
