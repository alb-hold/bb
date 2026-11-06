import type { TerminalOutputChunk } from "@bb/server-contract";
import { decodeBase64Bytes } from "@/lib/base64-bytes";
import type { TerminalOutputBoundaries } from "./terminal-output-boundaries";

function concatenate(parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

export function* terminalReplayWrites(
  chunks: readonly TerminalOutputChunk[],
  boundaries?: TerminalOutputBoundaries,
  checkpoint?: number | null,
): Generator<{
  chunk: TerminalOutputChunk;
  bytes: Uint8Array;
  sourceBytes: Uint8Array;
}> {
  let parts: Uint8Array[] = [];
  let sources: Uint8Array[] = [];
  let size = 0;
  let last: TerminalOutputChunk | null = null;
  for (const chunk of chunks) {
    const source = decodeBase64Bytes(chunk.dataBase64);
    if (
      last !== null &&
      (size + source.length > 16 * 1024 || chunk.seq === checkpoint)
    ) {
      yield {
        chunk: last,
        bytes: concatenate(parts),
        sourceBytes: concatenate(sources),
      };
      parts = [];
      sources = [];
      size = 0;
    }
    parts.push(boundaries?.insert(source, chunk.seq) ?? source);
    sources.push(source);
    size += source.length;
    last = chunk;
  }
  if (last !== null)
    yield {
      chunk: last,
      bytes: concatenate(parts),
      sourceBytes: concatenate(sources),
    };
}
