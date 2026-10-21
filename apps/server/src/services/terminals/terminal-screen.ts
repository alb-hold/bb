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

export type TerminalScreenMirrorSnapshot = {
  baseY: number;
  bufferRows: string[];
  cols: number;
  cursor: { col: number; row: number };
  gridRows: number;
};

export function renderTerminalMirrorSnapshot(args: {
  lines: number | undefined;
  snapshot: TerminalScreenMirrorSnapshot;
  truncated: boolean;
}): TerminalScreenResponse {
  const { snapshot } = args;
  let end = snapshot.baseY + snapshot.gridRows;
  if (args.lines !== undefined) {
    while (
      end > 0 &&
      snapshot.bufferRows[end - 1] === ""
    ) {
      end -= 1;
    }
  }
  const requestedLines = Math.min(
    args.lines ?? snapshot.gridRows,
    TERMINAL_SCREEN_MAX_LINES,
  );
  const start =
    args.lines === undefined
      ? snapshot.baseY
      : Math.max(0, end - requestedLines);
  const rows = snapshot.bufferRows.slice(start, end);
  return {
    rows,
    cursor: snapshot.cursor,
    cols: snapshot.cols,
    gridRows: snapshot.gridRows,
    truncated: args.truncated,
    complete: true,
  };
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

async function replayWithPerturbedModes(
  data: Buffer,
  cols: number,
  rows: number,
  modeSetup: string,
) {
  const terminal = createTerminal(cols, rows);
  try {
    await writeTerminal(terminal, modeSetup);
    await writeTerminal(terminal, data);
    return terminal;
  } catch (error) {
    terminal.dispose();
    throw error;
  }
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
  const perturbedTerminals: HeadlessTerminal[] = [];
  try {
    const sentinel = sentinelGrid(cols, rows);
    await writeTerminal(sentinelTerminal, sentinel);
    await writeTerminal(sentinelTerminal, "\u001b[?1049h");
    await writeTerminal(sentinelTerminal, sentinel);
    await writeTerminal(sentinelTerminal, "\u001b[?1049l");
    await writeTerminal(sentinelTerminal, data);
    for (const modeSetup of modeSetups) {
      perturbedTerminals.push(
        await replayWithPerturbedModes(data, cols, rows, modeSetup),
      );
    }
    return [blankTerminal, sentinelTerminal, ...perturbedTerminals].every(
      (terminal) => sameVisibleScreen(blankTerminal, terminal),
    );
  } finally {
    sentinelTerminal.dispose();
    for (const terminal of perturbedTerminals) terminal.dispose();
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
      const firstLineBreak = data.indexOf(0x0a);
      data =
        firstLineBreak < 0
          ? Buffer.alloc(0)
          : data.subarray(firstLineBreak + 1);
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
