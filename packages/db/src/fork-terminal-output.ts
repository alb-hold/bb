import type { DbConnection } from "./connection.js";
import { findLastTerminalGridMarker } from "@bb/domain";

export const TERMINAL_RETAINED_OUTPUT_BYTES = 64 * 1024;
export const HOST_RETAINED_OUTPUT_BYTES = 2 * 1024 * 1024;
export const HOST_RETAINED_TERMINAL_LIMIT = 128;
export const TERMINAL_OUTPUT_RETENTION_MS = 30 * 60_000;

export interface RetainedTerminalOutputChunk {
  seq: number;
  dataBase64: string;
}

interface RetainedTerminalOutputRow {
  chunksJson: string;
  byteLength: number;
  retainedAt: number;
  expiresAt: number | null;
}

interface RetainedChunk {
  chunk: RetainedTerminalOutputChunk;
  leadingGridMarker?: string;
  retainedAt: number;
}

function parseChunks(chunksJson: string): RetainedChunk[] {
  const value: unknown = JSON.parse(chunksJson);
  if (!Array.isArray(value))
    throw new Error("Invalid retained terminal output");
  const chunks: RetainedChunk[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("chunk" in entry) ||
      !("retainedAt" in entry) ||
      typeof entry.retainedAt !== "number" ||
      !Number.isInteger(entry.retainedAt) ||
      ("leadingGridMarker" in entry &&
        typeof entry.leadingGridMarker !== "string") ||
      typeof entry.chunk !== "object" ||
      entry.chunk === null ||
      !("seq" in entry.chunk) ||
      !("dataBase64" in entry.chunk) ||
      typeof entry.chunk.seq !== "number" ||
      !Number.isInteger(entry.chunk.seq) ||
      entry.chunk.seq < 0 ||
      typeof entry.chunk.dataBase64 !== "string"
    ) {
      throw new Error("Invalid retained terminal output");
    }
    chunks.push({
      chunk: {
        seq: entry.chunk.seq,
        dataBase64: entry.chunk.dataBase64,
      },
      ...(typeof entry.leadingGridMarker === "string"
        ? { leadingGridMarker: entry.leadingGridMarker }
        : {}),
      retainedAt: entry.retainedAt,
    });
  }
  return chunks;
}

function chunkBytes(chunk: RetainedTerminalOutputChunk): number {
  return Buffer.byteLength(chunk.dataBase64, "base64");
}

