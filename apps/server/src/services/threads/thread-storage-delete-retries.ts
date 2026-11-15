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
  inFlight: Set<string>;
  refused: Map<string, RefusedThreadStorageDelete>;
  requeueFailed: Map<string, number>;
  sendFailuresReported: Set<string>;
}

const retryStateByDb = new WeakMap<object, ThreadStorageDeleteRetryState>();

function retryState(db: object): ThreadStorageDeleteRetryState {
  const existing = retryStateByDb.get(db);
  if (existing) return existing;
  const created: ThreadStorageDeleteRetryState = {
    gatedDispatchTimesByHost: new Map(),
    inFlight: new Set(),
    refused: new Map(),
    requeueFailed: new Map(),
    sendFailuresReported: new Set(),
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

export function isThreadStorageDeleteInFlight(
  db: object,
  threadId: string,
): boolean {
  return retryStateByDb.get(db)?.inFlight.has(threadId) ?? false;
}

export function claimThreadStorageDelete(db: object, threadId: string): void {
  retryState(db).inFlight.add(threadId);
}

export function releaseThreadStorageDelete(db: object, threadId: string): void {
  retryStateByDb.get(db)?.inFlight.delete(threadId);
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

export function returnThreadStorageDeleteSlot(
  db: object,
  args: { gate: ThreadStorageDeleteGate; hostId: string; now: number },
): void {
  if (args.gate === "none") return;
  const hostDispatches = retryStateByDb
    .get(db)
    ?.gatedDispatchTimesByHost.get(args.hostId);
  if (!hostDispatches) return;
  const index = hostDispatches.lastIndexOf(args.now);
  if (index >= 0) hostDispatches.splice(index, 1);
}

export function isFirstThreadStorageDeleteSendFailure(
  db: object,
  threadId: string,
): boolean {
  const reported = retryState(db).sendFailuresReported;
  if (reported.has(threadId)) return false;
  reported.add(threadId);
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

export function recordThreadStorageDeleteRequeueFailed(
  db: object,
  args: { queuedAtSeq: number; threadId: string },
): boolean {
  const requeueFailed = retryState(db).requeueFailed;
  const first = !requeueFailed.has(args.threadId);
  requeueFailed.set(args.threadId, args.queuedAtSeq);
  return first;
}

export function recordThreadStorageDeleteRequeued(
  db: object,
  threadId: string,
): void {
  retryStateByDb.get(db)?.requeueFailed.delete(threadId);
}

export function orderThreadStorageDeletesForDispatch<
  T extends { id: string; storageDeleteSeq: number | null },
>(db: object, pendingInQueueOrder: readonly T[]): T[] {
  const requeueFailed = retryStateByDb.get(db)?.requeueFailed;
  if (!requeueFailed || requeueFailed.size === 0) {
    return [...pendingInQueueOrder];
  }
  const queuePosition = (thread: T) => {
    const queuedAtSeq = requeueFailed.get(thread.id);
    return queuedAtSeq === undefined
      ? {
          seq: thread.storageDeleteSeq ?? Number.POSITIVE_INFINITY,
          unpersisted: 1,
        }
      : { seq: queuedAtSeq, unpersisted: 0 };
  };
  return [...pendingInQueueOrder].sort((left, right) => {
    const leftPosition = queuePosition(left);
    const rightPosition = queuePosition(right);
    if (leftPosition.seq !== rightPosition.seq) {
      return leftPosition.seq - rightPosition.seq;
    }
    if (leftPosition.unpersisted !== rightPosition.unpersisted) {
      return leftPosition.unpersisted - rightPosition.unpersisted;
    }
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });
}

export function forgetThreadStorageDelete(db: object, threadId: string): void {
  const state = retryStateByDb.get(db);
  state?.refused.delete(threadId);
  state?.requeueFailed.delete(threadId);
  state?.sendFailuresReported.delete(threadId);
}

export function forgetThreadStorageDeleteRetriesExcept(
  db: object,
  pendingThreadIds: ReadonlySet<string>,
): void {
  const state = retryStateByDb.get(db);
  if (!state) return;
  for (const threadId of state.refused.keys()) {
    if (!pendingThreadIds.has(threadId)) state.refused.delete(threadId);
  }
  for (const threadId of state.requeueFailed.keys()) {
    if (!pendingThreadIds.has(threadId)) state.requeueFailed.delete(threadId);
  }
  for (const threadId of state.sendFailuresReported) {
    if (!pendingThreadIds.has(threadId)) {
      state.sendFailuresReported.delete(threadId);
    }
  }
}

export function clearThreadStorageDeleteRetryMemory(db: object): void {
  retryStateByDb.delete(db);
}
