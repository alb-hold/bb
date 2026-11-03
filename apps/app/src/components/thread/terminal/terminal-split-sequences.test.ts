// @vitest-environment jsdom

import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { handleTerminalServerMessage } from "./ThreadTerminalView";
import { createTerminalOutputBoundaries } from "./terminal-output-boundaries";
import { createTerminalOutputPipeline } from "./terminal-output-pipeline";
import { registerTerminalOutputBoundaryHandler } from "./terminal-viewport";

const encoder = new TextEncoder();
const text = (value: string) => encoder.encode(value);

interface Observed {
  rows: string;
  sync: boolean;
  underlinedCells: number;
  titles: string[];
  linkText: string[];
}

function newTerminal() {
  const terminal = new Terminal({
    cols: 60,
    rows: 12,
    allowProposedApi: true,
  });
  const titles: string[] = [];
  terminal.onTitleChange((title) => titles.push(title));
  return { terminal, titles };
}

function observe(terminal: Terminal, titles: string[]): Observed {
  const lines: string[] = [];
  let underlined = 0;
  for (let y = 0; y < terminal.buffer.active.length; y += 1) {
    const line = terminal.buffer.active.getLine(y);
    lines.push(line?.translateToString(true) ?? "");
    for (let x = 0; x < terminal.cols; x += 1) {
      const cell = line?.getCell(x);
      if (cell !== undefined && cell.getChars() !== "" && cell.isUnderline()) {
        underlined += 1;
      }
    }
  }
  return {
    rows: lines.join("\n"),
    sync: terminal.modes.synchronizedOutputMode,
    underlinedCells: underlined,
    titles,
    linkText: [],
  };
}

async function rawWrites(chunks: Uint8Array[]): Promise<Observed> {
  const { terminal, titles } = newTerminal();
  for (const chunk of chunks) {
    await new Promise<void>((resolve) => terminal.write(chunk, resolve));
  }
  return observe(terminal, titles);
}

async function fullPipeline(chunks: Uint8Array[]): Promise<Observed> {
  const { terminal, titles } = newTerminal();
  const token = "split-token";
  const outputBoundaries = createTerminalOutputBoundaries(token);
  registerTerminalOutputBoundaryHandler(
    terminal.parser,
    token,
    () => undefined,
  );
  const pipeline = createTerminalOutputPipeline(terminal);
  const parsed: Array<Promise<void>> = [];
  for (const [sequence, chunk] of chunks.entries()) {
    parsed.push(
      new Promise<void>((resolve) => {
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
          pipeline,
          outputBoundaries,
        });
      }),
    );
  }
  await Promise.all(parsed);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return observe(terminal, titles);
}

const SAMPLES: Array<[string, string]> = [
  [
    "synchronized output frame (?2026h … ?2026l)",
    "\x1b[?2026h\x1b[2J\x1b[Hframe one text\r\nsecond row\x1b[?2026l\x1b[?2026hframe two\x1b[?2026l",
  ],
  [
    "dashed underline SGR 4:5 then SGR 0",
    "\x1b[4:5mdashed\x1b[0m plain\r\n\x1b[4mplain underline\x1b[24m after\r\n\x1b[58;2;255;0;0;4:3mcurly\x1b[0m end\r\n",
  ],
  [
    "CSI with parameters and intermediates",
    "\x1b[1;38;2;177;185;249;48;5;17mcolored\x1b[0m\x1b[3;10Hmoved\x1b[2K\x1b[?25l\x1b[?25hline\r\n",
  ],
  [
    "OSC 8 hyperlink with UTF-8 and ST",
    "\x1b]8;id=1;https://example.test/“x”\x1b\\link “text” é✓\x1b]8;;\x1b\\ tail\r\n",
  ],
  [
    "OSC 0 title with curly quote and BEL",
    "\x1b]0;✳ title “q”\x07body after title\r\n",
  ],
];

function everySplit(stream: Uint8Array): Uint8Array[][] {
  const splits: Uint8Array[][] = [[stream]];
  for (let offset = 1; offset < stream.length; offset += 1) {
    splits.push([stream.subarray(0, offset), stream.subarray(offset)]);
  }
  return splits;
}

describe.each([
  ["raw xterm", rawWrites],
  [
    "bb output pipeline (boundaries, grid scanner, handleTerminalServerMessage)",
    fullPipeline,
  ],
])("split escape sequences through %s", (_layer, render) => {
  it.each(SAMPLES)(
    "%s renders identically at every byte split",
    async (_name, source) => {
      const stream = text(source);
      const reference = await rawWrites([stream]);
      expect(reference.rows).not.toMatch(/026l|2026h|\[\?/u);
      expect(reference.sync).toBe(false);
      for (const chunks of everySplit(stream)) {
        const actual = await render(chunks);
        expect({ first: chunks[0]?.length, ...actual }).toEqual({
          first: chunks[0]?.length,
          ...reference,
        });
      }
    },
  );

  it("renders a three-way split of a synchronized frame identically", async () => {
    const stream = text(SAMPLES[0]?.[1] ?? "");
    const reference = await rawWrites([stream]);
    for (let a = 1; a < stream.length - 1; a += 3) {
      for (let b = a + 1; b < stream.length; b += 5) {
        const actual = await render([
          stream.subarray(0, a),
          stream.subarray(a, b),
          stream.subarray(b),
        ]);
        expect({ a, b, ...actual }).toEqual({ a, b, ...reference });
      }
    }
  });
});
