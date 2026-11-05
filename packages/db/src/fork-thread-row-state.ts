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

const MAX_PROGRESS_OUTPUT_SEQ_TERMINALS = 64;

interface ParsedStoredThreadRowProgress {
  progress: ThreadRowProgress | null;
  sourceTerminalId: string | null;
  outputSeqs: Record<string, number>;
}

function parseStoredOutputSeqs(value: unknown): Record<string, number> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid stored thread row progress output sequences");
  }
  const outputSeqs: Record<string, number> = {};
  for (const [terminalId, seq] of Object.entries(value)) {
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
      throw new TypeError("Invalid stored thread row progress output sequence");
    }
    outputSeqs[terminalId] = seq;
  }
  return outputSeqs;
}

function parseStoredThreadRowProgress(
  progressJson: string,
): ParsedStoredThreadRowProgress {
  const parsed: unknown = JSON.parse(progressJson);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      progress: threadRowProgressSchema.parse(parsed),
      sourceTerminalId: null,
      outputSeqs: {},
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
  const progressEntries = entries.filter(
    ([key]) => key !== "sourceTerminalId" && key !== "outputSeqs",
  );
  return {
    progress:
      progressEntries.length === 0
        ? null
        : threadRowProgressSchema.parse(Object.fromEntries(progressEntries)),
    sourceTerminalId:
      typeof sourceTerminalIdEntry?.[1] === "string"
        ? sourceTerminalIdEntry[1]
        : null,
    outputSeqs: parseStoredOutputSeqs(
      entries.find(([key]) => key === "outputSeqs")?.[1],
    ),
  };
}

function serializeStoredThreadRowProgress(
  parsed: ParsedStoredThreadRowProgress,
): string | null {
  const terminalIds = Object.keys(parsed.outputSeqs).slice(
    -MAX_PROGRESS_OUTPUT_SEQ_TERMINALS,
  );
  if (parsed.progress === null && terminalIds.length === 0) return null;
  return JSON.stringify({
    ...(parsed.progress ?? {}),
    ...(parsed.progress === null || parsed.sourceTerminalId === null
      ? {}
      : { sourceTerminalId: parsed.sourceTerminalId }),
    ...(terminalIds.length === 0
      ? {}
      : {
          outputSeqs: Object.fromEntries(
            terminalIds.map((terminalId) => [
              terminalId,
              parsed.outputSeqs[terminalId],
            ]),
          ),
        }),
  });
}

function readStoredProgressJson(
  db: DbQueryConnection,
  threadId: string,
): string | null {
  const row = db
    .select({ progressJson: forkThreadRowStates.progressJson })
    .from(forkThreadRowStates)
    .where(eq(forkThreadRowStates.threadId, threadId))
    .get();
  return row?.progressJson ?? null;
}

function readStoredOutputSeqs(
  db: DbQueryConnection,
  threadId: string,
): Record<string, number> {
  const progressJson = readStoredProgressJson(db, threadId);
  return progressJson === null
    ? {}
    : parseStoredThreadRowProgress(progressJson).outputSeqs;
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

export function getThreadRowProgressOutputSeqs(
  db: DbQueryConnection,
  threadId: string,
): Record<string, number> {
  return readStoredOutputSeqs(db, threadId);
}

export function raiseThreadRowProgressOutputSeqs(
  db: DbQueryConnection,
  threadId: string,
  raises: Readonly<Record<string, number>>,
): void {
  const stored = readStoredProgressJson(db, threadId);
  const parsed: ParsedStoredThreadRowProgress =
    stored === null
      ? { progress: null, sourceTerminalId: null, outputSeqs: {} }
      : parseStoredThreadRowProgress(stored);
  const outputSeqs = { ...parsed.outputSeqs };
  let changed = false;
  for (const [terminalId, seq] of Object.entries(raises)) {
    const current = outputSeqs[terminalId];
    if (current !== undefined && current >= seq) continue;
    delete outputSeqs[terminalId];
    outputSeqs[terminalId] = seq;
    changed = true;
  }
  if (!changed) return;
  db.run(sql`
    INSERT INTO fork_thread_row_states (thread_id, statuses_json, progress_json, updated_at)
    VALUES (${threadId}, '{}', ${serializeStoredThreadRowProgress({ ...parsed, outputSeqs })}, ${Date.now()})
    ON CONFLICT(thread_id) DO UPDATE SET progress_json = excluded.progress_json
  `);
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
  const states = new Map<string, ThreadRowState>();
  for (const row of rows) {
    const state = threadRowStateSchema.parse({
      statuses: JSON.parse(row.statusesJson) as Record<string, ThreadRowStatus>,
      progress: row.progressJson
        ? parseStoredThreadRowProgress(row.progressJson).progress
        : null,
    });
    if (Object.keys(state.statuses).length === 0 && state.progress === null) {
      continue;
    }
    states.set(row.threadId, state);
  }
  return states;
}

export function putThreadRowState(
  db: DbConnection,
  threadId: string,
  state: ThreadRowState,
  sourceTerminalId: string | null = null,
): void {
  const outputSeqs = readStoredOutputSeqs(db, threadId);
  const progressJson = serializeStoredThreadRowProgress({
    progress: state.progress,
    sourceTerminalId,
    outputSeqs,
  });
  const hasState =
    Object.keys(state.statuses).length > 0 || progressJson !== null;
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
    .run(threadId, JSON.stringify(state.statuses), progressJson, Date.now());
}

export function clearThreadRowState(
  db: DbQueryConnection,
  threadId: string,
): void {
  const outputSeqs = readStoredOutputSeqs(db, threadId);
  if (Object.keys(outputSeqs).length === 0) {
    db.delete(forkThreadRowStates)
      .where(eq(forkThreadRowStates.threadId, threadId))
      .run();
    return;
  }
  db.update(forkThreadRowStates)
    .set({
      statusesJson: "{}",
      progressJson: serializeStoredThreadRowProgress({
        progress: null,
        sourceTerminalId: null,
        outputSeqs,
      }),
      updatedAt: Date.now(),
    })
    .where(eq(forkThreadRowStates.threadId, threadId))
    .run();
}
