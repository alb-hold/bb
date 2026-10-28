import {
  advanceTerminalReplayParserByte,
  createTerminalReplayParserState,
  isTerminalReplaySafeBoundary,
} from "@bb/domain";
import { terminalOutputBoundaryPrefix } from "./terminal-viewport";

export interface TerminalOutputBoundaries {
  insert(bytes: Uint8Array, sequence: number): Uint8Array;
  reset(): void;
}

export function createTerminalOutputBoundaries(
  token: string,
): TerminalOutputBoundaries {
  const encoder = new TextEncoder();
  let state = createTerminalReplayParserState();
  let pending: Uint8Array[] = [];
  return {
    insert(bytes, sequence) {
      pending.push(
        encoder.encode(terminalOutputBoundaryPrefix(token, sequence)),
      );
      const parts: Uint8Array[] = [];
      let start = 0;
      const flush = (end: number) => {
        parts.push(bytes.subarray(start, end), ...pending);
        pending = [];
        start = end;
      };
      if (isTerminalReplaySafeBoundary(state)) flush(0);
      for (let index = 0; index < bytes.length; index += 1) {
        advanceTerminalReplayParserByte(state, bytes[index] ?? 0);
        if (pending.length > 0 && isTerminalReplaySafeBoundary(state)) {
          flush(index + 1);
        }
      }
      parts.push(bytes.subarray(start));
      const result = new Uint8Array(
        parts.reduce((total, part) => total + part.length, 0),
      );
      let offset = 0;
      for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
      }
      return result;
    },
    reset() {
      state = createTerminalReplayParserState();
      pending = [];
    },
  };
}
