import {
  getLatestStoredThreadEventOfTypes,
  getThread,
  hasRootStoredTurnStarted,
} from "@bb/db";
import {
  providerErrorInfoSchema,
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
): boolean {
  const row = getLatestStoredThreadEventOfTypes(db, {
    threadId,
    types: ["provider/error"],
    afterSequence: 0,
  });
  if (row === null || row.turnId !== turnId) return false;
  try {
    const parsed = providerErrorInfoSchema.safeParse(
      (JSON.parse(row.data) as { errorInfo?: unknown }).errorInfo,
    );
    return parsed.success && parsed.data.category === "unauthorized";
  } catch {
    return false;
  }
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
    isArchivedCredentialRevocation(deps.db, thread.id, turnId);
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
