import { sql } from "drizzle-orm";
import type { DbQueryConnection, DbTransaction } from "../connection.js";

const QUEUED_MESSAGE_ORIGIN_TABLE = "fork_queued_message_origin";

export function ensureQueuedMessageOriginTable(db: DbQueryConnection): void {
  db.run(
    sql.raw(`
      CREATE TABLE IF NOT EXISTS ${QUEUED_MESSAGE_ORIGIN_TABLE} (
        queued_message_id TEXT PRIMARY KEY NOT NULL
          REFERENCES queued_thread_messages(id) ON DELETE CASCADE,
        origin TEXT NOT NULL CHECK (origin = 'composer')
      )
    `),
  );
}

export function markQueuedMessageFromComposerInTransaction(
  tx: DbTransaction,
  queuedMessageId: string,
): void {
  ensureQueuedMessageOriginTable(tx);
  tx.run(sql`
    INSERT INTO ${sql.raw(QUEUED_MESSAGE_ORIGIN_TABLE)} (queued_message_id, origin)
    VALUES (${queuedMessageId}, 'composer')
    ON CONFLICT (queued_message_id) DO NOTHING
  `);
}

export function listComposerQueuedMessageIds(
  db: DbQueryConnection,
  queuedMessageIds: readonly string[],
): Set<string> {
  if (queuedMessageIds.length === 0) return new Set();
  try {
    const rows = db.all<{ queuedMessageId: string }>(sql`
      SELECT queued_message_id AS queuedMessageId
      FROM ${sql.raw(QUEUED_MESSAGE_ORIGIN_TABLE)}
      WHERE origin = 'composer' AND queued_message_id IN (${sql.join(
        queuedMessageIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    `);
    return new Set(rows.map((row) => row.queuedMessageId));
  } catch {
    return new Set();
  }
}
