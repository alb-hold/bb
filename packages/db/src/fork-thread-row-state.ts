import { eq } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "./connection.js";
import { forkThreadRowStates } from "./schema.js";
import {
  threadRowStateSchema,
  type ThreadRowProgress,
  type ThreadRowState,
  type ThreadRowStatus,
} from "@bb/domain";
export type { ThreadRowProgress, ThreadRowState, ThreadRowStatus } from "@bb/domain";

interface StoredThreadRowState {
  statusesJson: string;
  progressJson: string | null;
}

export function getThreadRowState(
  db: DbConnection,
  threadId: string,
): ThreadRowState {
  const row = db.$client
    .prepare(
      "SELECT statuses_json AS statusesJson, progress_json AS progressJson FROM fork_thread_row_states WHERE thread_id = ?",
    )
    .get(threadId) as StoredThreadRowState | undefined;
  return threadRowStateSchema.parse(
    row
      ? {
          statuses: JSON.parse(row.statusesJson) as Record<string, ThreadRowStatus>,
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
      `INSERT INTO fork_thread_row_states (thread_id, statuses_json, progress_json)
       VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         statuses_json = excluded.statuses_json,
         progress_json = excluded.progress_json`,
    )
    .run(
      threadId,
      JSON.stringify(state.statuses),
      state.progress === null ? null : JSON.stringify(state.progress),
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
