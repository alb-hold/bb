export const THREAD_STORAGE_DELETE_RETRY_BASE_MS = 60_000;
export const THREAD_STORAGE_DELETE_RETRY_MAX_MS = 60 * 60_000;
export const THREAD_STORAGE_DELETE_RETRIES_PER_MINUTE = 1;
const RETRY_CAP_WINDOW_MS = 60_000;

export type ThreadStorageDeleteGate = "none" | "cap" | "backoff-and-cap";

interface RefusedThreadStorageDelete {
  refusals: number;
  retryAt: number;
}

interface ThreadStorageDeleteRetryState {
  gatedDispatchTimes: number[];
  lastAttemptAt: Map<string, number>;
  refused: Map<string, RefusedThreadStorageDelete>;
}

const retryStateByDb = new WeakMap<object, ThreadStorageDeleteRetryState>();

function retryState(db: object): ThreadStorageDeleteRetryState {
  const existing = retryStateByDb.get(db);
  if (existing) return existing;
  const created: ThreadStorageDeleteRetryState = {
    gatedDispatchTimes: [],
    lastAttemptAt: new Map(),
    refused: new Map(),
  };
  retryStateByDb.set(db, created);
  return created;
}

function gatedDispatchesInWindow(
  state: ThreadStorageDeleteRetryState,
  now: number,
): number {
  state.gatedDispatchTimes = state.gatedDispatchTimes.filter(
    (dispatchedAt) =>
      dispatchedAt > now - RETRY_CAP_WINDOW_MS && dispatchedAt <= now,
  );
  return state.gatedDispatchTimes.length;
}

export function admitThreadStorageDelete(
  db: object,
  args: { gate: ThreadStorageDeleteGate; now: number; threadId: string },
): boolean {
  const state = retryState(db);
  if (args.gate === "none") {
    state.lastAttemptAt.set(args.threadId, args.now);
    return true;
  }
  if (args.gate === "backoff-and-cap") {
    const refused = state.refused.get(args.threadId);
    if (refused && args.now < refused.retryAt) return false;
  }
  if (
    gatedDispatchesInWindow(state, args.now) >=
    THREAD_STORAGE_DELETE_RETRIES_PER_MINUTE
  ) {
    return false;
  }
  state.gatedDispatchTimes.push(args.now);
  state.lastAttemptAt.set(args.threadId, args.now);
  return true;
}

export function recordThreadStorageDeleteRefused(
  db: object,
  args: { now: number; threadId: string },
): RefusedThreadStorageDelete {
  const state = retryState(db);
  const refusals = (state.refused.get(args.threadId)?.refusals ?? 0) + 1;
  const delayMs = Math.min(
    THREAD_STORAGE_DELETE_RETRY_BASE_MS * 2 ** Math.min(refusals - 1, 30),
    THREAD_STORAGE_DELETE_RETRY_MAX_MS,
  );
  const refused = { refusals, retryAt: args.now + delayMs };
  state.refused.set(args.threadId, refused);
  return refused;
}

export function forgetThreadStorageDelete(db: object, threadId: string): void {
  const state = retryStateByDb.get(db);
  if (!state) return;
  state.refused.delete(threadId);
  state.lastAttemptAt.delete(threadId);
}

export function orderThreadStorageDeleteRetries<T extends { id: string }>(
  db: object,
  pendingThreads: readonly T[],
): T[] {
  const state = retryState(db);
  const pendingIds = new Set(pendingThreads.map((thread) => thread.id));
  for (const threadId of state.lastAttemptAt.keys()) {
    if (!pendingIds.has(threadId)) state.lastAttemptAt.delete(threadId);
  }
  for (const threadId of state.refused.keys()) {
    if (!pendingIds.has(threadId)) state.refused.delete(threadId);
  }
  const attemptedAt = (thread: T) =>
    state.lastAttemptAt.get(thread.id) ?? Number.NEGATIVE_INFINITY;
  return [...pendingThreads].sort((left, right) => {
    const leftAt = attemptedAt(left);
    const rightAt = attemptedAt(right);
    return leftAt < rightAt ? -1 : leftAt > rightAt ? 1 : 0;
  });
}
