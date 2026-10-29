import type { DbConnection } from "./connection.js";
import { listTerminalSessions } from "./data/terminal-sessions.js";
import { getRetainedTerminalOutput } from "./fork-terminal-output.js";
import {
  clearThreadRowState,
  raiseThreadRowProgressOutputSeqs,
} from "./fork-thread-row-state.js";

export function listThreadTerminalLatestOutputSeqs(
  db: DbConnection,
  threadId: string,
  terminalId?: string,
  now = Date.now(),
): Record<string, number> {
  const latest: Record<string, number> = {};
  for (const session of listTerminalSessions(db, {
    scope: { kind: "thread", threadId },
    visible: false,
  })) {
    if (terminalId !== undefined && session.id !== terminalId) continue;
    const chunks = getRetainedTerminalOutput(db, {
      hostId: session.hostId,
      terminalSessionId: session.id,
      now,
    });
    const last = chunks?.at(-1);
    if (last !== undefined) latest[session.id] = last.seq;
  }
  return latest;
}

export function clearThreadRowStateAtOutputSeqs(
  db: DbConnection,
  threadId: string,
): void {
  raiseThreadRowProgressOutputSeqs(
    db,
    threadId,
    listThreadTerminalLatestOutputSeqs(db, threadId),
  );
  clearThreadRowState(db, threadId);
}
