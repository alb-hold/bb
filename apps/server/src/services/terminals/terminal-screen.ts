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

function isLinearTerminalOutput(data: Buffer, rows: number): boolean {
  const text = data.toString("utf8");
  const switchesAlternateScreen = /\x1b\[\?(?:1049|47|1047)[hl]/.test(text);
  const controlsScreenState =
    /\x1b\[[0-?]*[ -/]*[HfdABCDGJKrST]/.test(text);
  const lineFeeds = text.match(/\n/g)?.length ?? 0;
  return !switchesAlternateScreen && !controlsScreenState && lineFeeds >= rows;
}

export async function renderTerminalScreen(args: {
  cols: number;
  lines: number | undefined;
  output: TerminalOutputResponse;
  rows: number;
}): Promise<TerminalScreenResponse> {
  const terminal = new Terminal({
    allowProposedApi: true,
    cols: args.cols,
    rows: args.rows,
    scrollback: TERMINAL_SCREEN_MAX_LINES,
  });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
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
    await new Promise<void>((resolve) => {
      terminal.write(data, resolve);
    });
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
    const complete =
      !args.output.truncated ||
      /\x1b\[2J/.test(data.toString("utf8")) ||
      isLinearTerminalOutput(data, args.rows);
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
