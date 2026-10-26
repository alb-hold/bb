import { performance } from "node:perf_hooks";
import {
  advanceThreadPruning,
  getThread,
  getThreadEventRewriteGeneration,
  THREAD_EVENT_KEEP_RECENT_BY_MODE,
  THREAD_PRUNING_POLICIES,
} from "@bb/db";
import type { ThreadEventType } from "@bb/domain";
import { roundDurationMs } from "@bb/process-utils";
import type { AppDeps } from "../../types.js";

type ThreadEventPruningMode = "active" | "archived" | "idle";

interface PruneThreadEventHistoryArgs {
  mode: ThreadEventPruningMode;
  threadId: string;
}

interface ThreadEventPruningResult {
  action: ReturnType<typeof advanceThreadPruning>["action"];
  latestSequence: number;
  policy: string;
  scanned: number;
  totalRemoved: number;
}

interface MaybePruneActiveThreadEventHistoryArgs {
  latestPrunableSequence: number;
  now?: () => number;
  threadId: string;
}

interface ActiveThreadPruneState {
  lastPrunedAt: number;
  lastPrunedSequence: number;
}

const ACTIVE_THREAD_EVENT_PRUNE_MIN_SEQUENCE_DELTA = 250;
const ACTIVE_THREAD_EVENT_PRUNE_MIN_INTERVAL_MS = 30_000;
export const ACTIVE_THREAD_EVENT_PRUNE_BUDGET_MS = 100;
const SLOW_THREAD_EVENT_PRUNE_LOG_THRESHOLD_MS = 50;

const ACTIVE_PRUNE_TRIGGER_THREAD_EVENT_TYPES: readonly ThreadEventType[] = [
  "thread/contextWindowUsage/updated",
  "thread/tokenUsage/updated",
  "provider/rateLimits/updated",
  "item/backgroundTask/progress",
] as const;

export const KEEP_RECENT_BY_MODE: Record<ThreadEventPruningMode, number> =
  THREAD_EVENT_KEEP_RECENT_BY_MODE;

const activePruneTriggerThreadEventTypeSet = new Set<ThreadEventType>(
  ACTIVE_PRUNE_TRIGGER_THREAD_EVENT_TYPES,
);
const activeThreadPruneStateByThreadId = new Map<
  string,
  ActiveThreadPruneState
>();

export function isActivePruneTriggerThreadEventType(
  eventType: ThreadEventType,
): boolean {
  return activePruneTriggerThreadEventTypeSet.has(eventType);
}

export function pruneThreadEventHistory(
  deps: Pick<AppDeps, "db">,
  args: PruneThreadEventHistoryArgs,
): ThreadEventPruningResult {
  const result = advanceThreadPruning(deps.db, { threadId: args.threadId });
  return {
    action: result.action,
    latestSequence: result.cursor.upperSequence,
    policy: result.policy,
    scanned: result.scanned,
    totalRemoved: result.removed,
  };
}

export function pruneThreadEventHistoryBestEffort(
  deps: Pick<AppDeps, "db" | "logger" | "hub">,
  args: PruneThreadEventHistoryArgs,
): ThreadEventPruningResult | null {
  const startedAt = performance.now();
  const generation = getThreadEventRewriteGeneration(args.threadId);
  try {
    const result = pruneThreadEventHistory(deps, args);

    const durationMs = performance.now() - startedAt;
    if (durationMs >= SLOW_THREAD_EVENT_PRUNE_LOG_THRESHOLD_MS) {
      deps.logger.warn(
        {
          durationMs: roundDurationMs(durationMs),
          latestSequence: result.latestSequence,
          mode: args.mode,
          threadId: args.threadId,
          totalRemoved: result.totalRemoved,
        },
        "Slow thread event pruning",
      );
    }
    return result;
  } catch (error) {
    deps.logger.warn(
      {
        durationMs: roundDurationMs(performance.now() - startedAt),
        mode: args.mode,
        threadId: args.threadId,
        err: error,
      },
      "Failed to prune thread event history",
    );
    return null;
  } finally {
    if (getThreadEventRewriteGeneration(args.threadId) !== generation) {
      deps.hub.notifyThread(args.threadId, ["history-compacted"]);
    }
  }
}

export function maybePruneActiveThreadEventHistory(
  deps: Pick<AppDeps, "db" | "logger" | "hub">,
  args: MaybePruneActiveThreadEventHistoryArgs,
): ThreadEventPruningResult | null {
  const thread = getThread(deps.db, args.threadId);
  if (
    !thread ||
    (thread.status !== "active" && thread.status !== "idle") ||
    thread.archivedAt !== null
  ) {
    return null;
  }

  const lastState = activeThreadPruneStateByThreadId.get(args.threadId);
  const lastPrunedSequence = lastState?.lastPrunedSequence ?? 0;
  if (
    args.latestPrunableSequence - lastPrunedSequence <
    ACTIVE_THREAD_EVENT_PRUNE_MIN_SEQUENCE_DELTA
  ) {
    return null;
  }

  const now = Date.now();
  const lastPrunedAt = lastState?.lastPrunedAt ?? 0;
  if (now - lastPrunedAt < ACTIVE_THREAD_EVENT_PRUNE_MIN_INTERVAL_MS) {
    return null;
  }

  activeThreadPruneStateByThreadId.set(args.threadId, {
    lastPrunedAt: now,
    lastPrunedSequence: args.latestPrunableSequence,
  });

  return pruneActiveThreadEventHistoryWithinBudget(deps, {
    mode: thread.status === "active" ? "active" : "idle",
    now: args.now,
    threadId: args.threadId,
  });
}

export function pruneActiveThreadEventHistoryWithinBudget(
  deps: Pick<AppDeps, "db" | "logger" | "hub">,
  args: { mode: "active" | "idle"; now?: () => number; threadId: string },
): ThreadEventPruningResult | null {
  const clock = args.now ?? (() => performance.now());
  const startedAt = clock();
  const totals = { scanned: 0, totalRemoved: 0 };
  const completedPolicies = new Set<string>();
  let latest: ThreadEventPruningResult | null = null;
  do {
    latest = pruneThreadEventHistoryBestEffort(deps, {
      mode: args.mode,
      threadId: args.threadId,
    });
    if (latest === null) return null;
    totals.scanned += latest.scanned;
    totals.totalRemoved += latest.totalRemoved;
    if (
      latest.action === "cycle-complete" ||
      latest.action === "thread-complete"
    )
      completedPolicies.add(latest.policy);
  } while (
    clock() - startedAt < ACTIVE_THREAD_EVENT_PRUNE_BUDGET_MS &&
    completedPolicies.size < THREAD_PRUNING_POLICIES.length
  );
  return { ...latest, ...totals };
}

export function resetActiveThreadEventPruningState(threadId: string): void {
  activeThreadPruneStateByThreadId.delete(threadId);
}
