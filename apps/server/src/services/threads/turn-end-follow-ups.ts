import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import {
  events as storedEvents,
  getQueuedRetryOfTurnRequest,
  getThread,
  isStoredTurnContextCompactionOnly,
  isTurnAimedAtByEarlierStop,
} from "@bb/db";
import {
  systemThreadInterruptedEventDataSchema,
  type ChildThreadOutcome,
  type HeldTurnCompletionStatus,
  type ThreadEventTurnStatus,
} from "@bb/domain";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { waitForPluginTurnFailed } from "../plugins/plugin-thread-events.js";
import { queueChildThreadTurnNotificationBestEffort } from "./child-thread-notifications.js";
import { loadFailedTurn, retryChain } from "./turn-failed.js";
import { isParentNotifiableChildThread } from "./thread-parent.js";
import {
  continueAfterEnvironmentDirectoryUpdate,
  findEnvironmentDirectoryContinuation,
  type EnvironmentDirectoryContinuation,
} from "./environment-directory-continuation.js";
import {
  runQueuedMessageDispatch,
  type QueuedMessageDispatchWake,
} from "./queued-message-dispatch.js";
import {
  isCommandTimeoutError,
  runtimeErrorLogFields,
} from "../lib/error-log-fields.js";

interface HasThreadCommandFailureSystemErrorForTurnDeps {
  db: AppDeps["db"];
}

interface HasThreadCommandFailureSystemErrorForTurnArgs {
  threadId: string;
  turnId: string;
}

interface TurnKey {
  threadId: string;
  turnId: string;
}

export interface ParentTurnRetryContext {
  failedRequestId: string;
  originalRequestId: string;
}

type RetryAfterFailure =
  | { kind: "queued"; sendAt: number | null }
  | { kind: "dispatched" }
  | null;

const PARENT_FAILURE_RETRY_DECISION_TIMEOUT_MS = 10_000;
const PARENT_RETRY_SCHEDULE_NOTICE_THRESHOLD_MS = 2 * 60 * 1_000;

interface AddParentTurnNotificationFollowUpArgs {
  failedParentNotificationThreadIds: Set<string>;
  followUps: TurnEndFollowUp[] | ParentTurnNotificationFollowUp[];
  thread: NonNullable<ReturnType<typeof getThread>>;
  turnStatus: ThreadEventTurnStatus;
  turnId: string | null;
  interruption?: ChildThreadOutcome["interruption"];
  retry?: ParentTurnRetryContext;
}

export interface ParentTurnNotificationFollowUp {
  kind: "parent-turn-notification";
  childThreadId: string;
  projectId: string;
  parentThreadId: string;
  title: string | null;
  turnStatus: ThreadEventTurnStatus;
  turnId: string | null;
  interruption?: ChildThreadOutcome["interruption"];
  retry?: ParentTurnRetryContext;
}

interface QueuedMessageDispatchFollowUp {
  kind: "queued-message-dispatch";
  wake: Extract<
    QueuedMessageDispatchWake,
    { kind: "thread-ready" } | { kind: "turn-started" }
  >;
}

interface EnvironmentDirectoryContinuationFollowUp {
  kind: "environment-directory-continuation";
  continuation: EnvironmentDirectoryContinuation;
  parentNotification: ParentTurnNotificationFollowUp | null;
  threadId: string;
}

export type TurnEndFollowUp =
  | EnvironmentDirectoryContinuationFollowUp
  | ParentTurnNotificationFollowUp
  | QueuedMessageDispatchFollowUp;

