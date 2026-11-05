import type { DbConnection } from "./connection.js";

export interface PendingTerminalDaemonClose {
  hostId: string;
  terminalSessionId: string;
}

export function ensureTerminalPendingDaemonClosesTable(
  db: DbConnection,
): void {
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS fork_terminal_pending_daemon_closes (
      terminal_session_id TEXT PRIMARY KEY NOT NULL
        REFERENCES terminal_sessions(id) ON DELETE CASCADE,
      host_id TEXT NOT NULL,
      queued_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fork_terminal_pending_daemon_closes_host_idx
      ON fork_terminal_pending_daemon_closes(host_id);
  `);
}

export function queueTerminalDaemonClose(
  db: DbConnection,
  args: PendingTerminalDaemonClose & { now: number },
): void {
  db.$client
    .prepare(
      `INSERT INTO fork_terminal_pending_daemon_closes
         (terminal_session_id, host_id, queued_at)
       VALUES (?, ?, ?)
       ON CONFLICT(terminal_session_id) DO UPDATE SET
         host_id = excluded.host_id,
         queued_at = excluded.queued_at`,
    )
    .run(args.terminalSessionId, args.hostId, args.now);
}

export function listPendingTerminalDaemonCloses(
  db: DbConnection,
  hostId: string,
): PendingTerminalDaemonClose[] {
  return db.$client
    .prepare(
      `SELECT terminal_session_id AS terminalSessionId, host_id AS hostId
       FROM fork_terminal_pending_daemon_closes
       WHERE host_id = ?
       ORDER BY queued_at, terminal_session_id`,
    )
    .all(hostId) as PendingTerminalDaemonClose[];
}

export function takePendingTerminalDaemonClose(
  db: DbConnection,
  terminalSessionId: string,
): boolean {
  return (
    db.$client
      .prepare(
        `DELETE FROM fork_terminal_pending_daemon_closes
         WHERE terminal_session_id = ?`,
      )
      .run(terminalSessionId).changes > 0
  );
}
