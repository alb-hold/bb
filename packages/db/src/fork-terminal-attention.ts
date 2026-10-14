import type { DbConnection } from "./connection.js";

export type TerminalAttentionKind = "bell" | "osc-9" | "osc-99" | "osc-777";

export interface TerminalAttentionRecord {
  terminalSessionId: string;
  seq: number;
  kind: TerminalAttentionKind;
  title: string | null;
  body: string | null;
  attentionAt: number;
  clearedAt: number | null;
  updatedAt: number;
}

export function ensureTerminalAttentionTable(db: DbConnection): void {
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS fork_terminal_attention (
      terminal_session_id TEXT PRIMARY KEY NOT NULL
        REFERENCES terminal_sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL CHECK (seq >= 0),
      kind TEXT NOT NULL CHECK (kind IN ('bell', 'osc-9', 'osc-99', 'osc-777')),
      title TEXT,
      body TEXT,
      attention_at INTEGER NOT NULL,
      cleared_at INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);
}

export function getTerminalAttention(
  db: DbConnection,
  terminalSessionId: string,
): TerminalAttentionRecord | null {
  const row = db.$client
    .prepare(
      `SELECT terminal_session_id AS terminalSessionId, seq, kind, title, body,
              attention_at AS attentionAt, cleared_at AS clearedAt, updated_at AS updatedAt
       FROM fork_terminal_attention WHERE terminal_session_id = ?`,
    )
    .get(terminalSessionId) as TerminalAttentionRecord | undefined;
  return row ?? null;
}

export function upsertTerminalAttention(
  db: DbConnection,
  args: {
    terminalSessionId: string;
    seq: number;
    kind: TerminalAttentionKind;
    title: string | null;
    body: string | null;
    attentionAt: number;
  },
): void {
  db.$client
    .prepare(
      `INSERT INTO fork_terminal_attention
         (terminal_session_id, seq, kind, title, body, attention_at, cleared_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(terminal_session_id) DO UPDATE SET
         seq = excluded.seq,
         kind = excluded.kind,
         title = excluded.title,
         body = excluded.body,
         attention_at = excluded.attention_at,
         cleared_at = NULL,
         updated_at = excluded.updated_at
       WHERE excluded.seq > fork_terminal_attention.seq`,
    )
    .run(
      args.terminalSessionId,
      args.seq,
      args.kind,
      args.title,
      args.body,
      args.attentionAt,
      args.attentionAt,
    );
}

export function clearTerminalAttention(
  db: DbConnection,
  terminalSessionId: string,
  clearedAt: number,
): void {
  db.$client
    .prepare(
      `UPDATE fork_terminal_attention
       SET cleared_at = ?, updated_at = ?
       WHERE terminal_session_id = ? AND cleared_at IS NULL`,
    )
    .run(clearedAt, clearedAt, terminalSessionId);
}