export function appendRetainedTerminalOutputChunk(
  db: DbConnection,
  args: {
    hostId: string;
    terminalSessionId: string;
    chunk: RetainedTerminalOutputChunk;
    now: number;
  },
): void {
  const run = db.$client.transaction(() => {
    pruneRetainedTerminalOutput(db, args.now);
    const owner = db.$client
      .prepare("SELECT host_id AS hostId FROM terminal_sessions WHERE id = ?")
      .get(args.terminalSessionId) as { hostId: string } | undefined;
    if (owner?.hostId !== args.hostId) return;

    const existing = db.$client
      .prepare(
        `SELECT chunks_json AS chunksJson, byte_length AS byteLength,
                retained_at AS retainedAt, expires_at AS expiresAt
         FROM fork_terminal_output
         WHERE terminal_session_id = ? AND host_id = ?`,
      )
      .get(args.terminalSessionId, args.hostId) as
      | RetainedTerminalOutputRow
      | undefined;
    const chunks = existing ? parseChunks(existing.chunksJson) : [];
    if (chunks.some(({ chunk }) => chunk.seq === args.chunk.seq)) return;
    const data = Buffer.from(args.chunk.dataBase64, "base64");
    let leadingGridMarker: string | undefined;
    let retainedData = data;
    if (data.byteLength > TERMINAL_RETAINED_OUTPUT_BYTES) {
      retainedData = data.subarray(
        data.byteLength - TERMINAL_RETAINED_OUTPUT_BYTES,
      );
      leadingGridMarker =
        findLastTerminalGridMarker(
          data
            .subarray(0, data.byteLength - TERMINAL_RETAINED_OUTPUT_BYTES)
            .toString("utf8"),
        ) ?? undefined;
    }
    const boundedChunk =
      retainedData === data
        ? args.chunk
        : { ...args.chunk, dataBase64: retainedData.toString("base64") };
    chunks.push({
      chunk: boundedChunk,
      ...(leadingGridMarker === undefined ? {} : { leadingGridMarker }),
      retainedAt: args.now,
    });
    let bytes = chunks.reduce(
      (total, entry) => total + chunkBytes(entry.chunk),
      0,
    );
    while (bytes > TERMINAL_RETAINED_OUTPUT_BYTES && chunks.length > 0) {
      const removed = chunks.shift();
      if (removed) bytes -= chunkBytes(removed.chunk);
      if (removed && chunks[0]) {
        const latestGridMarker =
          findLastTerminalGridMarker(
            Buffer.from(removed.chunk.dataBase64, "base64").toString("utf8"),
          ) ?? removed.leadingGridMarker;
        if (latestGridMarker !== undefined) {
          chunks[0].leadingGridMarker = latestGridMarker;
        }
      }
    }
    if (bytes === 0) {
      db.$client
        .prepare(
          `DELETE FROM fork_terminal_output WHERE terminal_session_id = ?`,
        )
        .run(args.terminalSessionId);
      return;
    }
    db.$client
      .prepare(
        `INSERT INTO fork_terminal_output
           (terminal_session_id, host_id, chunks_json, byte_length, retained_at, expires_at)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(terminal_session_id) DO UPDATE SET
           host_id = excluded.host_id,
           chunks_json = excluded.chunks_json,
           byte_length = excluded.byte_length,
           expires_at = NULL`,
      )
      .run(
        args.terminalSessionId,
        args.hostId,
        JSON.stringify(chunks),
        bytes,
        chunks[0]?.retainedAt ?? args.now,
      );

    let hostTotals = db.$client
      .prepare(
        `SELECT COUNT(*) AS bufferCount, COALESCE(SUM(byte_length), 0) AS byteLength
         FROM fork_terminal_output WHERE host_id = ?`,
      )
      .get(args.hostId) as { bufferCount: number; byteLength: number };
    while (
      hostTotals.bufferCount > HOST_RETAINED_TERMINAL_LIMIT ||
      hostTotals.byteLength > HOST_RETAINED_OUTPUT_BYTES
    ) {
      const oldest = db.$client
        .prepare(
          `SELECT terminal_session_id AS terminalSessionId, chunks_json AS chunksJson
           FROM fork_terminal_output WHERE host_id = ?
           ORDER BY retained_at ASC, rowid ASC LIMIT 1`,
        )
        .get(args.hostId) as
        | { terminalSessionId: string; chunksJson: string }
        | undefined;
      if (!oldest) break;
      const oldestChunks = parseChunks(oldest.chunksJson);
      const removed = oldestChunks.shift();
      if (removed && oldestChunks[0]) {
        const latestGridMarker =
          findLastTerminalGridMarker(
            Buffer.from(removed.chunk.dataBase64, "base64").toString("utf8"),
          ) ?? removed.leadingGridMarker;
        if (latestGridMarker !== undefined) {
          oldestChunks[0].leadingGridMarker = latestGridMarker;
        }
      }
      if (oldestChunks.length === 0) {
        db.$client
          .prepare(
            `DELETE FROM fork_terminal_output
             WHERE terminal_session_id = ? AND host_id = ?`,
          )
          .run(oldest.terminalSessionId, args.hostId);
      } else {
        const removedBytes = removed ? chunkBytes(removed.chunk) : 0;
        db.$client
          .prepare(
            `UPDATE fork_terminal_output
             SET chunks_json = ?, byte_length = byte_length - ?, retained_at = ?
             WHERE terminal_session_id = ? AND host_id = ?`,
          )
          .run(
            JSON.stringify(oldestChunks),
            removedBytes,
            oldestChunks[0]?.retainedAt ?? args.now,
            oldest.terminalSessionId,
            args.hostId,
          );
      }
      hostTotals = {
        bufferCount:
          hostTotals.bufferCount - (oldestChunks.length === 0 ? 1 : 0),
        byteLength:
          hostTotals.byteLength - (removed ? chunkBytes(removed.chunk) : 0),
      };
    }
  });
  run();
}

