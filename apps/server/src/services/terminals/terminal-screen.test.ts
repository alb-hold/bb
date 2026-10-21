import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { terminalScreenQuerySchema } from "@bb/server-contract";
import { renderTerminalScreen } from "./terminal-screen.js";
import { Terminal } from "@xterm/headless";
import { Unicode11Addon } from "@xterm/addon-unicode11";

function output(data: string | Buffer, truncated = false) {
  return {
    chunks: [{ seq: 0, dataBase64: Buffer.from(data).toString("base64") }],
    nextSeq: 1,
    truncated,
    status: "exited" as const,
    exitCode: 0,
    closeReason: null,
  };
}

async function replay(cols: number, rows: number, data: string) {
  const terminal = new Terminal({
    allowProposedApi: true,
    cols,
    rows,
    scrollback: 0,
  });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  await new Promise<void>((resolve) => terminal.write(data, resolve));
  const buffer = terminal.buffer.active;
  const screen = {
    rows: Array.from(
      { length: rows },
      (_, row) =>
        buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "",
    ),
    cursor: { col: buffer.cursorX, row: buffer.cursorY },
  };
  terminal.dispose();
  return screen;
}

async function replayWithSentinel(cols: number, rows: number, data: string) {
  const terminal = new Terminal({
    allowProposedApi: true,
    cols,
    rows,
    scrollback: 0,
  });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  const line = "░".repeat(cols);
  const sentinel = `${Array.from(
    { length: rows },
    (_, row) => `\u001b[${row + 1};1H${line}`,
  ).join("")}\u001b[${rows};1H`;
  await new Promise<void>((resolve) =>
    terminal.write(sentinel, () => resolve()),
  );
  await new Promise<void>((resolve) =>
    terminal.write("\u001b[?1049h", () => resolve()),
  );
  await new Promise<void>((resolve) => terminal.write(sentinel, resolve));
  await new Promise<void>((resolve) =>
    terminal.write("\u001b[?1049l", () => resolve()),
  );
  await new Promise<void>((resolve) => terminal.write(data, resolve));
  const buffer = terminal.buffer.active;
  const screen = {
    rows: Array.from(
      { length: rows },
      (_, row) =>
        buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "",
    ),
    cursor: { col: buffer.cursorX, row: buffer.cursorY },
  };
  terminal.dispose();
  return screen;
}

describe("renderTerminalScreen", () => {
  it("renders ANSI colors as plain text", async () => {
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output("\u001b[31mred\u001b[0m\n"),
    });
    expect(screen.rows[0]).toBe("red");
    expect(screen.complete).toBe(true);
  });

  it("applies cursor movement and line clearing", async () => {
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output("hello\u001b[1;1HX\u001b[2;1H\u001b[2K"),
    });
    expect(screen.rows).toEqual(["Xello", ""]);
    expect(screen.cursor).toEqual({ col: 0, row: 1 });
  });

  it("keeps wide characters in the terminal grid", async () => {
    const screen = await renderTerminalScreen({
      cols: 3,
      rows: 2,
      lines: undefined,
      output: output("a界b"),
    });
    expect(screen.rows).toEqual(["a界", "b"]);
  });

  it("skips a partial CSI at the retained tail start and keeps later updates", async () => {
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output("[6;1Hpartial row\u001b[1;1Hclean", true),
    });
    expect(screen.rows[0]).toBe("cleanal row");
    expect(screen.truncated).toBe(true);
    expect(screen.complete).toBe(false);
  });

  it("skips only the partial UTF-8 sequence at the retained tail start", async () => {
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output(
        Buffer.concat([Buffer.from([0x82, 0xac]), Buffer.from("€ok")]),
        true,
      ),
    });
    expect(screen.rows[0]).toBe("€ok");
  });

  it("renders a truncated tail without a line feed", async () => {
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output("visible cells", true),
    });
    expect(screen.rows[0]).toBe("visible cells");
    expect(screen.complete).toBe(false);
  });

  it("reports an incomplete screen after the initial redraw falls out of retention", async () => {
    const stream = execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../../../test/fixtures/terminal-screen-stress.mjs",
            import.meta.url,
          ),
        ),
      ],
      { encoding: "utf8" },
    );
    expect(Buffer.byteLength(stream)).toBeGreaterThan(128 * 1024);
    const screen = await renderTerminalScreen({
      cols: 80,
      rows: 24,
      lines: undefined,
      output: output(stream.slice(-64 * 1024), true),
    });
    expect(screen.rows[0]).not.toContain("ROW00");
    expect(screen.complete).toBe(false);
  });

  it("renders a truncated linear tail but keeps completeness false without mode proof", async () => {
    const stream = Array.from(
      { length: 10_000 },
      (_, index) => `line ${String(index).padStart(5, "0")}\r\n`,
    ).join("");
    expect(Buffer.byteLength(stream)).toBeGreaterThan(64 * 1024);
    const screenArgs = { cols: 40, rows: 4, lines: undefined };
    const fullScreen = await renderTerminalScreen({
      ...screenArgs,
      output: output(stream),
    });
    const retainedScreen = await renderTerminalScreen({
      ...screenArgs,
      output: output(stream.slice(-64 * 1024), true),
    });
    expect(retainedScreen.rows).toEqual(fullScreen.rows);
    expect(retainedScreen.complete).toBe(false);
  });

  it("renders truncated top-style rows but keeps completeness false without mode proof", async () => {
    const stream = execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../../../test/fixtures/terminal-screen-top-redraw.mjs",
            import.meta.url,
          ),
        ),
      ],
      { encoding: "utf8" },
    );
    expect(Buffer.byteLength(stream)).toBeGreaterThan(64 * 1024);
    const screenArgs = { cols: 80, rows: 24, lines: undefined };
    const fullScreen = await renderTerminalScreen({
      ...screenArgs,
      output: output(stream),
    });
    const retainedScreen = await renderTerminalScreen({
      ...screenArgs,
      output: output(stream.slice(-64 * 1024), true),
    });
    expect(retainedScreen.rows).toEqual(fullScreen.rows);
    expect(retainedScreen.cursor).toEqual(fullScreen.cursor);
    expect(retainedScreen.complete).toBe(false);
  });

  it("keeps top-like rows after the retained tail cuts through a row update", async () => {
    const stream =
      "header\r\n" +
      "\u001b[2;1H" +
      "x".repeat(65_500) +
      "\u001b[3;1Hrow three\u001b[K";
    const screen = await renderTerminalScreen({
      cols: 80,
      rows: 4,
      lines: undefined,
      output: output(stream.slice(-64 * 1024), true),
    });
    expect(screen.rows[2]).toContain("row three");
    expect(screen.complete).toBe(false);
  });

  it("rejects a mode-dependent redraw that fooled the blank and sentinel starts", async () => {
    const prefix = `\u001b[2;4r\u001b[?6h\u001b[?7l\u001b[4h\u001b(0${" ".repeat(65_550)}\n`;
    const redraw = `\u001b[1;1H\u001b[2J${Array.from(
      { length: 5 },
      (_, row) => `\u001b[${row + 1};1H${String(row).repeat(10)}\u001b[K`,
    ).join("")}`;
    const tail = `${" ".repeat(65_550)}\n${redraw}`;
    const blank = await replay(10, 5, tail);
    const sentinel = await replayWithSentinel(10, 5, tail);
    const actual = await replay(10, 5, `${prefix}${redraw}`);
    expect(blank).toEqual(sentinel);
    expect(actual.rows).not.toEqual(blank.rows);
    const screen = await renderTerminalScreen({
      cols: 10,
      rows: 5,
      lines: undefined,
      output: output(tail, true),
    });
    expect(screen.complete).toBe(false);
  });

  it("recognizes truncated output that reestablishes terminal modes", async () => {
    const stream = "\u001bc\u001b[31mred\u001b[0m\r\n".repeat(6_000);
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output(stream.slice(-64 * 1024), true),
    });
    expect(screen.complete).toBe(true);
  });

  it("keeps completeness false when scrolling depends on inherited modes", async () => {
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output("partial\nline one\nline two\n\u001b[1;1Hupdate", true),
    });
    expect(screen.complete).toBe(false);
  });

  it("skips mode probes when blank and sentinel starts already differ", async () => {
    const writeSpy = vi.spyOn(Terminal.prototype, "write");
    try {
      const screen = await renderTerminalScreen({
        cols: 20,
        rows: 2,
        lines: undefined,
        output: output("partial\n", true),
      });
      expect(writeSpy).toHaveBeenCalledTimes(6);
      expect(screen.complete).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("keeps a truncated alternate-screen switch incomplete when earlier rows are uncertain", async () => {
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output("partial\nline one\nline two\n\u001b[?1049h", true),
    });
    expect(screen.complete).toBe(false);
  });

  it("recognizes a fully drawn alternate screen after truncation", async () => {
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output(
        "partial\n\u001b[?1049h\u001b[r\u001b[?6l\u001b[?7h\u001b[4l\u001b(B\u001b[Hfirst row\u001b[K\r\nsecond row\u001b[K",
        true,
      ),
    });
    expect(screen.rows).toEqual(["first row", "second row"]);
    expect(screen.complete).toBe(true);
  });

  it("keeps a partial alternate-screen update incomplete after truncation", async () => {
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output("partial\n\u001b[?1049hX", true),
    });
    expect(screen.complete).toBe(false);
  });

  it("keeps a partial alternate-screen update incomplete when an earlier cell survives", async () => {
    const retainedTail = "partial\n\u001b[?1049hX";
    const full = await replay(20, 2, `\u001b[?1049h\u001b[2;10Hold${retainedTail}`);
    const replayed = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output(retainedTail, true),
    });
    expect(full.rows).not.toEqual(replayed.rows);
    expect(replayed.complete).toBe(false);
  });

  it("keeps a partial scroll-region update incomplete", async () => {
    const firstRow = " ".repeat(20);
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output(
        `partial\n\u001b[1;2r\u001b[1;1H${firstRow}\u001b[2;1HX`,
        true,
      ),
    });
    expect(screen.complete).toBe(false);
  });

  it("keeps a partial scroll-region update incomplete when an earlier cell survives", async () => {
    const retainedTail = `partial\n\u001b[1;2r\u001b[1;1H${" ".repeat(20)}\u001b[2;1HX`;
    const full = await replay(20, 2, `\u001b[2;5HOLD\u001b[1;1H${retainedTail}`);
    const replayed = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output(retainedTail, true),
    });
    expect(full.rows).not.toEqual(replayed.rows);
    expect(replayed.complete).toBe(false);
  });

  it("caps requested scrollback rows at 500", async () => {
    expect(terminalScreenQuerySchema.safeParse({ lines: 500 }).success).toBe(
      true,
    );
    expect(terminalScreenQuerySchema.safeParse({ lines: 501 }).success).toBe(
      false,
    );
    const screen = await renderTerminalScreen({
      cols: 8,
      rows: 2,
      lines: 700,
      output: output(
        Array.from({ length: 600 }, (_, index) => `${index}\n`).join(""),
      ),
    });
    expect(screen.rows).toHaveLength(500);
  });
});
