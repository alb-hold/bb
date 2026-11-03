import { sql } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "./connection.js";
import { findLastTerminalGridMarker } from "@bb/domain";

export const TERMINAL_RETAINED_OUTPUT_BYTES = 64 * 1024;
export const HOST_RETAINED_OUTPUT_BYTES = 2 * 1024 * 1024;
export const HOST_RETAINED_TERMINAL_LIMIT = 128;
export const TERMINAL_OUTPUT_RETENTION_MS = 30 * 60_000;
const PRUNE_BATCH_ROWS = 128;

export interface RetainedTerminalOutputChunk {
  seq: number;
  dataBase64: string;
}

export interface RetainedTerminalOutputAppendTimings {
  totalMs: number;
  expiryPruneMs: number;
  ownerLookupMs: number;
  rowReadParseMs: number;
  chunkLoopMs: number;
  upsertMs: number;
  hostRetentionMs: number;
  chunkCount: number;
  inputBytes: number;
  existingRowBytes: number;
  rowsPruned: number;
  hostRowsTrimmed: number;
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

function canonicalRetainedChunk(entry: RetainedChunk): RetainedChunk {
  return {
    chunk: { seq: entry.chunk.seq, dataBase64: entry.chunk.dataBase64 },
    ...(entry.leadingGridMarker === undefined
      ? {}
      : { leadingGridMarker: entry.leadingGridMarker }),
    retainedAt: entry.retainedAt,
  };
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
  appendRetainedTerminalOutputChunks(db, {
    hostId: args.hostId,
    terminalSessionId: args.terminalSessionId,
    chunks: [args.chunk],
    clock: () => args.now,
  });
}

export function appendRetainedTerminalOutputChunks(
  db: DbConnection,
  args: {
    hostId: string;
    terminalSessionId: string;
    chunks: RetainedTerminalOutputChunk[];
    clock: () => number;
    measureClock?: () => number;
  },
): RetainedTerminalOutputAppendTimings {
  const measure =
    args.measureClock ?? (() => Number(process.hrtime.bigint()) / 1_000_000);
  const timings: RetainedTerminalOutputAppendTimings = {
    totalMs: 0,
    expiryPruneMs: 0,
    ownerLookupMs: 0,
    rowReadParseMs: 0,
    chunkLoopMs: 0,
    upsertMs: 0,
    hostRetentionMs: 0,
    chunkCount: args.chunks.length,
    inputBytes: args.chunks.reduce((sum, chunk) => sum + chunkBytes(chunk), 0),
    existingRowBytes: 0,
    rowsPruned: 0,
    hostRowsTrimmed: 0,
  };
  if (args.chunks.length === 0) return timings;
  const totalStarted = measure();
  let phaseStarted = measure();
  const run = db.$client.transaction(() => {
    const nextExpiryStatement = db.$client.prepare(
      `SELECT MIN(expires_at) AS nextExpiry FROM fork_terminal_output
       WHERE expires_at IS NOT NULL`,
    );
    let lastPruned = 0;
    let nextExpiry: number | null = null;
    const prune = (now: number, always: boolean): boolean => {
      const pruneStarted = measure();
      if (
        !always &&
        lastPruned < PRUNE_BATCH_ROWS &&
        (nextExpiry === null || nextExpiry > now)
      ) {
        timings.expiryPruneMs += measure() - pruneStarted;
        return false;
      }
      lastPruned = pruneRetainedTerminalOutput(db, now);
      timings.rowsPruned += lastPruned;
      nextExpiry = (
        nextExpiryStatement.get() as { nextExpiry: number | null }
      ).nextExpiry;
      timings.expiryPruneMs += measure() - pruneStarted;
      return true;
    };
    const firstNow = args.clock();
    prune(firstNow, true);
    phaseStarted = measure();
    const owner = db.$client
      .prepare("SELECT host_id AS hostId FROM terminal_sessions WHERE id = ?")
      .get(args.terminalSessionId) as { hostId: string } | undefined;
    timings.ownerLookupMs += measure() - phaseStarted;
    if (owner?.hostId !== args.hostId) {
      for (let index = 1; index < args.chunks.length; index += 1) {
        prune(args.clock(), false);
      }
      return;
    }

    phaseStarted = measure();
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
    timings.existingRowBytes = existing?.byteLength ?? 0;
    const ownRowStatement = db.$client.prepare(
      `SELECT 1 AS present FROM fork_terminal_output
       WHERE terminal_session_id = ? AND host_id = ?`,
    );
    const deleteOwnRow = db.$client.prepare(
      `DELETE FROM fork_terminal_output WHERE terminal_session_id = ?`,
    );
    const chunks = existing ? parseChunks(existing.chunksJson) : [];
    timings.rowReadParseMs += measure() - phaseStarted;
    phaseStarted = measure();
    const seenSequences = new Set(chunks.map(({ chunk }) => chunk.seq));
    let appended = false;
    let ownRowStored = existing !== undefined;
    let ownRowExpiresAt = existing?.expiresAt ?? null;
    let insertedRetainedAt: number | null = null;
    let lastNow = firstNow;
    let bytes = chunks.reduce(
      (total, entry) => total + chunkBytes(entry.chunk),
      0,
    );
    const expiryPruneBeforeChunkLoop = timings.expiryPruneMs;
    for (const [index, chunk] of args.chunks.entries()) {
      const now = index === 0 ? firstNow : args.clock();
      lastNow = now;
      const didPrune = index > 0 && prune(now, false);
      if (
        didPrune &&
        ownRowExpiresAt !== null &&
        ownRowStatement.get(args.terminalSessionId, args.hostId) === undefined
      ) {
        chunks.length = 0;
        seenSequences.clear();
        bytes = 0;
        ownRowStored = false;
        ownRowExpiresAt = null;
      }
      if (seenSequences.has(chunk.seq)) continue;
      seenSequences.add(chunk.seq);
      if (ownRowExpiresAt !== null) {
        db.$client
          .prepare(
            `UPDATE fork_terminal_output SET expires_at = NULL
             WHERE terminal_session_id = ? AND host_id = ?`,
          )
          .run(args.terminalSessionId, args.hostId);
        ownRowExpiresAt = null;
        nextExpiry = (
          nextExpiryStatement.get() as { nextExpiry: number | null }
        ).nextExpiry;
      }
      appended = true;
      const first = chunks[0];
      if (first) chunks[0] = canonicalRetainedChunk(first);
      const lastIndex = chunks.length - 1;
      const last = chunks[lastIndex];
      if (last) chunks[lastIndex] = canonicalRetainedChunk(last);
      const data = Buffer.from(chunk.dataBase64, "base64");
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
          ? chunk
          : { ...chunk, dataBase64: retainedData.toString("base64") };
      chunks.push({
        chunk: boundedChunk,
        ...(leadingGridMarker === undefined ? {} : { leadingGridMarker }),
        retainedAt: now,
      });
      bytes += chunkBytes(boundedChunk);
      while (bytes > TERMINAL_RETAINED_OUTPUT_BYTES && chunks.length > 0) {
        const removed = chunks.shift();
        if (removed) {
          bytes -= chunkBytes(removed.chunk);
          seenSequences.delete(removed.chunk.seq);
        }
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
        if (ownRowStored) deleteOwnRow.run(args.terminalSessionId);
        chunks.length = 0;
        seenSequences.clear();
        ownRowStored = false;
        insertedRetainedAt = null;
      } else if (!ownRowStored) {
        ownRowStored = true;
        insertedRetainedAt = chunks[0]?.retainedAt ?? now;
      }
    }
    timings.chunkLoopMs +=
      measure() -
      phaseStarted -
      (timings.expiryPruneMs - expiryPruneBeforeChunkLoop);
    if (!appended || bytes === 0) return;
    phaseStarted = measure();
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
        insertedRetainedAt ?? chunks[0]?.retainedAt ?? lastNow,
      );
    timings.upsertMs += measure() - phaseStarted;

    phaseStarted = measure();
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
            oldestChunks[0]?.retainedAt ?? lastNow,
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
      timings.hostRowsTrimmed += 1;
    }
    timings.hostRetentionMs += measure() - phaseStarted;
  });
  run();
  timings.totalMs = measure() - totalStarted;
  return timings;
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

export function getRetainedTerminalOutputLatestSeq(
  db: DbQueryConnection,
  args: { hostId: string; terminalSessionId: string; now: number },
): number | null {
  const row = db.get<{ chunksJson: string } | undefined>(sql`
    SELECT chunks_json AS chunksJson FROM fork_terminal_output
    WHERE terminal_session_id = ${args.terminalSessionId}
      AND host_id = ${args.hostId}
      AND (expires_at IS NULL OR expires_at > ${args.now})
  `);
  if (!row) return null;
  const last = parseChunks(row.chunksJson).at(-1);
  return last === undefined ? null : last.chunk.seq;
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
         WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT ?
       )`,
    )
    .run(now, PRUNE_BATCH_ROWS).changes;
}
