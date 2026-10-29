import { and, desc, eq } from "drizzle-orm";
import { events, getThread, hasRootStoredTurnStarted } from "@bb/db";
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
import { z } from "zod";

const terminalProviderErrorDataSchema = z.object({
  willRetry: z.boolean().optional(),
  errorInfo: providerErrorInfoSchema.optional(),
});

function isArchivedCredentialRevocation(
  db: AppDeps["db"],
  threadId: string,
  turnId: string,
  archivedAt: number,
): boolean {
  const turnStart = db
    .select({
      createdAt: events.createdAt,
    })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.turnId, turnId),
        eq(events.type, "turn/started"),
      ),
    )
    .limit(1)
    .get();
  const latestProviderError = db
    .select({ createdAt: events.createdAt, data: events.data })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.turnId, turnId),
        eq(events.type, "provider/error"),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  let isUnauthorized = false;
  try {
    const terminalError = terminalProviderErrorDataSchema.safeParse(
      JSON.parse(latestProviderError?.data ?? "null"),
    );
    isUnauthorized =
      terminalError.success &&
      terminalError.data.willRetry !== true &&
      terminalError.data.errorInfo?.category === "unauthorized";
  } catch {
    isUnauthorized = false;
  }
  return (
    turnStart !== undefined &&
    turnStart.createdAt < archivedAt &&
    latestProviderError !== undefined &&
    latestProviderError.createdAt >= archivedAt &&
    isUnauthorized
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
