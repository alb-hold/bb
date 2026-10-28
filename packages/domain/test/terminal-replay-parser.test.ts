import { describe, expect, it } from "vitest";
import {
  advanceTerminalReplayParserByte,
  advanceTerminalReplayParserBytes,
  createTerminalReplayParserState,
  isTerminalReplaySafeBoundary,
} from "../src/index.js";

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

const encoder = new TextEncoder();

function text(value: string): Uint8Array {
  return encoder.encode(value);
}

function concatenate(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const FRAGMENTS: ReadonlyArray<(random: () => number) => Uint8Array> = [
  (random) => text("plain text ".repeat(1 + Math.floor(random() * 6))),
  () => text("\x1b[0m\x1b[1;38;2;20;120;220m\x1b[2K\x1b[10;5H"),
  () => text("\x1b[?1049h\x1b[?25l\x1b[?2026h\x1b[?1049l"),
  () => text("\x1b[?47h\x1b[?47l\x1b[?1047;1h"),
  (random) => text(`\x1b[${"9;".repeat(Math.floor(random() * 700))}m`),
  () => text("\x1b[31"),
  () => text("\x1b]52;c;YWJjZGVm\x07"),
  () => text("\x1b]0;title\x1b\\"),
  () => text("\x1b]133;A\x07\x1bP1$r0m\x1b\\"),
  () => text("\x1b]52;c;YWJj"),
  () => text("\x1b7\x1b8\x1bM\x1b=\x1b>\x1b(B\x1b)0\x1b#8"),
  () => text("\x1b"),
  () => text("\x1b\x1b[1m\x1b\x1b]0;x\x07"),
  () => text("é ✓ 界 🙂 “quoted” — dash\r\n"),
  () => Uint8Array.from([0xe2, 0x80]),
  () => Uint8Array.from([0xf0, 0x9f]),
  () =>
    Uint8Array.from([
      0xe2, 0x80, 0x9d, 0x9c, 0x9b, 0x9d, 0x90, 0x98, 0x9e, 0x9f,
    ]),
  () => Uint8Array.from([0x9b, 0x31, 0x6d, 0x9d, 0x30, 0x3b, 0x07]),
  () => Uint8Array.from([0x18, 0x1a, 0x07, 0x00, 0x7f, 0xff, 0xc0, 0xf5]),
  (random) =>
    Uint8Array.from(
      Array.from({ length: 12 }, () => Math.floor(random() * 256)),
    ),
];

function randomStream(random: () => number): Uint8Array {
  const parts: Uint8Array[] = [];
  const count = 1 + Math.floor(random() * 14);
  for (let index = 0; index < count; index += 1) {
    parts.push(pick(random, FRAGMENTS)(random));
  }
  return concatenate(parts);
}

function randomSplit(random: () => number, stream: Uint8Array): Uint8Array[] {
  const pieces: Uint8Array[] = [];
  let offset = 0;
  while (offset < stream.length) {
    const size = 1 + Math.floor(random() * (random() < 0.5 ? 6 : 120));
    pieces.push(stream.subarray(offset, offset + size));
    offset += size;
  }
  return pieces;
}

describe("terminal replay parser bulk advance", () => {
  it("ends in exactly the state the per-byte parser reaches, for 4000 seeded streams cut at random chunk boundaries", () => {
    const random = seededRandom(20261028);
    let streams = 0;
    let chunks = 0;
    let bytesChecked = 0;
    let unsafeEnds = 0;
    let alternateScreenSeen = 0;
    for (let round = 0; round < 4000; round += 1) {
      const stream = randomStream(random);
      const reference = createTerminalReplayParserState();
      const bulk = createTerminalReplayParserState();
      for (const piece of randomSplit(random, stream)) {
        for (const byte of piece)
          advanceTerminalReplayParserByte(reference, byte);
        advanceTerminalReplayParserBytes(bulk, piece);
        expect(bulk).toEqual(reference);
        chunks += 1;
        bytesChecked += piece.length;
        if (!isTerminalReplaySafeBoundary(reference)) unsafeEnds += 1;
        if (reference.alternateScreen) alternateScreenSeen += 1;
      }
      streams += 1;
    }
    expect(streams).toBe(4000);
    expect(chunks).toBeGreaterThan(20000);
    expect(unsafeEnds).toBeGreaterThan(1000);
    expect(alternateScreenSeen).toBeGreaterThan(500);
    expect(bytesChecked).toBeGreaterThan(500000);
  });

  it("matches the per-byte parser when advancing from a start offset", () => {
    const random = seededRandom(7);
    for (let round = 0; round < 500; round += 1) {
      const stream = randomStream(random);
      const start = Math.floor(random() * stream.length);
      const reference = createTerminalReplayParserState();
      const bulk = createTerminalReplayParserState();
      for (const byte of stream.subarray(start)) {
        advanceTerminalReplayParserByte(reference, byte);
      }
      advanceTerminalReplayParserBytes(bulk, stream, start);
      expect(bulk).toEqual(reference);
    }
  });
});
