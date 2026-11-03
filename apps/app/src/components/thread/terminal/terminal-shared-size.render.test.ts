import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

const PTY_COLS = 44;
const PTY_ROWS = 20;

function tuiFrame(cols: number, rows: number): string {
  const rule = "─".repeat(cols - 2);
  const body = "status: release train, 3 of 12 steps";
  return [
    "\x1b[2J\x1b[3J\x1b[H",
    `╭${rule}╮`,
    `\x1b[2;1H│${" ".repeat(cols - 2)}│`,
    `\x1b[3;1H${body}`,
    `\x1b[${rows - 1};1H> `,
    `\x1b[${rows};${cols - 6}Hctx 79K`,
    `\x1b[${rows - 1};3H`,
  ].join("");
}

async function render(cols: number, rows: number, data: string) {
  const terminal = new Terminal({
    allowProposedApi: true,
    cols,
    rows,
    convertEol: true,
  });
  await new Promise<void>((resolve) => terminal.write(data, resolve));
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < PTY_ROWS; row += 1) {
    lines.push(
      buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
    );
  }
  const cursor = { x: buffer.cursorX, y: buffer.cursorY };
  terminal.dispose();
  return { cursor, lines };
}

describe("drawing a shared PTY in a grid at least as large", () => {
  it("renders output sized for the PTY identically in a wider, taller grid", async () => {
    const frame = tuiFrame(PTY_COLS, PTY_ROWS);
    const exact = await render(PTY_COLS, PTY_ROWS, frame);
    const wider = await render(160, 48, frame);

    expect(wider.lines).toEqual(exact.lines);
    expect(wider.cursor).toEqual(exact.cursor);
  });

  it("scrambles the same output in a grid narrower than the PTY", async () => {
    const frame = tuiFrame(PTY_COLS, PTY_ROWS);
    const exact = await render(PTY_COLS, PTY_ROWS, frame);
    const narrower = await render(30, PTY_ROWS, frame);

    expect(narrower.lines).not.toEqual(exact.lines);
  });
});
