import { eq } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "./connection.js";
import { forkThreadRowStates } from "./schema.js";
import {
  threadRowStateSchema,
  type ThreadRowProgress,
  type ThreadRowState,
  type ThreadRowStatus,
} from "@bb/domain";
export type {
  ThreadRowProgress,
  ThreadRowState,
  ThreadRowStatus,
} from "@bb/domain";

interface StoredThreadRowState {
  statusesJson: string;
  progressJson: string | null;
  updatedAt: number;
}

export const THREAD_ROW_STATE_TTL_MS = 60 * 60 * 1000;

export function getThreadRowState(
  db: DbConnection,
  threadId: string,
  nowMs = Date.now(),
): ThreadRowState {
  const row = db.$client
    .prepare(
      "SELECT statuses_json AS statusesJson, progress_json AS progressJson, updated_at AS updatedAt FROM fork_thread_row_states WHERE thread_id = ? AND updated_at >= ?",
    )
    .get(threadId, nowMs - THREAD_ROW_STATE_TTL_MS) as
    | StoredThreadRowState
    | undefined;
  return threadRowStateSchema.parse(
    row
      ? {
          statuses: JSON.parse(row.statusesJson) as Record<
            string,
            ThreadRowStatus
          >,
          progress: row.progressJson
            ? (JSON.parse(row.progressJson) as ThreadRowProgress)
            : null,
        }
      : { statuses: {}, progress: null },
  );
}

export function putThreadRowState(
  db: DbConnection,
  threadId: string,
  state: ThreadRowState,
): void {
  const hasState =
    Object.keys(state.statuses).length > 0 || state.progress !== null;
  if (!hasState) {
    db.$client
      .prepare("DELETE FROM fork_thread_row_states WHERE thread_id = ?")
      .run(threadId);
    return;
  }
  db.$client
    .prepare(
      `INSERT INTO fork_thread_row_states (thread_id, statuses_json, progress_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         statuses_json = excluded.statuses_json,
         progress_json = excluded.progress_json,
         updated_at = excluded.updated_at`,
    )
    .run(
      threadId,
      JSON.stringify(state.statuses),
      state.progress === null ? null : JSON.stringify(state.progress),
      Date.now(),
    );
}

export function clearThreadRowState(
  db: DbQueryConnection,
  threadId: string,
): void {
  db.delete(forkThreadRowStates)
    .where(eq(forkThreadRowStates.threadId, threadId))
    .run();
}
