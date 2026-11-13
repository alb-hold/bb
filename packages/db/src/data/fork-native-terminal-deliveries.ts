import type { DbConnection } from "../connection.js";

const NATIVE_TERMINAL_DELIVERIES_TABLE = "fork_native_terminal_deliveries";

const deliveriesTableReady = new WeakSet<object>();

function ensureNativeTerminalDeliveriesTable(db: DbConnection): void {
  if (deliveriesTableReady.has(db.$client)) {
    return;
  }
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS ${NATIVE_TERMINAL_DELIVERIES_TABLE} (
      queued_message_id TEXT PRIMARY KEY NOT NULL
        REFERENCES queued_thread_messages(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      submitting_at INTEGER NOT NULL,
      uncertain_since INTEGER,
      warning_sender_thread_id TEXT
    )
  `);
  deliveriesTableReady.add(db.$client);
}

export interface NativeTerminalDeliveryMark {
  claimToken: string | null;
  queuedMessageId: string;
  senderThreadId: string | null;
  submittingAt: number;
  threadId: string;
  uncertainSince: number | null;
}

const SELECT_MARKS = `
  SELECT d.queued_message_id AS queuedMessageId, d.thread_id AS threadId,
    d.submitting_at AS submittingAt, d.uncertain_since AS uncertainSince,
    q.claim_token AS claimToken, q.sender_thread_id AS senderThreadId
  FROM ${NATIVE_TERMINAL_DELIVERIES_TABLE} d
  JOIN queued_thread_messages q ON q.id = d.queued_message_id
`;

export function markNativeTerminalDeliveriesSubmitting(
  db: DbConnection,
  args: {
    claimToken: string;
    now: number;
    queuedMessageIds: readonly string[];
  },
): boolean {
  ensureNativeTerminalDeliveriesTable(db);
  const insert = db.$client.prepare<[number, string, string]>(
    `
      INSERT INTO ${NATIVE_TERMINAL_DELIVERIES_TABLE} (queued_message_id,
        thread_id, submitting_at, uncertain_since)
      SELECT id, thread_id, ?, NULL
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
  ensureNativeTerminalDeliveriesTable(db);
  if (queuedMessageIds.length === 0) return [];
  return db.$client
    .prepare<string[], NativeTerminalDeliveryMark>(
      `${SELECT_MARKS} WHERE d.queued_message_id IN (${queuedMessageIds
        .map(() => "?")
        .join(", ")}) ORDER BY q.sort_key, d.queued_message_id`,
    )
    .all(...queuedMessageIds);
}

export function listUnsettledNativeTerminalDeliveryMarks(
  db: DbConnection,
): NativeTerminalDeliveryMark[] {
  ensureNativeTerminalDeliveriesTable(db);
  return db.$client
    .prepare<[], NativeTerminalDeliveryMark>(
      `${SELECT_MARKS} WHERE d.uncertain_since IS NULL
        ORDER BY d.submitting_at, d.queued_message_id`,
    )
    .all();
}

export function markNativeTerminalDeliveriesUncertain(
  db: DbConnection,
  args: {
    deliveries: readonly {
      queuedMessageId: string;
      warnSenderThreadId: string | null;
    }[];
    now: number;
  },
): void {
  ensureNativeTerminalDeliveriesTable(db);
  const update = db.$client.prepare<[number, string | null, string]>(
    `UPDATE ${NATIVE_TERMINAL_DELIVERIES_TABLE}
      SET uncertain_since = ?, warning_sender_thread_id = ?
      WHERE queued_message_id = ?`,
  );
  for (const delivery of args.deliveries) {
    update.run(args.now, delivery.warnSenderThreadId, delivery.queuedMessageId);
  }
}

export interface PendingNativeTerminalDeliveryWarning {
  queuedMessageId: string;
  senderThreadId: string;
  threadId: string;
}

export function listPendingNativeTerminalDeliveryWarnings(
  db: DbConnection,
): PendingNativeTerminalDeliveryWarning[] {
  ensureNativeTerminalDeliveriesTable(db);
  return db.$client
    .prepare<[], PendingNativeTerminalDeliveryWarning>(
      `SELECT queued_message_id AS queuedMessageId, thread_id AS threadId,
          warning_sender_thread_id AS senderThreadId
        FROM ${NATIVE_TERMINAL_DELIVERIES_TABLE}
        WHERE warning_sender_thread_id IS NOT NULL
        ORDER BY uncertain_since, queued_message_id`,
    )
    .all();
}

export function clearNativeTerminalDeliveryWarning(
  db: DbConnection,
  queuedMessageId: string,
): boolean {
  ensureNativeTerminalDeliveriesTable(db);
  return (
    db.$client
      .prepare<[string]>(
        `UPDATE ${NATIVE_TERMINAL_DELIVERIES_TABLE}
          SET warning_sender_thread_id = NULL
          WHERE queued_message_id = ? AND warning_sender_thread_id IS NOT NULL`,
      )
      .run(queuedMessageId).changes > 0
  );
}

export function clearNativeTerminalDeliveryMarks(
  db: DbConnection,
  queuedMessageIds: readonly string[],
): void {
  ensureNativeTerminalDeliveriesTable(db);
  const remove = db.$client.prepare<[string]>(
    `DELETE FROM ${NATIVE_TERMINAL_DELIVERIES_TABLE} WHERE queued_message_id = ?`,
  );
  for (const id of queuedMessageIds) remove.run(id);
}

export function pruneOrphanedNativeTerminalDeliveryMarks(
  db: DbConnection,
): void {
  ensureNativeTerminalDeliveriesTable(db);
  db.$client
    .prepare(
      `DELETE FROM ${NATIVE_TERMINAL_DELIVERIES_TABLE}
        WHERE queued_message_id NOT IN (SELECT id FROM queued_thread_messages)`,
    )
    .run();
}
