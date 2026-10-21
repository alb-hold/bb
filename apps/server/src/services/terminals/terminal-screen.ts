import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import type {
  TerminalOutputResponse,
  TerminalScreenResponse,
} from "@bb/server-contract";

const require = createRequire(import.meta.url);
const { Unicode11Addon } =
  require("@xterm/addon-unicode11") as typeof import("@xterm/addon-unicode11");
const { Terminal } =
  require("@xterm/headless") as typeof import("@xterm/headless");

export const TERMINAL_SCREEN_MAX_LINES = 500;
export const TERMINAL_SCREEN_REPLAY_BYTES = 64 * 1024;

type HeadlessTerminal = InstanceType<typeof Terminal>;

function safeTailStart(data: Buffer) {
  const first = data[0];
  if (first === undefined) return 0;
  if ((first & 0xc0) === 0x80) {
    let index = 0;
    while (index < data.length && (data[index]! & 0xc0) === 0x80) index += 1;
    return index;
  }
  if (first !== 0x5b) return 0;
  for (let index = 1; index < data.length; index += 1) {
    const byte = data[index]!;
    if (byte >= 0x40 && byte <= 0x7e) return index + 1;
    if (byte < 0x20 || byte > 0x3f) return 0;
  }
  return 0;
}

function createTerminal(cols: number, rows: number): HeadlessTerminal {
  const terminal = new Terminal({
    allowProposedApi: true,
    cols,
    rows,
    scrollback: TERMINAL_SCREEN_MAX_LINES,
  });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  return terminal;
}

function writeTerminal(terminal: HeadlessTerminal, data: string | Buffer) {
  return new Promise<void>((resolve) => {
    terminal.write(data, resolve);
  });
}

function readVisibleScreen(terminal: HeadlessTerminal) {
  const buffer = terminal.buffer.active;
  return {
    rows: Array.from(
      { length: terminal.rows },
      (_, row) =>
        buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "",
    ),
    cursor: { col: buffer.cursorX, row: buffer.cursorY },
  };
}

function sameVisibleScreen(left: HeadlessTerminal, right: HeadlessTerminal) {
  const leftScreen = readVisibleScreen(left);
  const rightScreen = readVisibleScreen(right);
  return (
    leftScreen.cursor.col === rightScreen.cursor.col &&
    leftScreen.cursor.row === rightScreen.cursor.row &&
    leftScreen.rows.every((row, index) => row === rightScreen.rows[index])
  );
}

function sentinelGrid(cols: number, rows: number) {
  const line = "░".repeat(cols);
  return `${Array.from(
    { length: rows },
    (_, row) => `\u001b[${row + 1};1H${line}`,
  ).join("")}\u001b[${rows};1H`;
}

async function replayIsComplete(
  data: Buffer,
  cols: number,
  rows: number,
  blankTerminal: HeadlessTerminal,
) {
  const sentinelTerminal = createTerminal(cols, rows);
  const modeSetups = [
    `\u001b[2;${Math.max(2, rows - 1)}r\u001b[?6h`,
    "\u001b[?7l",
    "\u001b[4h",
    "\u001b(0",
  ];
  try {
    const sentinel = sentinelGrid(cols, rows);
    await writeTerminal(sentinelTerminal, sentinel);
    await writeTerminal(sentinelTerminal, "\u001b[?1049h");
    await writeTerminal(sentinelTerminal, sentinel);
    await writeTerminal(sentinelTerminal, "\u001b[?1049l");
    await writeTerminal(sentinelTerminal, data);
    if (!sameVisibleScreen(blankTerminal, sentinelTerminal)) return false;
    for (const modeSetup of modeSetups) {
      const perturbedTerminal = createTerminal(cols, rows);
      try {
        await writeTerminal(perturbedTerminal, modeSetup);
        await writeTerminal(perturbedTerminal, data);
        if (!sameVisibleScreen(blankTerminal, perturbedTerminal)) return false;
      } finally {
        perturbedTerminal.dispose();
      }
    }
    return true;
  } finally {
    sentinelTerminal.dispose();
  }
}

export async function renderTerminalScreen(args: {
  cols: number;
  lines: number | undefined;
  output: TerminalOutputResponse;
  rows: number;
}): Promise<TerminalScreenResponse> {
  const terminal = createTerminal(args.cols, args.rows);
  try {
    let data = Buffer.concat(
      args.output.chunks.map((chunk) =>
        Buffer.from(chunk.dataBase64, "base64"),
      ),
    );
    if (args.output.truncated) {
      data = data.subarray(safeTailStart(data));
    }
    await writeTerminal(terminal, data);
    const complete =
      !args.output.truncated ||
      (await replayIsComplete(data, args.cols, args.rows, terminal));
    const buffer = terminal.buffer.active;
    let end = buffer.baseY + terminal.rows;
    if (args.lines !== undefined) {
      while (
        end > 0 &&
        buffer.getLine(end - 1)?.translateToString(true) === ""
      ) {
        end -= 1;
      }
    }
    const requestedLines = Math.min(
      args.lines ?? args.rows,
      TERMINAL_SCREEN_MAX_LINES,
    );
    const start = Math.max(0, end - requestedLines);
    const rows: string[] = [];
    for (let index = start; index < end; index += 1) {
      const line = buffer.getLine(index);
      rows.push(line?.translateToString(true) ?? "");
    }
    return {
      rows,
      cursor: { col: buffer.cursorX, row: buffer.cursorY },
      cols: args.cols,
      gridRows: args.rows,
      truncated: args.output.truncated,
      complete,
    };
  } finally {
    terminal.dispose();
  }
}
