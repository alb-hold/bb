import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { renderTerminalScreen } from "../../src/services/terminals/terminal-screen.js";
import { terminalScreenInputBoxIsEmpty } from "../../src/services/threads/native-terminal-echo.js";
import { composeNativeParentNotice } from "../../src/services/threads/native-parent-notices.js";

describe("composeNativeParentNotice", () => {
  const now = new Date(2026, 9, 29, 4, 5, 6);

  it("frames the text as a notice and ends with a unique clock tail", () => {
    const text = composeNativeParentNotice({
      entries: [{ childThreadIds: ["thr_a"], text: "@thread:thr_a failed." }],
      now,
    });
    expect(text.startsWith("[bb notice]")).toBe(true);
    expect(text).toContain("@thread:thr_a failed.");
    expect(text.endsWith("-- bb, 04:05:06")).toBe(true);
  });

  it("truncates an oversized body well under the native input limit and points at bb thread show", () => {
    const text = composeNativeParentNotice({
      entries: [
        { childThreadIds: ["thr_a"], text: "x".repeat(200_000) },
        { childThreadIds: ["thr_b", "thr_a"], text: "y".repeat(200_000) },
      ],
      now,
    });
    expect(text.length).toBeLessThan(13_500);
    expect(text).toContain("bb thread show <id>` for: thr_a thr_b]");
    expect(text.endsWith("-- bb, 04:05:06")).toBe(true);
  });
});

describe("terminalScreenInputBoxIsEmpty", () => {
  const rule = "─".repeat(40);
  const screen = (...box: string[]) => ["⏺ ok", rule, ...box, rule, "  Sonnet"];

  it("is empty for a bare prompt", () => {
    expect(terminalScreenInputBoxIsEmpty({ rows: screen("❯ ") })).toBe(true);
  });

  it("is empty when only dim placeholder text follows the prompt", () => {
    expect(
      terminalScreenInputBoxIsEmpty({
        rows: screen('❯ Try "fix lint errors"'),
        solidRows: screen("❯"),
      }),
    ).toBe(true);
  });

  it("is occupied by placeholder-looking text it cannot prove is dim", () => {
    expect(
      terminalScreenInputBoxIsEmpty({
        rows: screen('❯ Try "fix lint errors"'),
      }),
    ).toBe(false);
  });

  it("is not empty when the owner typed text, wherever the cursor is", () => {
    expect(
      terminalScreenInputBoxIsEmpty({
        rows: screen("❯ half a thought"),
        solidRows: screen("❯ half a thought"),
      }),
    ).toBe(false);
  });

  it("is not empty for a menu or a wrapped draft", () => {
    expect(
      terminalScreenInputBoxIsEmpty({
        rows: screen("❯ 1. Yes", "  2. No"),
        solidRows: screen("❯ 1. Yes", "  2. No"),
      }),
    ).toBe(false);
    expect(
      terminalScreenInputBoxIsEmpty({
        rows: screen("❯ ", "  continued draft"),
        solidRows: screen("❯ ", "  continued draft"),
      }),
    ).toBe(false);
  });

  it("is not empty when no prompt is on screen", () => {
    expect(
      terminalScreenInputBoxIsEmpty({
        rows: ["Choose an option", "  1. Yes"],
      }),
    ).toBe(false);
  });
});

describe("terminalScreenInputBoxIsEmpty on a recorded Claude session", () => {
  const recorded = z.object({
    chunks: z.array(z.object({ seq: z.number(), dataBase64: z.string() })),
  });
  const chunks = recorded.parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../fixtures/native-terminal/claude-fullscreen-after-clear.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  ).chunks;
  const typed = (text: string) =>
    chunks.map((chunk) =>
      chunk.seq === 430 || chunk.seq === 431
        ? {
            ...chunk,
            dataBase64: Buffer.from(
              chunk.seq === 430
                ? `\u001b[?2026h\u001b[?25l\u001b[2J\u001b[22;1H\u001b[2K❯ ${text}\u001b[?25h\u001b[?2026l`
                : "\u001b[?2026h\u001b[?25l\u001b[23;1H─\u001b[22;9H\u001b[?25h\u001b[?2026l",
              "utf8",
            ).toString("base64"),
          }
        : chunk,
    );
  const render = (selected: typeof chunks) =>
    renderTerminalScreen({
      cols: 120,
      lines: undefined,
      rows: 36,
      output: {
        chunks: selected,
        nextSeq: (selected.at(-1)?.seq ?? 0) + 1,
        truncated: false,
        status: "running",
        exitCode: null,
        closeReason: null,
      },
    });

  const withRestoredGlyphs = (screen: Awaited<ReturnType<typeof render>>) => ({
    ...screen,
    rows: screen.rows.map((row, index) => {
      if (/^x{100,}$/u.test(row)) return "─".repeat(screen.cols);
      if (index === screen.cursor.row && row.startsWith("x")) {
        return `❯${row.slice(1)}`;
      }
      return row;
    }),
  });

  it("reads the recorded idle prompt, whose glyphs the fixture anonymized, as empty", async () => {
    const screen = withRestoredGlyphs(
      await render(chunks.filter((chunk) => chunk.seq < 429)),
    );
    expect(screen.rows[screen.cursor.row]).toBe("❯ ");
    expect(terminalScreenInputBoxIsEmpty(screen)).toBe(true);
  });

  it("reads a prompt holding typed text as occupied", async () => {
    const screen = await render(typed("say ok"));
    expect(terminalScreenInputBoxIsEmpty(screen)).toBe(false);
  });
});