export function markRetainedTerminalOutputExited(
  db: DbConnection,
  terminalSessionId: string,
  hostId: string,
  now: number,
): void {
  db.$client
    .prepare(
      `UPDATE fork_terminal_output SET expires_at = ? WHERE terminal_session_id = ? AND host_id = ?`,
    )
    .run(now + TERMINAL_OUTPUT_RETENTION_MS, terminalSessionId, hostId);
}

export function dismissRetainedTerminalOutput(
  db: DbConnection,
  terminalSessionId: string,
  hostId: string,
  now: number,
): void {
  db.$client.transaction(() => {
    db.$client
      .prepare(
        `DELETE FROM fork_terminal_tab_dismissals
         WHERE host_id = ? AND expires_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM fork_terminal_output AS output
             WHERE output.terminal_session_id = fork_terminal_tab_dismissals.terminal_session_id
               AND output.host_id = fork_terminal_tab_dismissals.host_id
               AND output.expires_at > ?
           )`,
      )
      .run(hostId, now, now);
    const retainedOutput = db.$client
      .prepare(
        `SELECT expires_at AS expiresAt FROM fork_terminal_output
         WHERE terminal_session_id = ? AND host_id = ? AND expires_at > ?`,
      )
      .get(terminalSessionId, hostId, now) as { expiresAt: number } | undefined;
    if (!retainedOutput) return;
    db.$client
      .prepare(
        `INSERT INTO fork_terminal_tab_dismissals
           (terminal_session_id, host_id, dismissed_at, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(terminal_session_id) DO UPDATE SET
           host_id = excluded.host_id,
           dismissed_at = excluded.dismissed_at,
           expires_at = excluded.expires_at`,
      )
      .run(terminalSessionId, hostId, now, retainedOutput.expiresAt);
  })();
}

export function getRetainedTerminalOutput(
  db: DbConnection,
  args: { hostId: string; terminalSessionId: string; now: number },
): RetainedTerminalOutputChunk[] | null {
  pruneRetainedTerminalOutput(db, args.now);
  const row = db.$client
    .prepare(
      `SELECT chunks_json AS chunksJson FROM fork_terminal_output
       WHERE terminal_session_id = ? AND host_id = ?
         AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(args.terminalSessionId, args.hostId, args.now) as
    | { chunksJson: string }
    | undefined;
  if (!row) return null;
  return parseChunks(row.chunksJson).map(
    ({ chunk, leadingGridMarker }, index) => {
      if (index !== 0 || leadingGridMarker === undefined) return chunk;
      const marker = Buffer.from(leadingGridMarker, "utf8");
      const data = Buffer.from(chunk.dataBase64, "base64");
      const leadingOscEnd = data.indexOf(0x07);
      const existingLeadingMarker =
        leadingOscEnd >= 0
          ? data.subarray(0, leadingOscEnd + 1).toString("latin1")
          : "";
      if (
        findLastTerminalGridMarker(existingLeadingMarker) ===
        existingLeadingMarker
      ) {
        return chunk;
      }
      const boundedData =
        marker.byteLength + data.byteLength > TERMINAL_RETAINED_OUTPUT_BYTES
          ? data.subarray(marker.byteLength)
          : data;
      return {
        ...chunk,
        dataBase64: Buffer.concat([marker, boundedData]).toString("base64"),
      };
    },
  );
}

export function pruneRetainedTerminalOutput(
  db: DbConnection,
  now: number,
): number {
  return db.$client
    .prepare(
      `DELETE FROM fork_terminal_output
       WHERE terminal_session_id IN (
         SELECT terminal_session_id FROM fork_terminal_output
         WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT 128
       )`,
    )
    .run(now).changes;
}
