import type { DbConnection } from "../connection.js";

const NATIVE_TERMINAL_DELIVERIES_TABLE = "fork_native_terminal_deliveries_v2";
const NATIVE_TERMINAL_DELIVERY_WARNINGS_TABLE =
  "fork_native_terminal_delivery_warnings_v2";

const deliveriesTableReady = new WeakSet<object>();

function ensureNativeTerminalDeliveriesTables(db: DbConnection): void {
  if (deliveriesTableReady.has(db.$client)) {
    return;
  }
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS ${NATIVE_TERMINAL_DELIVERIES_TABLE} (
      queued_message_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      sender_thread_id TEXT,
      submitting_at INTEGER NOT NULL,
      uncertain_since INTEGER
    );
    CREATE TABLE IF NOT EXISTS ${NATIVE_TERMINAL_DELIVERY_WARNINGS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queued_message_id TEXT NOT NULL UNIQUE,
      target_thread_id TEXT NOT NULL,
      sender_thread_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  deliveriesTableReady.add(db.$client);
}

export interface NativeTerminalDeliveryMark {
  claimToken: string | null;
  queuedMessageId: string;
  rowExists: boolean;
  senderThreadId: string | null;
  submittingAt: number;
  threadId: string;
  uncertainSince: number | null;
}

interface StoredNativeTerminalDeliveryMark
  extends Omit<NativeTerminalDeliveryMark, "rowExists"> {
  rowExists: number;
}

const SELECT_MARKS = `
  SELECT d.queued_message_id AS queuedMessageId, d.thread_id AS threadId,
    d.sender_thread_id AS senderThreadId, d.submitting_at AS submittingAt,
    d.uncertain_since AS uncertainSince, q.claim_token AS claimToken,
    q.id IS NOT NULL AS rowExists
  FROM ${NATIVE_TERMINAL_DELIVERIES_TABLE} d
  LEFT JOIN queued_thread_messages q ON q.id = d.queued_message_id
`;

function toMark(
  row: StoredNativeTerminalDeliveryMark,
): NativeTerminalDeliveryMark {
  return { ...row, rowExists: row.rowExists === 1 };
}

export function markNativeTerminalDeliveriesSubmitting(
  db: DbConnection,
  args: {
    claimToken: string;
    now: number;
    queuedMessageIds: readonly string[];
  },
): boolean {
  ensureNativeTerminalDeliveriesTables(db);
  const insert = db.$client.prepare<[number, string, string]>(
    `
      INSERT INTO ${NATIVE_TERMINAL_DELIVERIES_TABLE} (queued_message_id,
        thread_id, sender_thread_id, submitting_at, uncertain_since)
      SELECT id, thread_id, sender_thread_id, ?, NULL
      FROM queued_thread_messages
      WHERE id = ? AND claim_token = ?
      ON CONFLICT (queued_message_id) DO UPDATE SET
        submitting_at = excluded.submitting_at,
        uncertain_since = NULL
    `,
  );
  const markAll = db.$client.transaction((ids: readonly string[]) => {
    for (const id of ids) {
      if (insert.run(args.now, id, args.claimToken).changes === 0) {
        throw new NativeTerminalDeliveryClaimLost();
      }
    }
  });
  try {
    markAll.immediate(args.queuedMessageIds);
    return true;
  } catch (error) {
    if (error instanceof NativeTerminalDeliveryClaimLost) return false;
    throw error;
  }
}

class NativeTerminalDeliveryClaimLost extends Error {}

export function listNativeTerminalDeliveryMarks(
  db: DbConnection,
  queuedMessageIds: readonly string[],
): NativeTerminalDeliveryMark[] {
  ensureNativeTerminalDeliveriesTables(db);
  if (queuedMessageIds.length === 0) return [];
  return db.$client
    .prepare<string[], StoredNativeTerminalDeliveryMark>(
      `${SELECT_MARKS} WHERE d.queued_message_id IN (${queuedMessageIds
        .map(() => "?")
        .join(", ")}) ORDER BY q.sort_key, d.queued_message_id`,
    )
    .all(...queuedMessageIds)
    .map(toMark);
}

export function listUnsettledNativeTerminalDeliveryMarks(
  db: DbConnection,
): NativeTerminalDeliveryMark[] {
  ensureNativeTerminalDeliveriesTables(db);
  return db.$client
    .prepare<[], StoredNativeTerminalDeliveryMark>(
      `${SELECT_MARKS} WHERE d.uncertain_since IS NULL
        ORDER BY d.submitting_at, d.queued_message_id`,
    )
    .all()
    .map(toMark);
}

export function markNativeTerminalDeliveryUncertain(
  db: DbConnection,
  args: { now: number; queuedMessageId: string },
): boolean {
  ensureNativeTerminalDeliveriesTables(db);
  return (
    db.$client
      .prepare<[number, string]>(
        `UPDATE ${NATIVE_TERMINAL_DELIVERIES_TABLE} SET uncertain_since = ?
          WHERE queued_message_id = ? AND uncertain_since IS NULL`,
      )
      .run(args.now, args.queuedMessageId).changes > 0
  );
}

export function clearNativeTerminalDeliveryMarks(
  db: DbConnection,
  queuedMessageIds: readonly string[],
): void {
  ensureNativeTerminalDeliveriesTables(db);
  const remove = db.$client.prepare<[string]>(
    `DELETE FROM ${NATIVE_TERMINAL_DELIVERIES_TABLE} WHERE queued_message_id = ?`,
  );
  for (const id of queuedMessageIds) remove.run(id);
}

export function pruneSettledOrphanedNativeTerminalDeliveryMarks(
  db: DbConnection,
): void {
  ensureNativeTerminalDeliveriesTables(db);
  db.$client
    .prepare(
      `DELETE FROM ${NATIVE_TERMINAL_DELIVERIES_TABLE}
        WHERE uncertain_since IS NOT NULL
          AND queued_message_id NOT IN (SELECT id FROM queued_thread_messages)`,
    )
    .run();
}

export interface NativeTerminalDeliveryWarning {
  id: number;
  queuedMessageId: string;
  senderThreadId: string;
  targetThreadId: string;
  text: string;
}

export function insertNativeTerminalDeliveryWarning(
  db: DbConnection,
  args: {
    now: number;
    queuedMessageId: string;
    senderThreadId: string;
    targetThreadId: string;
    text: string;
  },
): void {
  ensureNativeTerminalDeliveriesTables(db);
  db.$client
    .prepare<[string, string, string, string, number]>(
      `INSERT OR IGNORE INTO ${NATIVE_TERMINAL_DELIVERY_WARNINGS_TABLE}
        (queued_message_id, target_thread_id, sender_thread_id, text, created_at)
        VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      args.queuedMessageId,
      args.targetThreadId,
      args.senderThreadId,
      args.text,
      args.now,
    );
}

export function listNativeTerminalDeliveryWarnings(
  db: DbConnection,
  page: { afterId: number; limit: number },
): NativeTerminalDeliveryWarning[] {
  ensureNativeTerminalDeliveriesTables(db);
  return db.$client
    .prepare<[number, number], NativeTerminalDeliveryWarning>(
      `SELECT id, queued_message_id AS queuedMessageId,
          target_thread_id AS targetThreadId,
          sender_thread_id AS senderThreadId, text
        FROM ${NATIVE_TERMINAL_DELIVERY_WARNINGS_TABLE}
        WHERE id > ?
        ORDER BY id
        LIMIT ?`,
    )
    .all(page.afterId, page.limit);
}

export function deleteNativeTerminalDeliveryWarning(
  db: DbConnection,
  id: number,
): boolean {
  ensureNativeTerminalDeliveriesTables(db);
  return (
    db.$client
      .prepare<[number]>(
        `DELETE FROM ${NATIVE_TERMINAL_DELIVERY_WARNINGS_TABLE} WHERE id = ?`,
      )
      .run(id).changes > 0
  );
}
