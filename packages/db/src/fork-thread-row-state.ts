import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "./connection.js";
import { forkThreadRowStates } from "./schema.js";
import {
  threadListEnrichmentScopePredicate,
  type ThreadListEnrichmentScope,
} from "./thread-list-enrichment-scope.js";
import {
  threadRowProgressSchema,
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

function parseStoredThreadRowProgress(progressJson: string): {
  progress: ThreadRowProgress;
  sourceTerminalId: string | null;
} {
  const parsed: unknown = JSON.parse(progressJson);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      progress: threadRowProgressSchema.parse(parsed),
      sourceTerminalId: null,
    };
  }
  const entries = Object.entries(parsed);
  const sourceTerminalIdEntry = entries.find(
    ([key]) => key === "sourceTerminalId",
  );
  if (
    sourceTerminalIdEntry !== undefined &&
    typeof sourceTerminalIdEntry[1] !== "string"
  ) {
    throw new TypeError("Invalid stored thread row progress source");
  }
  return {
    progress: threadRowProgressSchema.parse(
      Object.fromEntries(
        entries.filter(([key]) => key !== "sourceTerminalId"),
      ),
    ),
    sourceTerminalId:
      typeof sourceTerminalIdEntry?.[1] === "string"
        ? sourceTerminalIdEntry[1]
        : null,
  };
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
            ? parseStoredThreadRowProgress(row.progressJson).progress
            : null,
        }
      : { statuses: {}, progress: null },
  );
}

export function getThreadRowProgressSourceTerminalId(
  db: DbConnection,
  threadId: string,
  nowMs = Date.now(),
): string | null {
  const row = db.$client
    .prepare(
      "SELECT progress_json AS progressJson FROM fork_thread_row_states WHERE thread_id = ? AND updated_at >= ?",
    )
    .get(threadId, nowMs - THREAD_ROW_STATE_TTL_MS) as
    | Pick<StoredThreadRowState, "progressJson">
    | undefined;
  return row?.progressJson
    ? parseStoredThreadRowProgress(row.progressJson).sourceTerminalId
    : null;
}

export function listThreadRowStatesByScope(
  db: DbQueryConnection,
  scope: ThreadListEnrichmentScope,
  nowMs = Date.now(),
): Map<string, ThreadRowState> {
  const rows = db.all<StoredThreadRowState & { threadId: string }>(sql`
    SELECT thread_id AS threadId, statuses_json AS statusesJson,
      progress_json AS progressJson, updated_at AS updatedAt
    FROM fork_thread_row_states
    WHERE ${threadListEnrichmentScopePredicate(sql`thread_id`, scope)}
      AND updated_at >= ${nowMs - THREAD_ROW_STATE_TTL_MS}
  `);
  return new Map(
    rows.map((row) => [
      row.threadId,
      threadRowStateSchema.parse({
        statuses: JSON.parse(row.statusesJson) as Record<
          string,
          ThreadRowStatus
        >,
        progress: row.progressJson
          ? parseStoredThreadRowProgress(row.progressJson).progress
          : null,
      }),
    ]),
  );
}

export function putThreadRowState(
  db: DbConnection,
  threadId: string,
  state: ThreadRowState,
  sourceTerminalId: string | null = null,
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
      state.progress === null
        ? null
        : JSON.stringify({
            ...state.progress,
            ...(sourceTerminalId === null ? {} : { sourceTerminalId }),
          }),
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
