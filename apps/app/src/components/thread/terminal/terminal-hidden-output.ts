import type { TerminalOutputChunk } from "@bb/server-contract";

const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export function createTerminalHiddenOutput(onInvalidated?: () => void) {
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
    onInvalidated?.();
  };
  return {
    clear,
    invalidate,
    get hasPending() {
      return chunks.length > 0;
    },
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
    takeBatch(maxBytes: number): TerminalOutputChunk[] {
      if (needsReplay) return [];
      let count = 0;
      let batchBytes = 0;
      while (count < chunks.length) {
        const size = chunks[count]!.dataBase64.length * 2 + 64;
        if (count > 0 && batchBytes + size > maxBytes) break;
        batchBytes += size;
        count++;
        if (batchBytes >= maxBytes) break;
      }
      bytes -= batchBytes;
      return chunks.splice(0, count);
    },
    take(): TerminalOutputChunk[] | null {
      const result = needsReplay ? null : chunks;
      clear();
      return result;
    },
  };
}
