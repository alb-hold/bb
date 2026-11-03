import type { DbConnection } from "./connection.js";

export function ensureTerminalHolderSessionsTable(db: DbConnection): void {
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS fork_terminal_holder_sessions (
      terminal_id TEXT PRIMARY KEY NOT NULL
        REFERENCES terminal_sessions(id) ON DELETE CASCADE,
      confirmed_at INTEGER NOT NULL
    );
  `);
}
