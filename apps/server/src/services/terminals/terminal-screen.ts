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
const TERMINAL_SCREEN_WRITE_CHUNK_BYTES = 2 * 1024;
const TERMINAL_SCREEN_YIELD_BYTES = 8 * 1024;

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

function yieldToEventLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

async function writeTerminal(
  terminal: HeadlessTerminal,
  data: string | Buffer,
) {
  if (
    typeof data === "string" ||
    data.length <= TERMINAL_SCREEN_WRITE_CHUNK_BYTES
  ) {
    await new Promise<void>((resolve) => terminal.write(data, resolve));
    return;
  }
  let groupStart = 0;
  for (
    let offset = 0;
    offset < data.length;
    offset += TERMINAL_SCREEN_WRITE_CHUNK_BYTES
  ) {
    const end = Math.min(
      offset + TERMINAL_SCREEN_WRITE_CHUNK_BYTES,
      data.length,
    );
    const groupEnd =
      end === data.length || end - groupStart >= TERMINAL_SCREEN_YIELD_BYTES;
    if (groupEnd) {
      await new Promise<void>((resolve) =>
        terminal.write(data.subarray(offset, end), resolve),
      );
    } else {
      terminal.write(data.subarray(offset, end));
    }
    if (groupEnd) {
      groupStart = end;
    }
    if (groupEnd && end < data.length) {
      await yieldToEventLoop();
    }
  }
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
  const dataText = data.toString("latin1");
  const hasAlternateScreenSwitch = [
    "\u001b[?47",
    "\u001b[?1047",
    "\u001b[?1049",
  ].some((mode) => dataText.includes(mode));
  const modeSetups = [
    `\u001b[2;${Math.max(2, rows - 1)}r\u001b[?6h`,
    "\u001b[?7l",
    "\u001b[4h",
    "\u001b(0",
    "\u001b[?45h",
    "\u001b[20h",
  ];
  const charsetFlags = [
    "0",
    "A",
    "4",
    "C",
    "R",
    "Q",
    "K",
    "Y",
    "E",
    "Z",
    "H",
    "=",
  ];
  const charsetSlots = ["(", ")", "*", "+"];
  const charsetSetups = charsetSlots.flatMap((slot) =>
    charsetFlags.map((charset) => {
      const glShift =
        slot === "("
          ? "\u000f"
          : slot === ")"
            ? "\u000e"
            : slot === "*"
              ? "\u001bn"
              : "\u001bo";
      return `\u001b${slot}${charset}${glShift}`;
    }),
  );
  const savedCursorSetup = "\u001b(A\u001b[31m\u001b[2;5H\u001b7";
  const tabStopSetup = "\u001b[3g\u001b[1;5H\u001bH\u001b[1;1H";
  const protectedCellSetup = "\u001b[1\"qP";
  const parserSetups = [
    "\u001b[",
    "\u001b]0;",
    "\u001bP1;1q",
    "\u001bX",
    "\u001b^",
    "\u001b_",
    "\u001b",
  ];
  const screenSentinel = `${sentinelGrid(cols, rows)}\u001b[1;1H`;
  const initialScreens = [screenSentinel];
  if (hasAlternateScreenSwitch) {
    initialScreens.push(`\u001b[?1049h${screenSentinel}`);
  }
  try {
    const sentinel = sentinelGrid(cols, rows);
    await writeTerminal(sentinelTerminal, sentinel);
    if (hasAlternateScreenSwitch) {
      await writeTerminal(sentinelTerminal, "\u001b[?1049h");
      await writeTerminal(sentinelTerminal, sentinel);
      await writeTerminal(sentinelTerminal, "\u001b[?1049l");
    }
    await writeTerminal(sentinelTerminal, data);
    if (!sameVisibleScreen(blankTerminal, sentinelTerminal)) return false;
    for (const initialScreen of initialScreens) {
      await yieldToEventLoop();
      const visibleStateTerminal = createTerminal(cols, rows);
      try {
        await writeTerminal(visibleStateTerminal, initialScreen);
        await writeTerminal(visibleStateTerminal, data);
        if (!sameVisibleScreen(blankTerminal, visibleStateTerminal))
          return false;
      } finally {
        visibleStateTerminal.dispose();
      }
    }
    for (const modeSetup of modeSetups) {
      await yieldToEventLoop();
      const perturbedTerminal = createTerminal(cols, rows);
      try {
        await writeTerminal(perturbedTerminal, modeSetup);
        await writeTerminal(perturbedTerminal, data);
        if (!sameVisibleScreen(blankTerminal, perturbedTerminal)) return false;
      } finally {
        perturbedTerminal.dispose();
      }
    }
    for (const charsetSetup of charsetSetups) {
      await yieldToEventLoop();
      const perturbedTerminal = createTerminal(cols, rows);
      try {
        await writeTerminal(perturbedTerminal, charsetSetup);
        await writeTerminal(perturbedTerminal, data);
        if (!sameVisibleScreen(blankTerminal, perturbedTerminal)) return false;
      } finally {
        perturbedTerminal.dispose();
      }
    }
    for (const stateSetup of [
      savedCursorSetup,
      tabStopSetup,
      protectedCellSetup,
    ]) {
      await yieldToEventLoop();
      const perturbedTerminal = createTerminal(cols, rows);
      try {
        await writeTerminal(perturbedTerminal, stateSetup);
        await writeTerminal(perturbedTerminal, data);
        if (!sameVisibleScreen(blankTerminal, perturbedTerminal)) return false;
      } finally {
        perturbedTerminal.dispose();
      }
    }
    for (const parserSetup of parserSetups) {
      await yieldToEventLoop();
      const perturbedTerminal = createTerminal(cols, rows);
      try {
        await writeTerminal(perturbedTerminal, parserSetup);
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
  let sawFullReset = false;
  const fullResetHandler = args.output.truncated
    ? terminal.parser.registerEscHandler({ final: "c" }, () => {
        sawFullReset = true;
        return false;
      })
    : undefined;
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
      sawFullReset ||
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
    fullResetHandler?.dispose();
    terminal.dispose();
  }
}
