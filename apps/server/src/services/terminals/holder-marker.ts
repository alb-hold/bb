import { Buffer } from "node:buffer";
import type { TerminalOutputChunk } from "@bb/server-contract";

const PREFIX = Buffer.from("\u001b]7717;bb-holder;");
const GRID_PREFIX = Buffer.from("\u001b]7791;bb-grid;");
const LIMIT = 160;
const ESC = Buffer.from("\u001b");
const ESC_OSC = Buffer.from("\u001b]");
const ESC_CWD_OSC = Buffer.from("\u001b]7");
export const HOLDER_MARKER_PENDING_TIMEOUT_MS = 250;

export interface HolderMarkerStripState {
  chunks: TerminalOutputChunk[];
  data: Buffer[];
  releasedPrefix: Buffer | null;
}

export function isTimeoutFlushableHolderMarkerPrefix(data: Buffer): boolean {
  return data.equals(ESC) || data.equals(ESC_OSC) || data.equals(ESC_CWD_OSC);
}

export function shouldFlushHolderMarkerChunksOnTimeout(
  state: HolderMarkerStripState,
): boolean {
  if (state.data.length === 0) return true;
  const data = Buffer.concat([
    state.releasedPrefix ?? Buffer.alloc(0),
    ...state.data,
  ]);
  const candidate = holderCandidate(data);
  if (candidate === null) return true;
  if (isTimeoutFlushableHolderMarkerPrefix(candidate)) return true;
  const comparedLength = Math.min(candidate.length, PREFIX.length);
  return (
    !candidate
      .subarray(0, comparedLength)
      .equals(PREFIX.subarray(0, comparedLength)) || candidate.length < 4
  );
}

export function stripHolderMarkerChunks(
  chunk: TerminalOutputChunk,
  state: HolderMarkerStripState,
): TerminalOutputChunk[] {
  if (
    state.chunks.length === 0 &&
    state.releasedPrefix === null &&
    chunk.dataBase64.length > 0 &&
    chunk.dataBase64 !== "Gw==" &&
    !chunk.dataBase64.startsWith("G10")
  )
    return [chunk];
  const data = Buffer.from(chunk.dataBase64, "base64");
  state.chunks.push(chunk);
  state.data.push(data);
  const releasedPrefixLength = state.releasedPrefix?.length ?? 0;
  const combined = Buffer.concat([
    state.releasedPrefix ?? Buffer.alloc(0),
    ...state.data,
  ]);
  let markerOffset = 0;
  const gridPrefixLength = Math.min(combined.length, GRID_PREFIX.length);
  if (
    combined.length < GRID_PREFIX.length &&
    combined
      .subarray(0, gridPrefixLength)
      .equals(GRID_PREFIX.subarray(0, gridPrefixLength))
  )
    return [];
  if (combined.subarray(0, GRID_PREFIX.length).equals(GRID_PREFIX)) {
    const gridEnd = combined.indexOf(0x07, GRID_PREFIX.length);
    if (gridEnd < 0 && combined.length < 64) return [];
    if (gridEnd >= 0) markerOffset = gridEnd + 1;
  }
  const candidate = combined.subarray(markerOffset);
  const prefixLength = Math.min(candidate.length, PREFIX.length);
  if (
    !candidate
      .subarray(0, prefixLength)
      .equals(PREFIX.subarray(0, prefixLength))
  ) {
    if (isTimeoutFlushableHolderMarkerPrefix(candidate)) return [];
    const result = state.chunks;
    state.chunks = [];
    state.data = [];
    state.releasedPrefix = null;
    return result;
  }
  if (candidate.length < PREFIX.length) return [];
  const end = candidate.indexOf(0x07, PREFIX.length);
  if (end < 0) {
    if (candidate.length < LIMIT) return [];
    const result = state.chunks;
    state.chunks = [];
    state.data = [];
    state.releasedPrefix = null;
    return result;
  }
  const markerTerminalId = candidate
    .subarray(PREFIX.length, end)
    .toString("utf8");
  if (end + 1 > LIMIT || !/^[A-Za-z0-9_-]{1,128}$/u.test(markerTerminalId)) {
    const result = state.chunks;
    state.chunks = [];
    state.data = [];
    state.releasedPrefix = null;
    return result;
  }
  const markerStart = Math.max(0, markerOffset - releasedPrefixLength);
  const markerEnd = Math.max(0, markerOffset + end + 1 - releasedPrefixLength);
  const result: TerminalOutputChunk[] = [];
  let offset = 0;
  for (let index = 0; index < state.chunks.length; index += 1) {
    const original = state.chunks[index];
    const bytes = state.data[index];
    if (original === undefined || bytes === undefined) continue;
    const chunkStart = offset;
    const chunkEnd = chunkStart + bytes.length;
    const kept = Buffer.concat([
      bytes.subarray(
        0,
        Math.max(0, Math.min(bytes.length, markerStart - chunkStart)),
      ),
      bytes.subarray(
        Math.max(0, Math.min(bytes.length, markerEnd - chunkStart)),
      ),
    ]);
    offset = chunkEnd;
    result.push({
      ...original,
      dataBase64: kept.toString("base64"),
    });
  }
  state.chunks = [];
  state.data = [];
  state.releasedPrefix = null;
  return result;
}

function holderCandidate(data: Buffer): Buffer | null {
  if (
    data
      .subarray(0, Math.min(data.length, GRID_PREFIX.length))
      .equals(
        GRID_PREFIX.subarray(0, Math.min(data.length, GRID_PREFIX.length)),
      )
  ) {
    if (data.length < GRID_PREFIX.length) return null;
    const gridEnd = data.indexOf(0x07, GRID_PREFIX.length);
    if (gridEnd < 0) return null;
    return data.subarray(gridEnd + 1);
  }
  return data;
}

export function timeoutReleasedHolderMarkerPrefix(
  state: HolderMarkerStripState,
): Buffer | null {
  const candidate = holderCandidate(
    Buffer.concat([state.releasedPrefix ?? Buffer.alloc(0), ...state.data]),
  );
  const comparedLength = Math.min(candidate?.length ?? 0, PREFIX.length);
  return candidate !== null &&
    candidate.length < 4 &&
    candidate
      .subarray(0, comparedLength)
      .equals(PREFIX.subarray(0, comparedLength))
    ? candidate
    : null;
}

export function flushHolderMarkerChunks(
  state: HolderMarkerStripState,
): TerminalOutputChunk[] {
  const chunks = state.chunks;
  state.releasedPrefix = timeoutReleasedHolderMarkerPrefix(state);
  state.chunks = [];
  state.data = [];
  return chunks;
}
