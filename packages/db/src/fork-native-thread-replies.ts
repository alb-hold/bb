import type { DbConnection } from "./connection.js";

export interface NativeThreadReply {
  threadId: string;
  text: string;
  turnId: string | null;
  recordedAt: number;
}

const ready = new WeakSet<object>();

function ensureTable(db: DbConnection): void {
  if (ready.has(db.$client)) return;
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS fork_native_thread_replies (
      thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      turn_id TEXT,
      recorded_at INTEGER NOT NULL
    )
  `);
  ready.add(db.$client);
}

export function upsertNativeThreadReply(
  db: DbConnection,
  args: {
    threadId: string;
    text: string;
    turnId: string | null;
    recordedAt: number;
  },
): void {
  if (args.text.length === 0) return;
  ensureTable(db);
  db.$client
    .prepare(
      `
      INSERT INTO fork_native_thread_replies (thread_id, text, turn_id, recorded_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (thread_id) DO UPDATE SET
        text = excluded.text,
        turn_id = excluded.turn_id,
        recorded_at = excluded.recorded_at
      WHERE excluded.recorded_at >= fork_native_thread_replies.recorded_at
    `,
    )
    .run(args.threadId, args.text, args.turnId, args.recordedAt);
}

export function getNativeThreadReply(
  db: DbConnection,
  threadId: string,
): NativeThreadReply | null {
  ensureTable(db);
  return (
    (db.$client
      .prepare(
        `SELECT thread_id AS threadId, text, turn_id AS turnId, recorded_at AS recordedAt
         FROM fork_native_thread_replies WHERE thread_id = ?`,
      )
      .get(threadId) as NativeThreadReply | undefined) ?? null
  );
}
