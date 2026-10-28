import type { TerminalSession } from "@bb/server-contract";

interface ClearTerminalProgressRequest {
  action: "progress-clear";
  threadId: string;
}

type UpdateThreadRowState = (
  request: ClearTerminalProgressRequest,
) => Promise<unknown>;

const terminalProgressOwnerByThread = new Map<string, string>();

export function setTerminalProgressOwner(
  threadId: string,
  terminalId: string,
): void {
  terminalProgressOwnerByThread.set(threadId, terminalId);
}

export function isTerminalProgressOwner(
  threadId: string,
  terminalId: string,
): boolean {
  return terminalProgressOwnerByThread.get(threadId) === terminalId;
}

export function clearTerminalProgressOwner(
  threadId: string,
  terminalId: string,
): boolean {
  if (terminalProgressOwnerByThread.get(threadId) !== terminalId) {
    return false;
  }
  terminalProgressOwnerByThread.delete(threadId);
  return true;
}

export async function clearTerminalProgressForClosedSession({
  session,
  terminalId,
  updateThreadRowState,
}: {
  session: TerminalSession | null;
  terminalId: string;
  updateThreadRowState: UpdateThreadRowState;
}): Promise<boolean> {
  if (session !== null && session.status !== "exited") {
    return false;
  }
  for (const [threadId, ownerTerminalId] of terminalProgressOwnerByThread) {
    if (ownerTerminalId !== terminalId) continue;
    terminalProgressOwnerByThread.delete(threadId);
    await updateThreadRowState({ threadId, action: "progress-clear" }).catch(
      () => undefined,
    );
    return true;
  }
  return false;
}
