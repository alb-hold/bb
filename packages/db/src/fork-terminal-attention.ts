import type { DbConnection } from "./connection.js";

export type TerminalAttentionKind = "bell" | "osc-9" | "osc-99" | "osc-777";

export interface TerminalAttentionRecord {
  terminalSessionId: string;
  seq: number;
  daemonSeq: number | null;
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
      daemon_seq INTEGER,
      kind TEXT NOT NULL CHECK (kind IN ('bell', 'osc-9', 'osc-99', 'osc-777')),
      title TEXT,
      body TEXT,
      attention_at INTEGER NOT NULL,
      cleared_at INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);
  const columns = db.$client
    .prepare(`PRAGMA table_info(fork_terminal_attention)`)
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "daemon_seq")) {
    db.$client.exec(
      `ALTER TABLE fork_terminal_attention ADD COLUMN daemon_seq INTEGER`,
    );
  }
}

export function getTerminalAttention(
  db: DbConnection,
  terminalSessionId: string,
): TerminalAttentionRecord | null {
  const row = db.$client
    .prepare(
      `SELECT terminal_session_id AS terminalSessionId, seq,
              daemon_seq AS daemonSeq, kind, title, body,
              attention_at AS attentionAt, cleared_at AS clearedAt, updated_at AS updatedAt
       FROM fork_terminal_attention WHERE terminal_session_id = ?`,
    )
    .get(terminalSessionId) as TerminalAttentionRecord | undefined;
  return row ?? null;
}

export function listTerminalAttention(
  db: DbConnection,
): TerminalAttentionRecord[] {
  return db.$client
    .prepare(
      `SELECT a.terminal_session_id AS terminalSessionId, a.seq,
              a.daemon_seq AS daemonSeq, a.kind, a.title, a.body,
              a.attention_at AS attentionAt, a.cleared_at AS clearedAt,
              a.updated_at AS updatedAt
       FROM fork_terminal_attention a
       JOIN terminal_sessions t ON t.id = a.terminal_session_id
       WHERE a.cleared_at IS NULL
         AND t.status IN ('starting', 'running', 'disconnected')
       ORDER BY a.attention_at ASC, t.created_at ASC, t.id ASC`,
    )
    .all() as TerminalAttentionRecord[];
}

export function upsertTerminalAttention(
  db: DbConnection,
  args: {
    terminalSessionId: string;
    seq: number;
    daemonSeq: number | null;
    kind: TerminalAttentionKind;
    title: string | null;
    body: string | null;
    attentionAt: number;
  },
): void {
  db.$client
    .prepare(
      `INSERT INTO fork_terminal_attention
         (terminal_session_id, seq, daemon_seq, kind, title, body, attention_at, cleared_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(terminal_session_id) DO UPDATE SET
         seq = excluded.seq,
         daemon_seq = excluded.daemon_seq,
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
      args.daemonSeq,
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
