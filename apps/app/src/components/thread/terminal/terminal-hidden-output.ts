import type { TerminalOutputChunk } from "@bb/server-contract";

const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export function createTerminalHiddenOutput() {
  let chunks: TerminalOutputChunk[] = [];
  let bytes = 0;
  let nextSeq: number | null = null;
  let needsReplay = false;
  const clear = () => {
    chunks = [];
    bytes = 0;
    nextSeq = null;
    needsReplay = false;
  };
  const invalidate = () => {
    clear();
    needsReplay = true;
  };
  return {
    clear,
    invalidate,
    push(chunk: TerminalOutputChunk, expectedNextSeq: number) {
      if (needsReplay) return;
      const expected = nextSeq ?? expectedNextSeq;
      if (chunk.seq < expected) return;
      const size = chunk.dataBase64.length * 2 + 64;
      if (chunk.seq !== expected || bytes + size > MAX_BUFFERED_BYTES) {
        invalidate();
        return;
      }
      chunks.push(chunk);
      bytes += size;
      nextSeq = chunk.seq + 1;
    },
    take(): TerminalOutputChunk[] | null {
      const result = needsReplay ? null : chunks;
      clear();
      return result;
    },
  };
}
