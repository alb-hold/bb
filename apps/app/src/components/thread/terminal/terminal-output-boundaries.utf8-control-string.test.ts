// @vitest-environment jsdom

import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { handleTerminalServerMessage } from "./ThreadTerminalView";
import { createTerminalOutputBoundaries } from "./terminal-output-boundaries";
import { registerTerminalOutputBoundaryHandler } from "./terminal-viewport";

interface Observed {
  text: string;
  titles: string[];
}

function newTerminal(): { terminal: Terminal; titles: string[] } {
  const terminal = new Terminal({
    cols: 100,
    rows: 30,
    allowProposedApi: true,
  });
  const titles: string[] = [];
  terminal.onTitleChange((title) => titles.push(title));
  return { terminal, titles };
}

function observe(terminal: Terminal, titles: string[]): Observed {
  const lines = Array.from(
    { length: terminal.buffer.active.length },
    (_, index) =>
      terminal.buffer.active.getLine(index)?.translateToString(true) ?? "",
  );
  return { text: lines.join("\n"), titles };
}

async function renderWithoutMarkers(stream: Uint8Array): Promise<Observed> {
  const { terminal, titles } = newTerminal();
  await new Promise<void>((resolve) => terminal.write(stream, resolve));
  return observe(terminal, titles);
}

async function renderWithMarkers(
  chunks: Uint8Array[],
): Promise<Observed & { starts: number[] }> {
  const { terminal, titles } = newTerminal();
  const token = "utf8-token";
  const starts: number[] = [];
  const outputBoundaries = createTerminalOutputBoundaries(token);
  registerTerminalOutputBoundaryHandler(terminal.parser, token, (sequence) =>
    starts.push(sequence),
  );
  for (const [sequence, chunk] of chunks.entries()) {
    await new Promise<void>((resolve) => {
      handleTerminalServerMessage({
        acknowledgeOutput: () => undefined,
        message: {
          type: "output",
          chunk: {
            seq: sequence,
            dataBase64: Buffer.from(chunk).toString("base64"),
          },
        },
        onOutputParsed: () => resolve(),
        onOutputFrameParsed: () => undefined,
        onReplayComplete: () => undefined,
        replayNextSeq: null,
        replayWriteState: { suppressedWriteCount: 0 },
        setReplayNextSeq: () => undefined,
        terminal,
        outputBoundaries,
      });
    });
  }
  return { ...observe(terminal, titles), starts };
}

const encoder = new TextEncoder();
const text = (value: string) => encoder.encode(value);

describe("output boundary markers around UTF-8 inside control strings", () => {
  it.each([
    ["OSC 0 title with Ŝ (C5 9C)", "\x1b]0;cŜur\x07after\r\n"],
    [
      "OSC 2 title with a curly quote (E2 80 9C) and ST",
      "\x1b]2;say “hi” ’ …\x1b\\after\r\n",
    ],
    [
      "OSC 8 hyperlink with Ŝ and a curly quote in its parameters",
      "\x1b]8;id=Ŝ;https://example.test/“x”\x1b\\link text\x1b]8;;\x1b\\ after\r\n",
    ],
    ["DCS string with Ŝ", "\x1bP1$rŜ\x1b\\after\r\n"],
    ["OSC 52 copy with “ in the payload tail", "\x1b]52;c;YWJj\x07“ after\r\n"],
  ])(
    "renders %s exactly as without markers, with one marker per chunk, for every two-chunk split",
    async (_name, source) => {
      const stream = text(source);
      expect(stream.includes(0x9c)).toBe(true);
      const reference = await renderWithoutMarkers(stream);
      expect(reference.text).toContain("after");

      for (let offset = 1; offset < stream.length; offset += 1) {
        const chunks = [stream.subarray(0, offset), stream.subarray(offset)];
        const actual = await renderWithMarkers(chunks);

        expect({ offset, starts: actual.starts }).toEqual({
          offset,
          starts: [0, 1],
        });
        expect({ offset, titles: actual.titles }).toEqual({
          offset,
          titles: reference.titles,
        });
        expect({ offset, text: actual.text }).toEqual({
          offset,
          text: reference.text,
        });
      }
    },
  );
});

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const FRAGMENTS: ReadonlyArray<Uint8Array> = [
  text("plain text\r\n"),
  text("\x1b[1;32mgreen\x1b[0m done\r\n"),
  text("\x1b]0;cŜur “quoted” ’ …\x07"),
  text("\x1b]2;title Ŝ\x1b\\"),
  text("\x1b]8;id=Ŝ;https://example.test/“x”\x1b\\link\x1b]8;;\x1b\\ "),
  text("\x1b]52;c;YWJj\x07“ copied ”\r\n"),
  text("\x1bP1$rŜ“\x1b\\"),
  text("“ ” ’ … — ✓ 界 🙂 Ŝ\r\n"),
  Uint8Array.from([0xe2, 0x80]),
  Uint8Array.from([0xc5]),
  Uint8Array.from([0x1b, 0x5d, 0x30, 0x3b, 0xe2, 0x80, 0x9c]),
  Uint8Array.from([0x07]),
];

describe("output boundary markers keep xterm output unchanged", () => {
  it("renders 400 seeded streams with UTF-8 control strings exactly as without markers wherever they are cut", async () => {
    const random = seededRandom(20261028);
    let streams = 0;
    let chunks = 0;
    let titlesChecked = 0;
    for (let round = 0; round < 400; round += 1) {
      const parts: Uint8Array[] = [];
      for (let index = 0; index < 1 + Math.floor(random() * 6); index += 1) {
        parts.push(
          FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] ?? FRAGMENTS[0]!,
        );
      }
      const stream = new Uint8Array(
        parts.reduce((total, part) => total + part.length, 0),
      );
      let at = 0;
      for (const part of parts) {
        stream.set(part, at);
        at += part.length;
      }
      const pieces: Uint8Array[] = [];
      for (let offset = 0; offset < stream.length; ) {
        const size = 1 + Math.floor(random() * (random() < 0.5 ? 4 : 30));
        pieces.push(stream.subarray(offset, offset + size));
        offset += size;
      }
      const reference = await renderWithoutMarkers(stream);
      const actual = await renderWithMarkers(pieces);

      expect(actual.titles).toEqual(reference.titles);
      expect(actual.text).toBe(reference.text);
      expect(actual.starts).toEqual(
        [...new Set(actual.starts)].sort((a, b) => a - b),
      );
      expect(actual.starts.every((start) => start < pieces.length)).toBe(true);
      if (reference.titles.length > 0 && !stream.includes(0x1b)) {
        expect(actual.starts).toEqual(pieces.map((_, index) => index));
      }
      streams += 1;
      chunks += pieces.length;
      titlesChecked += reference.titles.length;
    }
    expect(streams).toBe(400);
    expect(chunks).toBeGreaterThan(1000);
    expect(titlesChecked).toBeGreaterThan(100);
  });
});
