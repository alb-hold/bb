import { performance } from "node:perf_hooks";
import {
  advanceThreadPruning,
  advanceThreadPruningStep,
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
  schedule?: ActiveThreadPruneScheduler;
  threadId: string;
  throttleNow?: () => number;
}

export interface ActiveThreadEventPruneRuntimeOptions {
  now?: () => number;
  schedule?: ActiveThreadPruneScheduler;
}

interface ActiveThreadPruneThrottleState {
  lastPrunedAt: number;
  lastPrunedSequence: number;
}

type ActiveThreadPruneScheduler = (callback: () => void) => void;

interface ActiveThreadPruneChain {
  deps: Pick<AppDeps, "db" | "logger" | "hub">;
  clock: () => number;
  completedPolicies: Set<string>;
  mode: "active" | "idle";
  schedule: ActiveThreadPruneScheduler;
  threadId: string;
  totals: { scanned: number; totalRemoved: number };
}

interface ActiveThreadPruneState {
  chainsByThreadId: Map<string, ActiveThreadPruneChain>;
  queue: ActiveThreadPruneChain[];
  runnerScheduled: boolean;
  runnerToken: number;
  stateByThreadId: Map<string, ActiveThreadPruneThrottleState>;
}

const ACTIVE_THREAD_EVENT_PRUNE_MIN_SEQUENCE_DELTA = 250;
const ACTIVE_THREAD_EVENT_PRUNE_MIN_INTERVAL_MS = 30_000;
const SLOW_THREAD_EVENT_PRUNE_LOG_THRESHOLD_MS = 50;

const ACTIVE_PRUNE_TRIGGER_THREAD_EVENT_TYPES: readonly ThreadEventType[] = [
  "thread/contextWindowUsage/updated",
  "thread/tokenUsage/updated",
  "provider/rateLimits/updated",
  "item/backgroundTask/progress",
] as const;

export const KEEP_RECENT_BY_MODE: Record<ThreadEventPruningMode, number> =
  THREAD_EVENT_KEEP_RECENT_BY_MODE;
export const ACTIVE_THREAD_EVENT_PRUNE_SYNC_BLOCK_CAP_MS = 16;

const activePruneTriggerThreadEventTypeSet = new Set<ThreadEventType>(
  ACTIVE_PRUNE_TRIGGER_THREAD_EVENT_TYPES,
);
const activeThreadPruneStateByDb = new WeakMap<
  AppDeps["db"],
  ActiveThreadPruneState
>();

function getActiveThreadPruneState(db: AppDeps["db"]): ActiveThreadPruneState {
  let state = activeThreadPruneStateByDb.get(db);
  if (!state) {
    state = {
      chainsByThreadId: new Map(),
      queue: [],
      runnerScheduled: false,
      runnerToken: 0,
      stateByThreadId: new Map(),
    };
    activeThreadPruneStateByDb.set(db, state);
  }
  return state;
}

export function isActivePruneTriggerThreadEventType(
  eventType: ThreadEventType,
): boolean {
  return activePruneTriggerThreadEventTypeSet.has(eventType);
}

export function pruneThreadEventHistory(
  deps: Pick<AppDeps, "db">,
  args: PruneThreadEventHistoryArgs,
): ThreadEventPruningResult {
  return pruneThreadEventHistoryWithAdvance(
    deps,
    args,
    advanceThreadPruning,
  );
}

function pruneThreadEventHistoryWithAdvance(
  deps: Pick<AppDeps, "db">,
  args: PruneThreadEventHistoryArgs,
  advance: typeof advanceThreadPruning,
): ThreadEventPruningResult {
  const result = advance(deps.db, { threadId: args.threadId });
  return {
    action: result.action,
    latestSequence: result.cursor.upperSequence,
    policy: result.policy,
    scanned: result.scanned,
    totalRemoved: result.removed,
  };
}

function pruneActiveThreadEventHistoryStep(
  deps: Pick<AppDeps, "db">,
  args: PruneThreadEventHistoryArgs,
): ThreadEventPruningResult {
  return pruneThreadEventHistoryWithAdvance(
    deps,
    args,
    advanceThreadPruningStep,
  );
}

