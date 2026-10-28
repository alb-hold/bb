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
  await queueThreadProgressUpdate(threadId, () =>
    updateThreadRowState({ threadId, terminalId, action: "progress-clear" }),
  ).catch(() => undefined);
  return true;
}
