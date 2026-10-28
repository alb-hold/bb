import type { TerminalSession } from "@bb/server-contract";

interface ConditionalProgressClearRequest {
  action: "progress-clear";
  terminalId: string;
  threadId: string;
}

type UpdateThreadRowState = (
  request: ConditionalProgressClearRequest,
) => Promise<unknown>;

const progressUpdateByThread = new Map<string, Promise<unknown>>();
const pendingProgressTimeoutsByThread = new Map<
  string,
  Map<string, Set<() => void>>
>();

export function registerPendingTerminalProgressTimeout(
  threadId: string,
  terminalId: string,
  cancel: () => void,
): () => void {
  let timeoutsByTerminal = pendingProgressTimeoutsByThread.get(threadId);
  if (timeoutsByTerminal === undefined) {
    timeoutsByTerminal = new Map();
    pendingProgressTimeoutsByThread.set(threadId, timeoutsByTerminal);
  }
  let cancelTimeouts = timeoutsByTerminal.get(terminalId);
  if (cancelTimeouts === undefined) {
    cancelTimeouts = new Set();
    timeoutsByTerminal.set(terminalId, cancelTimeouts);
  }
  cancelTimeouts.add(cancel);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    cancelTimeouts.delete(cancel);
    if (
      timeoutsByTerminal.get(terminalId) === cancelTimeouts &&
      cancelTimeouts.size === 0
    ) {
      timeoutsByTerminal.delete(terminalId);
    }
    if (
      pendingProgressTimeoutsByThread.get(threadId) === timeoutsByTerminal &&
      timeoutsByTerminal.size === 0
    ) {
      pendingProgressTimeoutsByThread.delete(threadId);
    }
  };
}

export function cancelPendingTerminalProgressTimeouts(
  threadId: string | null,
  terminalId: string | null,
): void {
  for (const [candidateThreadId, timeoutsByTerminal] of [
    ...pendingProgressTimeoutsByThread,
  ]) {
    if (threadId !== null && candidateThreadId !== threadId) continue;
    for (const [candidateTerminalId, cancelTimeouts] of [
      ...timeoutsByTerminal,
    ]) {
      if (terminalId !== null && candidateTerminalId !== terminalId) continue;
      for (const cancel of [...cancelTimeouts]) cancel();
    }
  }
}

export function queueThreadProgressUpdate(
  threadId: string,
  update: () => Promise<unknown>,
): Promise<unknown> {
  const previousUpdate = progressUpdateByThread.get(threadId) ?? Promise.resolve();
  const nextUpdate = previousUpdate.catch(() => undefined).then(update);
  progressUpdateByThread.set(threadId, nextUpdate);
  const clearCompletedUpdate = () => {
    if (progressUpdateByThread.get(threadId) === nextUpdate) {
      progressUpdateByThread.delete(threadId);
    }
  };
  void nextUpdate.then(clearCompletedUpdate, clearCompletedUpdate);
  return nextUpdate;
}

export async function clearTerminalProgressForClosedSession({
  session,
  terminalId,
  threadId,
  updateThreadRowState,
}: {
  session: TerminalSession | null;
  terminalId: string;
  threadId: string | null;
  updateThreadRowState: UpdateThreadRowState;
}): Promise<boolean> {
  if (session !== null && session.status !== "exited") {
    return false;
  }
  if (threadId === null) {
    return false;
  }
  cancelPendingTerminalProgressTimeouts(threadId, terminalId);
  await queueThreadProgressUpdate(threadId, () =>
    updateThreadRowState({ threadId, terminalId, action: "progress-clear" }),
  ).catch(() => undefined);
  return true;
}