function pruneThreadEventHistoryBestEffortWithAdvance(
  deps: Pick<AppDeps, "db" | "logger" | "hub">,
  args: PruneThreadEventHistoryArgs,
  prune: typeof pruneThreadEventHistory,
): ThreadEventPruningResult | null {
  const startedAt = performance.now();
  const generation = getThreadEventRewriteGeneration(args.threadId);
  try {
    const result = prune(deps, args);

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

export function pruneThreadEventHistoryBestEffort(
  deps: Pick<AppDeps, "db" | "logger" | "hub">,
  args: PruneThreadEventHistoryArgs,
): ThreadEventPruningResult | null {
  return pruneThreadEventHistoryBestEffortWithAdvance(
    deps,
    args,
    pruneThreadEventHistory,
  );
}

function pruneActiveThreadEventHistoryStepBestEffort(
  deps: Pick<AppDeps, "db" | "logger" | "hub">,
  args: PruneThreadEventHistoryArgs,
): ThreadEventPruningResult | null {
  return pruneThreadEventHistoryBestEffortWithAdvance(
    deps,
    args,
    pruneActiveThreadEventHistoryStep,
  );
}

export function maybePruneActiveThreadEventHistory(
  deps: Pick<AppDeps, "db" | "logger" | "hub">,
  args: MaybePruneActiveThreadEventHistoryArgs,
): boolean {
  const state = getActiveThreadPruneState(deps.db);
  const thread = getThread(deps.db, args.threadId);
  if (
    !thread ||
    (thread.status !== "active" && thread.status !== "idle") ||
    thread.archivedAt !== null
  ) {
    return false;
  }

  if (state.chainsByThreadId.has(args.threadId)) return false;

  const lastState = state.stateByThreadId.get(args.threadId);
  const lastPrunedSequence = lastState?.lastPrunedSequence ?? 0;
  if (
    args.latestPrunableSequence - lastPrunedSequence <
    ACTIVE_THREAD_EVENT_PRUNE_MIN_SEQUENCE_DELTA
  ) {
    return false;
  }

  const now = args.throttleNow?.() ?? Date.now();
  const lastPrunedAt = lastState?.lastPrunedAt ?? 0;
  if (now - lastPrunedAt < ACTIVE_THREAD_EVENT_PRUNE_MIN_INTERVAL_MS) {
    return false;
  }

  state.stateByThreadId.set(args.threadId, {
    lastPrunedAt: now,
    lastPrunedSequence: args.latestPrunableSequence,
  });

  return pruneActiveThreadEventHistoryWithinBudget(deps, {
    mode: thread.status === "active" ? "active" : "idle",
    now: args.now,
    schedule: args.schedule,
    threadId: args.threadId,
  });
}

export function pruneActiveThreadEventHistoryWithinBudget(
  deps: Pick<AppDeps, "db" | "logger" | "hub">,
  args: {
    mode: "active" | "idle";
    now?: () => number;
    schedule?: ActiveThreadPruneScheduler;
    threadId: string;
  },
): boolean {
  const state = getActiveThreadPruneState(deps.db);
  if (state.chainsByThreadId.has(args.threadId)) return false;
  const chain: ActiveThreadPruneChain = {
    deps,
    clock: args.now ?? (() => performance.now()),
    completedPolicies: new Set<string>(),
    mode: args.mode,
    schedule: args.schedule ?? ((callback) => setImmediate(callback)),
    threadId: args.threadId,
    totals: { scanned: 0, totalRemoved: 0 },
  };
  state.chainsByThreadId.set(args.threadId, chain);
  state.queue.push(chain);
  scheduleActiveThreadPruneRunner(state, chain);
  return true;
}

function scheduleActiveThreadPruneRunner(
  state: ActiveThreadPruneState,
  chain: ActiveThreadPruneChain,
): void {
  if (state.runnerScheduled || state.queue.length === 0) return;
  state.runnerScheduled = true;
  const token = ++state.runnerToken;
  chain.schedule(() => runNextActiveThreadPruneSlice(state, token));
}

function runNextActiveThreadPruneSlice(
  state: ActiveThreadPruneState,
  token: number,
): void {
  if (token !== state.runnerToken) return;
  state.runnerScheduled = false;
  while (state.queue.length > 0) {
    const chain = state.queue.shift();
    if (chain && state.chainsByThreadId.get(chain.threadId) === chain) {
      runActiveThreadPruneSlice(state, chain);
      if (
        state.chainsByThreadId.get(chain.threadId) === chain &&
        !state.queue.includes(chain)
      )
        state.queue.push(chain);
      scheduleActiveThreadPruneRunner(state, chain);
      return;
    }
  }
}

function runActiveThreadPruneSlice(
  state: ActiveThreadPruneState,
  chain: ActiveThreadPruneChain,
): void {
  const deps = chain.deps;
  chain.clock();
  const latest = pruneActiveThreadEventHistoryStepBestEffort(deps, {
    mode: chain.mode,
    threadId: chain.threadId,
  });
  chain.clock();
  if (latest === null) {
    state.chainsByThreadId.delete(chain.threadId);
    return;
  }
  chain.totals.scanned += latest.scanned;
  chain.totals.totalRemoved += latest.totalRemoved;
  if (latest.action === "cycle-complete" || latest.action === "thread-complete")
    chain.completedPolicies.add(latest.policy);
  if (chain.completedPolicies.size >= THREAD_PRUNING_POLICIES.length) {
    state.chainsByThreadId.delete(chain.threadId);
  }
}

export function resetActiveThreadEventPruningState(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): void {
  const state = getActiveThreadPruneState(deps.db);
  state.stateByThreadId.delete(threadId);
  const chain = state.chainsByThreadId.get(threadId);
  state.chainsByThreadId.delete(threadId);
  if (chain) {
    const index = state.queue.indexOf(chain);
    if (index >= 0) state.queue.splice(index, 1);
  }
  if (state.queue.length === 0 && state.runnerScheduled) {
    state.runnerScheduled = false;
    state.runnerToken += 1;
  }
}
