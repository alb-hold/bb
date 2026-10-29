import type { DbQueryConnection } from "./connection.js";
import { listTerminalSessions } from "./data/terminal-sessions.js";
import { getRetainedTerminalOutputLatestSeq } from "./fork-terminal-output.js";
import {
  clearThreadRowState,
  raiseThreadRowProgressOutputSeqs,
} from "./fork-thread-row-state.js";

const forwardedOutputSeqs = new Map<string, number>();

export function noteForwardedTerminalOutputSeq(
  terminalId: string,
  seq: number,
): void {
  if (seq > (forwardedOutputSeqs.get(terminalId) ?? -1)) {
    forwardedOutputSeqs.set(terminalId, seq);
  }
}

export function forgetForwardedTerminalOutputSeq(terminalId: string): void {
  forwardedOutputSeqs.delete(terminalId);
}

export function listThreadTerminalLatestOutputSeqs(
  db: DbQueryConnection,
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
    const seq = getRetainedTerminalOutputLatestSeq(db, {
      hostId: session.hostId,
      terminalSessionId: session.id,
      now,
    });
    const newest = Math.max(seq ?? -1, forwardedOutputSeqs.get(session.id) ?? -1);
    if (newest >= 0) latest[session.id] = newest;
  }
  return latest;
}

export function clearThreadRowStateAtOutputSeqs(
  db: DbQueryConnection,
  threadId: string,
): void {
  raiseThreadRowProgressOutputSeqs(
    db,
    threadId,
    listThreadTerminalLatestOutputSeqs(db, threadId),
  );
  clearThreadRowState(db, threadId);
}
