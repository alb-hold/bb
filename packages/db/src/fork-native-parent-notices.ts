import type { DbConnection } from "./connection.js";

export interface NativeParentNoticeRow {
  id: number;
  parentThreadId: string;
  text: string;
  childThreadIds: string[];
  blockedSince: number | null;
  createdAt: number;
}

interface StoredNativeParentNoticeRow {
  id: number;
  parentThreadId: string;
  text: string;
  childThreadIds: string;
  blockedSince: number | null;
  createdAt: number;
}

export function ensureNativeParentNoticeTables(db: DbConnection): void {
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS fork_native_parent_notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      child_thread_ids TEXT NOT NULL,
      blocked_since INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fork_native_parent_notices_parent_idx
      ON fork_native_parent_notices (parent_thread_id, id);
    CREATE TABLE IF NOT EXISTS fork_native_parent_notice_deliveries (
      parent_thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      delivered_at INTEGER NOT NULL
    );
  `);
}

function parseChildThreadIds(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function insertNativeParentNotice(
  db: DbConnection,
  args: {
    childThreadIds: readonly string[];
    now: number;
    parentThreadId: string;
    text: string;
  },
): void {
  db.$client
    .prepare(
      `INSERT INTO fork_native_parent_notices (parent_thread_id, text, child_thread_ids, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      args.parentThreadId,
      args.text,
      JSON.stringify(args.childThreadIds),
      args.now,
    );
}

export function listNativeParentNotices(
  db: DbConnection,
  parentThreadId: string,
): NativeParentNoticeRow[] {
  const rows = db.$client
    .prepare(
      `SELECT id, parent_thread_id AS parentThreadId, text, child_thread_ids AS childThreadIds,
         blocked_since AS blockedSince, created_at AS createdAt
       FROM fork_native_parent_notices WHERE parent_thread_id = ? ORDER BY id`,
    )
    .all(parentThreadId) as StoredNativeParentNoticeRow[];
  return rows.map((row) => ({
    ...row,
    childThreadIds: parseChildThreadIds(row.childThreadIds),
  }));
}

export function listParentsWithNativeParentNotices(db: DbConnection): string[] {
  const rows = db.$client
    .prepare(
      `SELECT DISTINCT parent_thread_id AS parentThreadId FROM fork_native_parent_notices ORDER BY parent_thread_id`,
    )
    .all() as Array<{ parentThreadId: string }>;
  return rows.map((row) => row.parentThreadId);
}

export function deleteNativeParentNotices(
  db: DbConnection,
  ids: readonly number[],
): void {
  if (ids.length === 0) return;
  const remove = db.$client.prepare(
    `DELETE FROM fork_native_parent_notices WHERE id = ?`,
  );
  db.$client.transaction(() => {
    for (const id of ids) remove.run(id);
  })();
}

export function markNativeParentNoticesBlocked(
  db: DbConnection,
  args: { ids: readonly number[]; now: number },
): void {
  const mark = db.$client.prepare(
    `UPDATE fork_native_parent_notices SET blocked_since = ? WHERE id = ? AND blocked_since IS NULL`,
  );
  db.$client.transaction(() => {
    for (const id of args.ids) mark.run(args.now, id);
  })();
}

export function getNativeParentNoticeDeliveredAt(
  db: DbConnection,
  parentThreadId: string,
): number | null {
  const row = db.$client
    .prepare(
      `SELECT delivered_at AS deliveredAt FROM fork_native_parent_notice_deliveries WHERE parent_thread_id = ?`,
    )
    .get(parentThreadId) as { deliveredAt: number } | undefined;
  return row?.deliveredAt ?? null;
}

export function recordNativeParentNoticeDelivery(
  db: DbConnection,
  args: { deliveredAt: number; parentThreadId: string },
): void {
  db.$client
    .prepare(
      `INSERT INTO fork_native_parent_notice_deliveries (parent_thread_id, delivered_at) VALUES (?, ?)
       ON CONFLICT (parent_thread_id) DO UPDATE SET delivered_at = excluded.delivered_at`,
    )
    .run(args.parentThreadId, args.deliveredAt);
}
