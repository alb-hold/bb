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
  it("only calls a retained RIS complete when every retained rendering matches the full stream", async () => {
    const ris = "\u001bc";
    const cases = [
      { name: "RIS at the tail start", prefix: "prefix", tail: `${ris}#` },
      { name: "RIS in the tail middle", prefix: "prefix", tail: `before${ris}#` },
      { name: "RIS at the tail end", prefix: "prefix", tail: `#${ris}` },
      { name: "RIS split at the retention boundary", prefix: "prefix\u001b", tail: `c#` },
      ...[
        ["OSC", "\u001b]0;unfinished"],
        ["DCS", "\u001bP1;1qunfinished"],
        ["APC", "\u001b_unfinished"],
        ["PM", "\u001b^unfinished"],
        ["SOS", "\u001bXunfinished"],
        ["partial CSI", "\u001b[31"],
      ].map(([name, prefix]) => ({
        name: `RIS after an open ${name}`,
        prefix,
        tail: `${ris}#`,
      })),
      {
        name: "RIS after inherited modes and a restored saved cursor",
        prefix:
          "\u001b(0\u001b)0\u001b*0\u001b+0\u001b[2;4r\u001b[?6h\u001b[3g\u001b[1;5H\u001bH\u001b[4h\u001b[?5h\u001b[?1049h\u001b[2;3H\u001b7",
        tail: `${ris}\u001b8#`,
      },
    ] as const;

    for (const testCase of cases) {
      const fullStream = `${testCase.prefix}${testCase.tail}`;
      const full = await renderTerminalScreen({
        cols: 20,
        rows: 4,
        lines: undefined,
        output: output(fullStream),
      });
      const retained = await renderTerminalScreen({
        cols: 20,
        rows: 4,
        lines: undefined,
        output: output(testCase.tail, true),
      });
      if (testCase.name === "RIS split at the retention boundary") {
        expect(retained.complete, testCase.name).toBe(false);
      } else {
        expect(retained.complete, testCase.name).toBe(true);
      }
      if (retained.complete) {
        expect(
          { rows: retained.rows, cursor: retained.cursor },
          testCase.name,
        ).toEqual({ rows: full.rows, cursor: full.cursor });
      }
    }
  });

  it("uses a retained full reset as proof that earlier modes cannot affect the screen", async () => {
    const data = `${"x".repeat(65_500)}\u001bc\u001b[H#`;
    const yieldSpy = vi.spyOn(globalThis, "setImmediate");
    try {
      const screen = await renderTerminalScreen({
        cols: 80,
        rows: 24,
        lines: undefined,
        output: output(data, true),
      });
      expect(screen.complete).toBe(true);
      expect(screen.rows[0]).toBe("#");
      expect(yieldSpy.mock.calls.length).toBeLessThan(80);
    } finally {
      yieldSpy.mockRestore();
    }
  });

  it("yields between chunks while proving a truncated 64 KiB screen", async () => {
    const data = "\u001b[H#".repeat(16_384);
    expect(Buffer.byteLength(data)).toBe(64 * 1024);
    const yieldSpy = vi.spyOn(globalThis, "setImmediate");
    try {
      const screen = await renderTerminalScreen({
        cols: 80,
        rows: 24,
        lines: undefined,
        output: output(data, true),
      });
      expect(screen.complete).toBe(false);
      expect(yieldSpy.mock.calls.length).toBeGreaterThan(6);
    } finally {
      yieldSpy.mockRestore();
    }
  });

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

  it.each([
    ["G0", "\u001b(A\u000f"],
    ["G1 with SO", "\u001b)A\u000e"],
    ["G2 with LS2", "\u001b*A\u001bn"],
    ["G3 with LS3", "\u001b+A\u001bo"],
  ])("detects a retained tail that depends on the %s character set", async (_, prefix) => {
    const tail = "\u001b[2J\u001b[H#";
    const actual = await replay(20, 2, `${prefix}${tail}`);
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output(tail, true),
    });
    expect(actual.rows[0]).toContain("£");
    expect(screen.rows[0]).toBe("#");
    expect(screen.complete).toBe(false);
  });

  it.each(
    [
      ["DEC Special Graphics", "0", "q", "─"],
      ["UK", "A", "#", "£"],
      ["Dutch", "4", "#", "£"],
      ["Finnish", "C", "[", "Ä"],
      ["French", "R", "#", "£"],
      ["French Canadian", "Q", "@", "à"],
      ["German", "K", "@", "§"],
      ["Italian", "Y", "#", "£"],
      ["Norwegian/Danish", "E", "@", "Ä"],
      ["Spanish", "Z", "#", "£"],
      ["Swedish", "H", "@", "É"],
      ["Swiss", "=", "#", "ù"],
    ].flatMap(([name, charset, input, expected]) =>
      [
        ["G0 with SI", "(", "\u000f"],
        ["G1 with SO", ")", "\u000e"],
        ["G1 with ESC ~", ")", "\u001b~"],
        ["G2 with ESC n", "*", "\u001bn"],
        ["G2 with ESC }", "*", "\u001b}"],
        ["G3 with ESC o", "+", "\u001bo"],
        ["G3 with ESC |", "+", "\u001b|"],
      ].map(([slotName, slot, shift]) => [
        name,
        charset,
        input,
        expected,
        slotName,
        slot,
        shift,
      ]),
    ),
  )(
    "detects retained output that depends on %s in %s",
    async (_, charset, input, expected, slotName, slot, shift) => {
      const prefix = `\u001b${slot}${charset}${shift}`;
      const tail = `\u001b[2J\u001b[H${input}`;
      const actual = await replay(20, 2, `${prefix}${tail}`);
      const screen = await renderTerminalScreen({
        cols: 20,
        rows: 2,
        lines: undefined,
        output: output(tail, true),
      });
      expect(actual.rows[0]).toBe(expected);
      expect(screen.rows[0]).toBe(input);
      expect(screen.complete, `${slotName} ${charset}`).toBe(false);
    },
  );

  it("keeps the Hermes G1 UK designation and SO case incomplete", async () => {
    const prefix = "\u001b)A\u000e";
    const tail = "\u001b\\\u001b[?7h\u001b[4l\u001b(B\u000e\u001b[2J\u001b[H#";
    const actual = await replay(20, 2, `${prefix}${tail}`);
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output(tail, true),
    });
    expect(actual.rows[0]).toContain("£");
    expect(screen.rows[0]).toBe("#");
    expect(screen.complete).toBe(false);
  });

  it("keeps the Hermes G1 DEC graphics retained-tail case incomplete", async () => {
    const prefix = "\u001b)0";
    const tail = "\u001b\\\u001b~\u001b[?7h\u001b[4l\u001b[2J\u001b[Hq";
    const actual = await replay(20, 2, `${prefix}${tail}`);
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output(tail, true),
    });
    expect(actual.rows[0]).toBe("─");
    expect(screen.rows[0]).toBe("q");
    expect(screen.complete).toBe(false);
  });

  it("detects a retained tail that restores a saved cursor", async () => {
    const prefix = "\u001b[2;5H\u001b7";
    const tail =
      "\u001b\\\u001b(B\u001b)B\u001b*B\u001b+B\u000f\u001b[?6l\u001b[?7h\u001b[?45l\u001b[20l\u001b[4l\u001b[r\u001b[2J\u001b[H#\u001b8X";
    const actual = await replay(20, 2, `${prefix}${tail}`);
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output(tail, true),
    });
    expect(actual.rows).not.toEqual(screen.rows);
    expect(actual.rows[1]).toContain("X");
    expect(screen.complete).toBe(false);
  });

  it("detects a retained tail that restores a CSI-saved cursor", async () => {
    const prefix = "\u001b[2;5H\u001b[s";
    const tail = "\u001b[2J\u001b[H#\u001b[uX";
    const actual = await replay(20, 2, `${prefix}${tail}`);
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output(tail, true),
    });
    expect(actual.rows).not.toEqual(screen.rows);
    expect(actual.rows[1]).toContain("X");
    expect(screen.complete).toBe(false);
  });

  it("detects retained output that depends on prior tab stops", async () => {
    const prefix = "\u001b[3g\u001b[1;5H\u001bH\u001b[1;1H";
    const tail = "\u001b\\\u001b[2J\u001b[HA\tB";
    const actual = await replay(20, 2, `${prefix}${tail}`);
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output(tail, true),
    });
    expect(actual.rows[0]).toBe("A   B");
    expect(screen.rows[0]).toBe("A       B");
    expect(screen.complete).toBe(false);
  });

  it("detects line-feed mode changing the retained tail position", async () => {
    const tail = "\u001b[2J\u001b[1;2HA\nB";
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output(tail, true),
    });
    const lineFeedMode = await replay(20, 2, `\u001b[20h${tail}`);
    expect(lineFeedMode.rows[1]).toBe("B");
    expect(screen.rows[1]).toBe("  B");
    expect(screen.complete).toBe(false);
  });

  it("detects reverse-wraparound changing retained cursor movement", async () => {
    const tail = `\u001b[2J\u001b[H${"A".repeat(20)}B\b\bX`;
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output(tail, true),
    });
    const reverseWrap = await replay(20, 2, `\u001b[?45h${tail}`);
    expect(reverseWrap.rows[0]).toContain("X");
    expect(screen.rows[1]).toContain("X");
    expect(screen.complete).toBe(false);
  });

  it("detects retained output whose cells depend on insert mode", async () => {
    const tail = "\u001b[2J\u001b[HABC\u001b[1;2HX";
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output(tail, true),
    });
    const insertMode = await replay(20, 2, `\u001b[4h${tail}`);
    expect(insertMode.rows[0]).toBe("AXBC");
    expect(screen.rows[0]).toBe("AXC");
    expect(screen.complete).toBe(false);
  });

  it("detects retained selective erase that depends on protected cells", async () => {
    const prefix = '\u001b[1"qP';
    const tail = "\u001b[?2K";
    const actual = await replay(20, 2, `${prefix}${tail}`);
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output(tail, true),
    });
    expect(actual.rows[0]).toBe("P");
    expect(screen.rows[0]).toBe("");
    expect(screen.complete).toBe(false);
  });

  it.each([
    ["CSI", "\u001b[", "2J#"],
    ["OSC", "\u001b]0;", "discard\u001b\\#"],
    ["DCS", "\u001bP1;1q", "discard\u001b\\#"],
    ["SOS", "\u001bX", "discard\u001b\\#"],
    ["PM", "\u001b^", "discard\u001b\\#"],
    ["APC", "\u001b_", "discard\u001b\\#"],
    ["ESC", "\u001b", "8"],
  ])("detects a retained tail whose %s parser state predates the cut", async (_, prefix, tail) => {
    const actual = await replay(20, 2, `${prefix}${tail}`);
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output(tail, true),
    });
    expect(actual.rows).not.toEqual(screen.rows);
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
  }, 30_000);

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
      expect(writeSpy).toHaveBeenCalledTimes(3);
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
        "partial\n\u001b[?1049h\u001b[r\u001b[?6l\u001b[?7h\u001b[4l\u001b(B\u000f\u001b[Hfirst row\u001b[K\r\nsecond row\u001b[K",
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
