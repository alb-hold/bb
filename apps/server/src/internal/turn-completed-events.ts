import { and, eq, inArray, sql } from "drizzle-orm";
import { events, getThread, hasRootStoredTurnStarted } from "@bb/db";
import {
  requireThreadEventScopeTurnId,
  type ThreadEvent,
  type ThreadLifecycleEvent,
  type ThreadStatus,
} from "@bb/domain";
import type { AppDeps } from "../types.js";
import {
  pruneThreadEventHistoryBestEffort,
  resetActiveThreadEventPruningState,
} from "../services/system/event-pruning.js";
import { applyLoggedThreadLifecycleEvent } from "../services/threads/lifecycle-outcome.js";

function isArchivedCredentialRevocation(
  db: AppDeps["db"],
  threadId: string,
  turnId: string,
  archivedAt: number,
): boolean {
  const result = db
    .select({
      turnStartedAt: sql<
        number | null
      >`MAX(CASE WHEN ${events.type} = 'turn/started' THEN ${events.createdAt} END)`,
      authFailureAt: sql<
        number | null
      >`MAX(CASE WHEN ${events.type} = 'provider/error' AND json_extract(${events.data}, '$.errorInfo.category') = 'unauthorized' THEN ${events.createdAt} END)`,
    })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.turnId, turnId),
        inArray(events.type, ["turn/started", "provider/error"]),
      ),
    )
    .get();
  return (
    result?.turnStartedAt !== null &&
    result?.turnStartedAt !== undefined &&
    result.turnStartedAt < archivedAt &&
    result.authFailureAt !== null &&
    result.authFailureAt >= archivedAt
  );
}

interface ApplyTurnCompletedEventResult {
  isRootTurnCompletion: boolean;
  suppressFailureNotice: boolean;
  nextStatus: ThreadStatus | null;
  thread: ReturnType<typeof getThread>;
}

function lifecycleEventForTurnCompletion(
  status: Extract<ThreadEvent, { type: "turn/completed" }>["status"],
): ThreadLifecycleEvent {
  if (status === "failed") {
    return { type: "run.failed" };
  }
  if (status === "interrupted") {
    return { type: "stop.settled" };
  }
  return { type: "run.succeeded" };
}

export function applyTurnCompletedEvent(
  deps: Pick<AppDeps, "db" | "hub" | "logger" | "providerRegistry">,
  payload: Extract<ThreadEvent, { type: "turn/completed" }>,
): ApplyTurnCompletedEventResult {
  const thread = getThread(deps.db, payload.threadId);
  if (!thread) {
    return {
      isRootTurnCompletion: false,
      suppressFailureNotice: false,
      nextStatus: null,
      thread: null,
    };
  }

  const turnId = requireThreadEventScopeTurnId({
    type: payload.type,
    scope: payload.scope,
  });
  const isRootTurnCompletion = hasRootStoredTurnStarted(deps.db, {
    threadId: payload.threadId,
    turnId,
  });
  if (!isRootTurnCompletion) {
    return {
      isRootTurnCompletion,
      suppressFailureNotice: false,
      nextStatus: null,
      thread,
    };
  }

  const suppressFailureNotice =
    payload.status === "failed" &&
    thread.archivedAt !== null &&
    isArchivedCredentialRevocation(
      deps.db,
      thread.id,
      turnId,
      thread.archivedAt,
    );
  const outcome = applyLoggedThreadLifecycleEvent(deps, {
    event: suppressFailureNotice
      ? { type: "run.succeeded" }
      : lifecycleEventForTurnCompletion(payload.status),
    threadId: payload.threadId,
  });
  const nextStatus = outcome.applied ? outcome.thread.status : null;

  if (nextStatus) {
    resetActiveThreadEventPruningState(deps, payload.threadId);
  }

  if (nextStatus === "idle") {
    pruneThreadEventHistoryBestEffort(deps, {
      mode: "idle",
      threadId: payload.threadId,
    });
  }

  return { isRootTurnCompletion, suppressFailureNotice, nextStatus, thread };
}
