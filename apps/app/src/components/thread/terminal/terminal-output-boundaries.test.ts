import {
  advanceTerminalReplayParserByte,
  createTerminalReplayParserState,
  isTerminalReplaySafeBoundary,
} from "@bb/domain";
import { describe, expect, it } from "vitest";
import { createTerminalOutputBoundaries } from "./terminal-output-boundaries";
import { terminalOutputBoundaryPrefix } from "./terminal-viewport";

function createReferenceBoundaries(token: string) {
  const encoder = new TextEncoder();
  const state = createTerminalReplayParserState();
  let pending: Uint8Array[] = [];
  return (bytes: Uint8Array, sequence: number): Uint8Array => {
    pending.push(encoder.encode(terminalOutputBoundaryPrefix(token, sequence)));
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
    return Buffer.concat(parts);
  };
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const FRAGMENTS: ReadonlyArray<(random: () => number) => Buffer> = [
  (random) => Buffer.from("plain text ".repeat(1 + Math.floor(random() * 6))),
  () => Buffer.from("\x1b[0m\x1b[1;38;2;20;120;220m\x1b[2K\x1b[10;5H"),
  () => Buffer.from("\x1b[?1049h\x1b[?25l\x1b[?2026h\x1b[?1049l"),
  () => Buffer.from("\x1b[31"),
  () => Buffer.from("\x1b]52;c;YWJjZGVm\x07"),
  () => Buffer.from("\x1b]0;title\x1b\\"),
  () => Buffer.from("\x1b]52;c;YWJj"),
  () => Buffer.from("\x1b7\x1b8\x1bM\x1b(B"),
  () => Buffer.from("\x1b"),
  () => Buffer.from("é ✓ 界 🙂 “quoted” — dash\r\n", "utf8"),
  () => Buffer.from([0xe2, 0x80]),
  () => Buffer.from([0xf0, 0x9f]),
  () => Buffer.from([0xe2, 0x80, 0x9d, 0x9c, 0x9b, 0x9d, 0x90, 0x98]),
  () => Buffer.from([0x9b, 0x31, 0x6d, 0x9d, 0x30, 0x3b, 0x07]),
  () => Buffer.from([0x18, 0x1a, 0x07, 0x00, 0x7f, 0xff, 0xc0, 0xf5]),
  (random) =>
    Buffer.from(Array.from({ length: 10 }, () => Math.floor(random() * 256))),
];

describe("terminal output boundary insertion", () => {
  it("emits exactly the bytes of the per-byte reference for 3000 seeded streams cut at random chunk boundaries", () => {
    const random = seededRandom(20261028);
    let streams = 0;
    let chunks = 0;
    let deferred = 0;
    let bytesChecked = 0;
    for (let round = 0; round < 3000; round += 1) {
      const stream = Buffer.concat(
        Array.from({ length: 1 + Math.floor(random() * 14) }, () =>
          (FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] ?? FRAGMENTS[0]!)(
            random,
          ),
        ),
      );
      const fast = createTerminalOutputBoundaries("tok");
      const reference = createReferenceBoundaries("tok");
      let offset = 0;
      let sequence = 0;
      while (offset < stream.length) {
        const size = 1 + Math.floor(random() * (random() < 0.5 ? 6 : 120));
        const piece = stream.subarray(offset, offset + size);
        const expected = reference(piece, sequence);
        const actual = fast.insert(piece, sequence);
        expect(Buffer.from(actual).equals(expected)).toBe(true);
        if (expected.length === piece.length) deferred += 1;
        chunks += 1;
        bytesChecked += piece.length;
        offset += size;
        sequence += 1;
      }
      streams += 1;
    }
    expect(streams).toBe(3000);
    expect(chunks).toBeGreaterThan(10000);
    expect(deferred).toBeGreaterThan(500);
    expect(bytesChecked).toBeGreaterThan(300000);
  });
});
