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
  gatedDispatchTimesByHost: Map<string, number[]>;
  refused: Map<string, RefusedThreadStorageDelete>;
}

const retryStateByDb = new WeakMap<object, ThreadStorageDeleteRetryState>();

function retryState(db: object): ThreadStorageDeleteRetryState {
  const existing = retryStateByDb.get(db);
  if (existing) return existing;
  const created: ThreadStorageDeleteRetryState = {
    gatedDispatchTimesByHost: new Map(),
    refused: new Map(),
  };
  retryStateByDb.set(db, created);
  return created;
}

function gatedDispatchesInWindow(
  state: ThreadStorageDeleteRetryState,
  args: { hostId: string; now: number },
): number[] {
  const inWindow = (
    state.gatedDispatchTimesByHost.get(args.hostId) ?? []
  ).filter(
    (dispatchedAt) =>
      dispatchedAt > args.now - RETRY_CAP_WINDOW_MS && dispatchedAt <= args.now,
  );
  state.gatedDispatchTimesByHost.set(args.hostId, inWindow);
  return inWindow;
}

export function admitThreadStorageDelete(
  db: object,
  args: {
    gate: ThreadStorageDeleteGate;
    hostId: string;
    now: number;
    threadId: string;
  },
): boolean {
  if (args.gate === "none") return true;
  const state = retryState(db);
  if (args.gate === "backoff-and-cap") {
    const refused = state.refused.get(args.threadId);
    if (refused && args.now < refused.retryAt) return false;
  }
  const hostDispatches = gatedDispatchesInWindow(state, args);
  if (hostDispatches.length >= THREAD_STORAGE_DELETE_RETRIES_PER_MINUTE) {
    return false;
  }
  hostDispatches.push(args.now);
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
}

export function orderThreadStorageDeleteRetries<
  T extends { deletedAt: number; id: string },
>(db: object, pendingThreads: readonly T[]): T[] {
  const state = retryState(db);
  const pendingIds = new Set(pendingThreads.map((thread) => thread.id));
  for (const threadId of state.refused.keys()) {
    if (!pendingIds.has(threadId)) state.refused.delete(threadId);
  }
  const dueAt = (thread: T) =>
    state.refused.get(thread.id)?.retryAt ?? thread.deletedAt;
  return [...pendingThreads].sort((left, right) => {
    const leftDueAt = dueAt(left);
    const rightDueAt = dueAt(right);
    if (leftDueAt !== rightDueAt) return leftDueAt - rightDueAt;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}