function hasThreadCommandFailureSystemErrorForTurn(
  deps: HasThreadCommandFailureSystemErrorForTurnDeps,
  args: HasThreadCommandFailureSystemErrorForTurnArgs,
): boolean {
  return (
    deps.db
      .select({ id: storedEvents.id })
      .from(storedEvents)
      .where(
        and(
          eq(storedEvents.threadId, args.threadId),
          eq(storedEvents.turnId, args.turnId),
          eq(storedEvents.scopeKind, "turn"),
          eq(storedEvents.type, "system/error"),
          sql`json_extract(${storedEvents.data}, '$.code') = 'thread_command_failed'`,
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function wasTurnManuallyStopped(
  deps: Pick<AppDeps, "db">,
  args: TurnKey,
): boolean {
  const turnStarted = deps.db
    .select({ sequence: storedEvents.sequence })
    .from(storedEvents)
    .where(
      and(
        eq(storedEvents.threadId, args.threadId),
        eq(storedEvents.turnId, args.turnId),
        eq(storedEvents.type, "turn/started"),
      ),
    )
    .limit(1)
    .get();
  if (!turnStarted) return false;

  return (
    deps.db
      .select({ id: storedEvents.id })
      .from(storedEvents)
      .where(
        and(
          eq(storedEvents.threadId, args.threadId),
          eq(storedEvents.type, "system/thread/interrupted"),
          gt(storedEvents.sequence, turnStarted.sequence),
          sql`json_extract(${storedEvents.data}, '$.reason') = 'manual-stop'`,
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function getTurnInterruption(
  deps: Pick<AppDeps, "db">,
  args: TurnKey,
): ChildThreadOutcome["interruption"] {
  const turnStarted = deps.db
    .select({ sequence: storedEvents.sequence })
    .from(storedEvents)
    .where(
      and(
        eq(storedEvents.threadId, args.threadId),
        eq(storedEvents.turnId, args.turnId),
        eq(storedEvents.type, "turn/started"),
      ),
    )
    .limit(1)
    .get();
  if (!turnStarted) {
    return undefined;
  }

  const turnCompleted = deps.db
    .select({ sequence: sql<number>`${storedEvents.sequence}` })
    .from(
      sql`${storedEvents} INDEXED BY events_thread_turn_type_item_sequence_idx`,
    )
    .where(
      and(
        eq(storedEvents.threadId, args.threadId),
        eq(storedEvents.turnId, args.turnId),
        eq(storedEvents.type, "turn/completed"),
      ),
    )
    .orderBy(desc(storedEvents.sequence))
    .limit(1)
    .get();
  if (!turnCompleted) return undefined;

  const interruption = deps.db
    .select({ data: sql<string>`${storedEvents.data}` })
    .from(sql`${storedEvents} INDEXED BY events_thread_type_sequence_idx`)
    .where(
      and(
        eq(storedEvents.threadId, args.threadId),
        eq(storedEvents.type, "system/thread/interrupted"),
        gt(storedEvents.sequence, turnStarted.sequence),
        lt(storedEvents.sequence, turnCompleted.sequence),
      ),
    )
    .orderBy(desc(storedEvents.sequence))
    .limit(1)
    .get();
  if (interruption === undefined) return undefined;
  if (typeof interruption.data !== "string") {
    throw new Error("Stored interruption event data must be text");
  }
  return systemThreadInterruptedEventDataSchema.parse(
    JSON.parse(interruption.data),
  );
}

export function parentTurnRetryContext(
  db: AppDeps["db"],
  threadId: string,
): ParentTurnRetryContext | undefined {
  const failed = loadFailedTurn(db, threadId);
  if (failed === null) return undefined;
  return {
    failedRequestId: failed.request.requestId,
    originalRequestId: retryChain(failed.request).originalRequestId,
  };
}

function retryAfterFailure(
  deps: Pick<AppDeps, "db">,
  args: { threadId: string; retry: ParentTurnRetryContext },
): RetryAfterFailure {
  const queuedRetry = getQueuedRetryOfTurnRequest(deps.db, {
    threadId: args.threadId,
    retryOfTurnRequestId: args.retry.originalRequestId,
  });
  if (queuedRetry !== null) {
    return { kind: "queued", sendAt: queuedRetry.sendAt };
  }
  const latest = loadFailedTurn(deps.db, args.threadId);
  return latest !== null &&
    latest.request.requestId !== args.retry.failedRequestId &&
    retryChain(latest.request).originalRequestId ===
      args.retry.originalRequestId
    ? { kind: "dispatched" }
    : null;
}

export function addParentTurnNotificationFollowUp(
  args: AddParentTurnNotificationFollowUpArgs,
): void {
  if (!isParentNotifiableChildThread(args.thread, args.turnStatus)) {
    return;
  }
  if (args.turnStatus === "failed") {
    if (args.failedParentNotificationThreadIds.has(args.thread.id)) {
      return;
    }
    args.failedParentNotificationThreadIds.add(args.thread.id);
  }
  args.followUps.push({
    kind: "parent-turn-notification",
    childThreadId: args.thread.id,
    projectId: args.thread.projectId,
    parentThreadId: args.thread.parentThreadId,
    title: args.thread.title,
    turnStatus: args.turnStatus,
    ...(args.retry ? { retry: args.retry } : {}),
    turnId: args.turnId,
    ...(args.interruption ? { interruption: args.interruption } : {}),
  });
}

export async function executeTurnEndFollowUpBestEffort(
  deps: LoggedPendingInteractionWorkSessionDeps,
  followUp: TurnEndFollowUp,
): Promise<void> {
  try {
    switch (followUp.kind) {
      case "parent-turn-notification":
        if (followUp.turnStatus === "failed" && followUp.retry) {
          await waitForPluginTurnFailed(
            followUp.childThreadId,
            PARENT_FAILURE_RETRY_DECISION_TIMEOUT_MS,
          );
          const retry = retryAfterFailure(deps, {
            threadId: followUp.childThreadId,
            retry: followUp.retry,
          });
          if (retry?.kind === "dispatched") return;
          if (retry?.kind === "queued") {
            const noticeThreshold =
              Date.now() + PARENT_RETRY_SCHEDULE_NOTICE_THRESHOLD_MS;
            if (retry.sendAt === null || retry.sendAt <= noticeThreshold) {
              return;
            }
            await queueChildThreadTurnNotificationBestEffort(deps, {
              childThread: {
                id: followUp.childThreadId,
                projectId: followUp.projectId,
                title: followUp.title,
              },
              parentThreadId: followUp.parentThreadId,
              turnId: null,
              turnStatus: followUp.turnStatus,
              retryScheduledAt: retry.sendAt,
            });
            return;
          }
        }
        await queueChildThreadTurnNotificationBestEffort(deps, {
          childThread: {
            id: followUp.childThreadId,
            projectId: followUp.projectId,
            title: followUp.title,
          },
          parentThreadId: followUp.parentThreadId,
          turnStatus: followUp.turnStatus,
          turnId: followUp.turnId,
          ...(followUp.interruption
            ? { interruption: followUp.interruption }
            : {}),
        });
        return;
      case "queued-message-dispatch":
        await runQueuedMessageDispatch(deps, followUp.wake);
        return;
      case "environment-directory-continuation": {
        await runQueuedMessageDispatch(deps, {
          kind: "thread-ready",
          threadId: followUp.threadId,
        });
        let continued = false;
        try {
          continued = await continueAfterEnvironmentDirectoryUpdate(deps, {
            ...followUp.continuation,
            threadId: followUp.threadId,
          });
        } finally {
          if (!continued && followUp.parentNotification) {
            await executeTurnEndFollowUpBestEffort(
              deps,
              followUp.parentNotification,
            );
          }
        }
        return;
      }
    }
  } catch (error) {
    if (isCommandTimeoutError(error)) {
      deps.logger.warn(
        {
          followUp,
          ...runtimeErrorLogFields(deps.config, error),
        },
        "Event follow-up deferred by host timeout",
      );
      return;
    }
    deps.logger.error(
      {
        err: error,
        followUp,
      },
      "Failed to run event follow-up",
    );
  }
}

type TurnEndThread = NonNullable<ReturnType<typeof getThread>>;

export interface TurnEndPlan {
  continuation: EnvironmentDirectoryContinuation | null;
  parentNotifications: ParentTurnNotificationFollowUp[];
}

export function planTurnEnd(
  deps: Pick<AppDeps, "db">,
  args: {
    aimedAtByStop: boolean;
    failedParentNotificationThreadIds: Set<string>;
    status: HeldTurnCompletionStatus;
    thread: TurnEndThread;
    turnId: string;
  },
): TurnEndPlan {
  const { thread, turnId } = args;
  if (args.aimedAtByStop) {
    return { continuation: null, parentNotifications: [] };
  }
  const continuation =
    args.status === "completed" &&
    !wasTurnManuallyStopped(deps, { threadId: thread.id, turnId })
      ? findEnvironmentDirectoryContinuation(deps, {
          threadId: thread.id,
          turnId,
        })
      : null;
  const parentNotifications: ParentTurnNotificationFollowUp[] = [];
  if (isParentNotifiableChildThread(thread, args.status)) {
    const alreadyHandledByCommandFailure =
      args.status === "failed" &&
      hasThreadCommandFailureSystemErrorForTurn(deps, {
        threadId: thread.id,
        turnId,
      });
    const interruption =
      args.status === "interrupted"
        ? getTurnInterruption(deps, { threadId: thread.id, turnId })
        : undefined;
    const manuallyStopped =
      interruption?.reason === "manual-stop" ||
      (args.status === "interrupted" &&
        wasTurnManuallyStopped(deps, { threadId: thread.id, turnId }));
    const compactionOnly =
      args.status === "completed" &&
      isStoredTurnContextCompactionOnly(deps.db, {
        threadId: thread.id,
        turnId,
      });
    if (
      !alreadyHandledByCommandFailure &&
      !manuallyStopped &&
      !compactionOnly
    ) {
      const retry =
        args.status === "failed"
          ? parentTurnRetryContext(deps.db, thread.id)
          : undefined;
      addParentTurnNotificationFollowUp({
        failedParentNotificationThreadIds:
          args.failedParentNotificationThreadIds,
        followUps: parentNotifications,
        thread,
        turnStatus: args.status,
        ...(retry ? { retry } : {}),
        turnId,
        ...(interruption ? { interruption } : {}),
      });
    }
  }
  return { continuation, parentNotifications };
}

export function idleFollowUpForTurnEnd(
  plan: TurnEndPlan,
  args: { status: HeldTurnCompletionStatus; threadId: string },
): TurnEndFollowUp | null {
  if (args.status !== "completed") return null;
  if (plan.continuation !== null) {
    return {
      kind: "environment-directory-continuation",
      continuation: plan.continuation,
      parentNotification: plan.parentNotifications[0] ?? null,
      threadId: args.threadId,
    };
  }
  return {
    kind: "queued-message-dispatch",
    wake: { kind: "thread-ready", threadId: args.threadId },
  };
}

export async function runReleasedTurnFollowUps(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    status: HeldTurnCompletionStatus;
    threadId: string;
    turnId: string;
  },
): Promise<void> {
  const thread = getThread(deps.db, args.threadId);
  if (thread === null) return;
  const plan = planTurnEnd(deps, {
    aimedAtByStop: isTurnAimedAtByEarlierStop(deps.db, {
      threadId: args.threadId,
      turnId: args.turnId,
    }),
    failedParentNotificationThreadIds: new Set(),
    status: args.status,
    thread,
    turnId: args.turnId,
  });
  const followUp = idleFollowUpForTurnEnd(plan, args);
  if (followUp !== null) {
    await executeTurnEndFollowUpBestEffort(deps, followUp);
  }
}
