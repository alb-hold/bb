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
  dueSequence: Map<string, number>;
  gatedDispatchTimesByHost: Map<string, number[]>;
  nextDueSequence: number;
  refused: Map<string, RefusedThreadStorageDelete>;
}

const retryStateByDb = new WeakMap<object, ThreadStorageDeleteRetryState>();

function retryState(db: object): ThreadStorageDeleteRetryState {
  const existing = retryStateByDb.get(db);
  if (existing) return existing;
  const created: ThreadStorageDeleteRetryState = {
    dueSequence: new Map(),
    gatedDispatchTimesByHost: new Map(),
    nextDueSequence: 0,
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
  state.dueSequence.delete(args.threadId);
  return refused;
}

export function forgetThreadStorageDelete(db: object, threadId: string): void {
  const state = retryStateByDb.get(db);
  if (!state) return;
  state.refused.delete(threadId);
  state.dueSequence.delete(threadId);
}

function compareThreadIds(left: { id: string }, right: { id: string }) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function orderThreadStorageDeleteRetries<
  T extends { deletedAt: number; id: string },
>(db: object, pendingThreads: readonly T[], now: number): T[] {
  const state = retryState(db);
  const pendingIds = new Set(pendingThreads.map((thread) => thread.id));
  for (const threadId of state.refused.keys()) {
    if (!pendingIds.has(threadId)) state.refused.delete(threadId);
  }
  for (const threadId of state.dueSequence.keys()) {
    if (!pendingIds.has(threadId)) state.dueSequence.delete(threadId);
  }
  const dueAt = (thread: T) =>
    state.refused.get(thread.id)?.retryAt ?? thread.deletedAt;
  const isDue = (thread: T) => {
    const refused = state.refused.get(thread.id);
    return refused === undefined || refused.retryAt <= now;
  };
  const newlyDue = pendingThreads
    .filter((thread) => !state.dueSequence.has(thread.id) && isDue(thread))
    .sort(
      (left, right) =>
        dueAt(left) - dueAt(right) || compareThreadIds(left, right),
    );
  for (const thread of newlyDue) {
    state.dueSequence.set(thread.id, state.nextDueSequence);
    state.nextDueSequence += 1;
  }
  const sequenceOf = (thread: T) =>
    state.dueSequence.get(thread.id) ?? Number.POSITIVE_INFINITY;
  return [...pendingThreads].sort((left, right) => {
    const leftSequence = sequenceOf(left);
    const rightSequence = sequenceOf(right);
    if (leftSequence !== rightSequence) {
      return leftSequence < rightSequence ? -1 : 1;
    }
    return compareThreadIds(left, right);
  });
}
