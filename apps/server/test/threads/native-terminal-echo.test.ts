import { describe, expect, it } from "vitest";
import {
  decodeTerminalOutputChunks,
  terminalOutputAlreadyShowsText,
  terminalOutputShowsPaste,
  terminalOutputShowsPasteAgain,
  terminalScreenAlreadyShowsText,
  terminalScreenInputBoxHoldsText,
} from "../../src/services/threads/native-terminal-echo.js";
import { createTerminalGridMarker } from "@bb/domain";

describe("terminalOutputShowsPaste", () => {
  it("finds text a TUI drew between cursor moves and wrapped lines", () => {
    expect(
      terminalOutputShowsPaste({
        before: "",
        output:
          "\u001b[2K\u001b[1G› Reply\u001b[1Cwith\u001b[1Cexactly the\r\n│ word RIGHT-PANE\u001b[0m",
        pastePlaceholders: [],
        text: "Reply with exactly the word RIGHT-PANE",
      }),
    ).toBe(true);
  });

  it("ignores a menu that redraws without the message", () => {
    expect(
      terminalOutputShowsPaste({
        before: "› 1. Update now\r\n  2. Skip",
        output:
          "\u001b]0;⠦ project\u0007\u001b[3;1H› 1. Update now\r\n  2. Skip",
        pastePlaceholders: ["[Pasted Content "],
        text: "Reply with exactly the word RIGHT-PANE",
      }),
    ).toBe(false);
  });

  it("finds text a diff renderer drew around a cell it skipped", () => {
    expect(
      terminalOutputShowsPaste({
        before: "",
        output:
          "\r\u001b[1B\u276f\u00a0Use your AskUserQuestion tool now to ask me which colour I prefer, with exactly two options: Teal and Amber. Do not\u001b[K\r\u001b[1B  answer it your\u001b[18Gelf.\u001b[K\r\u001b[39C\u001b[3B\u001b[K\u001b[36;1H\u001b[33;22H",
        pastePlaceholders: ["[Pasted text #"],
        text: "Use your AskUserQuestion tool now to ask me which colour I prefer, with exactly two options: Teal and Amber. Do not answer it yourself.",
      }),
    ).toBe(true);
  });

  it("finds text drawn with absolute moves around cells it skipped", () => {
    expect(
      terminalOutputShowsPaste({
        before: "",
        output:
          "\u001b[30;3HRe\u001b[30;6Hly with exa\u001b[30;18Htly the word R\u001b[30;33HGHT-PANE",
        pastePlaceholders: ["[Pasted Content "],
        text: "Reply with exactly the word RIGHT-PANE",
      }),
    ).toBe(true);
  });

  it("does not take the message's letters scattered among other text", () => {
    expect(
      terminalOutputShowsPaste({
        before: "",
        output:
          "\u001b[3;1HReply? 1. Yes with care 2. No exactly then the word list RIGHT-PANE-X? Esc",
        pastePlaceholders: [],
        text: "Reply with exactly the word RIGHT-PANE",
      }),
    ).toBe(false);
  });

  it("does not take a mostly undrawn region for the message", () => {
    expect(
      terminalOutputShowsPaste({
        before: "",
        output: "\u001b[5;1HR\u001b[5;60HE",
        pastePlaceholders: [],
        text: "Reply with exactly the word RIGHT-PANE",
      }),
    ).toBe(false);
  });

  it("accepts a declared long-paste placeholder", () => {
    expect(
      terminalOutputShowsPaste({
        before: "",
        output: "\u001b[2K› [Pasted Content 2569 chars]",
        pastePlaceholders: ["[Pasted Content "],
        text: "a\n".repeat(2000),
      }),
    ).toBe(true);
  });

  it("accepts a new placeholder while an earlier one is on screen", () => {
    expect(
      terminalOutputShowsPaste({
        before: "> [Pasted text #1 +59 lines]",
        output: "> [Pasted text #1 +59 lines]\r\n> [Pasted text #2 +59 lines]",
        pastePlaceholders: ["[Pasted text #"],
        text: "a\n".repeat(2000),
      }),
    ).toBe(true);
  });

  it("does not count a redrawn earlier placeholder", () => {
    expect(
      terminalOutputShowsPaste({
        before: "> [Pasted text #1 +59 lines]",
        output: "\u001b[1;1H> [Pasted text #1 +59 lines]\r\n❯ 1. Yes",
        pastePlaceholders: ["[Pasted text #"],
        text: "a\n".repeat(2000),
      }),
    ).toBe(false);
  });

  it("accepts a placeholder with the same label as an earlier one when it is drawn in a new place", () => {
    expect(
      terminalOutputShowsPaste({
        before: "\u001b[2;1H\u203a [Image #1] What colour?\r\n\u2022 Green",
        output: "\u001b[6;1H\u001b[2K\u203a [Image #1]",
        pastePlaceholders: ["[Pasted Content ", "[Image #"],
        text: "/data/attachments/second.png",
      }),
    ).toBe(true);
  });

  it("does not count an earlier placeholder with the same label drawn again in place", () => {
    expect(
      terminalOutputShowsPaste({
        before: "\u001b[2;1H\u203a [Image #1] What colour?\r\n\u2022 Green",
        output: "\u001b[2;1H\u001b[2K\u203a [Image #1] What colour?",
        pastePlaceholders: ["[Pasted Content ", "[Image #"],
        text: "/data/attachments/second.png",
      }),
    ).toBe(false);
  });

  it("does not count an earlier placeholder reprinted after the screen was cleared", () => {
    expect(
      terminalOutputShowsPaste({
        before: "\u001b[2;1H\u203a [Image #1] What colour?\r\n\u2022 Green",
        output:
          "\u001b[2J\u001b[4;1H\u203a [Image #1] What colour?\r\n\u2022 Green\r\n\u276f 1. Yes",
        pastePlaceholders: ["[Pasted Content ", "[Image #"],
        text: "/data/attachments/second.png",
      }),
    ).toBe(false);
  });

  it("does not take a placeholder from another CLI", () => {
    expect(
      terminalOutputShowsPaste({
        before: "",
        output: "\u001b[2K> [Pasted text #1 +59 lines]",
        pastePlaceholders: ["[Pasted Content "],
        text: "a\n".repeat(2000),
      }),
    ).toBe(false);
  });

  it("does not treat a window title as drawn text", () => {
    expect(
      terminalOutputShowsPaste({
        before: "",
        output: "\u001b]0;Reply with exactly the word RIGHT-PANE\u0007",
        pastePlaceholders: [],
        text: "Reply with exactly the word RIGHT-PANE",
      }),
    ).toBe(false);
  });
});

describe("terminalOutputAlreadyShowsText", () => {
  it("flags a short reply that a menu already draws", () => {
    expect(
      terminalOutputAlreadyShowsText({
        output: "\u001b[2K❯ 1. Yes\r\n  2. No",
        text: "1",
      }),
    ).toBe(true);
  });

  it("passes text that is not on screen", () => {
    expect(
      terminalOutputAlreadyShowsText({
        output: "› 1. Update now\r\n  2. Skip",
        text: "run the tests",
      }),
    ).toBe(false);
  });
});

describe("terminalScreenAlreadyShowsText", () => {
  const scrolled = `• Everything is ok now\r\n${"• Ran a step\r\n".repeat(60)}› `;

  it("passes a short reply that only scrolled-away output shows", () => {
    expect(
      terminalScreenAlreadyShowsText({
        output: scrolled,
        screenRows: 36,
        text: "ok",
      }),
    ).toBe(false);
  });

  it("flags a short reply a menu on the visible screen draws", () => {
    expect(
      terminalScreenAlreadyShowsText({
        output: `${scrolled}\r\n❯ 1. Yes\r\n  2. No`,
        screenRows: 36,
        text: "1",
      }),
    ).toBe(true);
  });
});

describe("terminalScreenAlreadyShowsText in the input line", () => {
  const rule = "─".repeat(60);
  const idleClaudeScreen = (args: { scrollback: string; input: string }) =>
    [
      "\u001b[H\u001b[2J",
      `❯ ${args.scrollback}`,
      "",
      `⏺ ${args.scrollback.replace(/^.*: /u, "")}`,
      "",
      "✻ Cooked for 3s · done 7:12 AM",
      rule,
      `❯\u00a0${args.input}`,
      rule,
      "  61 │ 5h 10% · 3h17 │ 7d 56% · 3d12h",
    ].join("\r\n");
  const repeated = "Reply with exactly: repeat-probe";

  it("passes text that only scrollback shows above an empty prompt", () => {
    expect(
      terminalScreenAlreadyShowsText({
        output: idleClaudeScreen({ scrollback: repeated, input: "" }),
        screenRows: 36,
        text: repeated,
      }),
    ).toBe(false);
  });

  it("flags text left unsent in the input line", () => {
    expect(
      terminalScreenAlreadyShowsText({
        output: idleClaudeScreen({ scrollback: repeated, input: repeated }),
        screenRows: 36,
        text: repeated,
      }),
    ).toBe(true);
  });

  it("flags text unsent on a later row of a multi-line input", () => {
    expect(
      terminalScreenAlreadyShowsText({
        output: `${idleClaudeScreen({ scrollback: repeated, input: "first line" })}\r\n  ${repeated}`,
        screenRows: 36,
        text: repeated,
      }),
    ).toBe(true);
  });

  it("passes /clear that only scrollback shows above an empty prompt", () => {
    expect(
      terminalScreenAlreadyShowsText({
        output: idleClaudeScreen({ scrollback: "/clear", input: "" }),
        screenRows: 36,
        text: "/clear",
      }),
    ).toBe(false);
  });

  it.each([
    ["\u001b[2m", "\u001b[22m"],
    ["\u001b[2m", "\u001b[0m"],
    ["\u001b[2;38;5;244m", "\u001b[m"],
  ])(
    "passes the text a faint Claude Code prompt suggestion shows (%j then %j)",
    (faint, normal) => {
      expect(
        terminalScreenAlreadyShowsText({
          output: idleClaudeScreen({
            scrollback: repeated,
            input: `${faint}${repeated}${normal}`,
          }),
          screenRows: 36,
          text: repeated,
        }),
      ).toBe(false);
    },
  );

  it("passes the text a faint Codex placeholder shows", () => {
    expect(
      terminalScreenAlreadyShowsText({
        output: `• Ran a step\r\n› \u001b[2m${repeated}\u001b[22m`,
        screenRows: 36,
        text: repeated,
      }),
    ).toBe(false);
  });

  it("flags the same text typed in normal intensity after a faint one was erased", () => {
    expect(
      terminalScreenAlreadyShowsText({
        output: `❯\u00a0\u001b[2m${repeated}\u001b[22m\u001b[2K\u001b[1G❯\u00a0${repeated}`,
        screenRows: 36,
        text: repeated,
      }),
    ).toBe(true);
  });

  it("flags typed text drawn next to a faint suggestion", () => {
    expect(
      terminalScreenAlreadyShowsText({
        output: `❯\u00a0${repeated}\u001b[2m and more\u001b[22m`,
        screenRows: 36,
        text: repeated,
      }),
    ).toBe(true);
  });

  it("flags text on a screen that draws no prompt marker", () => {
    expect(
      terminalScreenAlreadyShowsText({
        output: `\u001b[H\u001b[2J${repeated}\r\n  Esc to cancel`,
        screenRows: 36,
        text: repeated,
      }),
    ).toBe(true);
  });
});

describe("terminalOutputShowsPasteAgain", () => {
  const before = `• Everything is ok now\r\n${"• Ran a step\r\n".repeat(60)}› `;

  it("accepts a new drawing of text that older output already shows", () => {
    expect(
      terminalOutputShowsPasteAgain({
        before,
        output: "\u001b[2K\u001b[1G› ok",
        pastePlaceholders: [],
        text: "ok",
      }),
    ).toBe(true);
  });

  it("accepts the repeated paste drawn over a faint suggestion of the same text", () => {
    const history = "\u001b[1;1H\u276f say ok\r\n\u23fa ok";
    const ghost = "\u001b[10;3H\u001b[2msay ok\u001b[22m";
    expect(
      terminalOutputShowsPasteAgain({
        before: history + ghost,
        output: "\u001b[10;3Hsay\u001b[10;7Gok",
        pastePlaceholders: [],
        text: "say ok",
      }),
    ).toBe(true);
  });

  it("does not take a faint suggestion drawn again in place for the paste", () => {
    const history = "\u001b[1;1H\u276f say ok\r\n\u23fa ok";
    const ghost = "\u001b[10;3H\u001b[2msay ok\u001b[22m";
    expect(
      terminalOutputShowsPasteAgain({
        before: history + ghost,
        output: "\u001b[10;3H\u001b[2msay ok\u001b[22m",
        pastePlaceholders: [],
        text: "say ok",
      }),
    ).toBe(false);
  });

  it("does not count the older line drawn again in place", () => {
    expect(
      terminalOutputShowsPasteAgain({
        before,
        output: "\u001b[61A\u001b[1G• Everything is ok now\u001b[61B",
        pastePlaceholders: [],
        text: "ok",
      }),
    ).toBe(false);
  });

  it("does not trust a screen that was cleared and reprinted", () => {
    expect(
      terminalOutputShowsPasteAgain({
        before,
        output: `\u001b[H\u001b[2J• Everything is ok now\r\n• It is ok again\r\n› ok`,
        pastePlaceholders: [],
        text: "ok",
      }),
    ).toBe(false);
  });

  it("accepts the repeated paste when a reset redraws it in the input box", () => {
    const text = "repeat the visible Claude prompt exactly";
    expect(
      terminalOutputShowsPasteAgain({
        before: `> ${text}\r\n\r\n❯ `,
        output: `\u001b[H\u001b[2J> ${text}\r\n\r\n❯ ${text}`,
        pastePlaceholders: [],
        text,
      }),
    ).toBe(true);
  });

  it("does not accept a reset redraw that omits the repeated paste", () => {
    const text = "repeat the visible Claude prompt exactly";
    expect(
      terminalOutputShowsPasteAgain({
        before: `> ${text}\r\n\r\n❯ `,
        output: `\u001b[H\u001b[2J> ${text}\r\n\r\n❯ `,
        pastePlaceholders: [],
        text,
      }),
    ).toBe(false);
  });

  it("does not trust an extra history redraw when the input box is empty", () => {
    const text = "repeat the visible Claude prompt exactly";
    expect(
      terminalOutputShowsPasteAgain({
        before: `> ${text}\r\n\r\n❯ `,
        output: `\u001b[H\u001b[2J> ${text}\r\n> ${text}\r\n\r\n❯ `,
        pastePlaceholders: [],
        text,
      }),
    ).toBe(false);
  });

  it("does not treat an already visible input copy as newly pasted after reset", () => {
    const text = "repeat the visible Claude prompt exactly";
    expect(
      terminalOutputShowsPasteAgain({
        before: `> ${text}\r\n\r\n❯ ${text}`,
        output: `\u001b[H\u001b[2J> ${text}\r\n\r\n❯ ${text}`,
        pastePlaceholders: [],
        text,
      }),
    ).toBe(false);
  });

  it.each([
    ["erase below the cursor", "\u001b[J"],
    ["erase below the cursor, explicit", "\u001b[0J"],
    ["erase above the cursor", "\u001b[1J"],
    ["erase the screen", "\u001b[2J"],
    ["erase the screen and scrollback", "\u001b[3J"],
  ])(
    "does not trust a menu redrawn after %s that repeats the older reply",
    (_name, erase) => {
      expect(
        terminalOutputShowsPasteAgain({
          before,
          output: `\u001b[1;1H${erase}• Everything is ok now\r\n❯ 1. ok\r\n  2. No`,
          pastePlaceholders: [],
          text: "ok",
        }),
      ).toBe(false);
    },
  );

  it("does not take a menu that redraws without the reply", () => {
    expect(
      terminalOutputShowsPasteAgain({
        before,
        output: "\r\n❯ 1. Yes\r\n  2. No",
        pastePlaceholders: [],
        text: "ok",
      }),
    ).toBe(false);
  });
});

describe("decodeTerminalOutputChunks", () => {
  it("joins a character split across chunks before decoding", () => {
    const bytes = Buffer.from("› ok", "utf8");
    expect(
      decodeTerminalOutputChunks([
        { dataBase64: bytes.subarray(0, 2).toString("base64") },
        { dataBase64: bytes.subarray(2).toString("base64") },
      ]),
    ).toBe("› ok");
  });

  it("removes a grid marker split across output chunks before echo checks", () => {
    const marker = Buffer.from(
      createTerminalGridMarker({ cols: 51, rows: 16 }),
    );
    const output = decodeTerminalOutputChunks([
      { dataBase64: marker.subarray(0, 8).toString("base64") },
      {
        dataBase64: Buffer.concat([
          marker.subarray(8),
          Buffer.from("prompt"),
        ]).toString("base64"),
      },
    ]);
    expect(output).toBe("prompt");
    expect(terminalOutputAlreadyShowsText({ output, text: "bb-grid" })).toBe(
      false,
    );
  });
});

describe("terminalScreenInputBoxHoldsText", () => {
  const rule = "\u2500".repeat(40);
  const screen = (...box: string[]) => {
    const rows = [
      "\u23fa ok",
      rule,
      ...box,
      rule,
      "  Sonnet 5.5 | ctx 64K",
    ];
    return {
      cols: rule.length,
      cursor: {
        col: Array.from(box.at(-1) ?? "").length,
        row: box.length + 1,
      },
      rows,
    };
  };
  const holds = (box: string[], text: string) =>
    terminalScreenInputBoxHoldsText({ ...screen(...box), text });

  it("holds exactly the requested text typed in the box", () => {
    expect(holds(["\u276f\u00a0say ok"], "say ok")).toBe(true);
  });

  it("holds an exact message wrapped across three box rows", () => {
    const cols = 14;
    const rows = [
      "\u23fa ok",
      "\u2500".repeat(cols),
      "\u276f\u00a0abcdefghijkl",
      "  mnopqrstuvwx",
      "  ABCDEFGHIJ",
      "\u2500".repeat(cols),
      "  Sonnet 5.5 | ctx 64K",
    ];
    expect(
      terminalScreenInputBoxHoldsText({
        cols,
        cursor: { col: 12, row: 4 },
        rows,
        text: "abcdefghijklmnopqrstuvwxABCDEFGHIJ",
      }),
    ).toBe(true);
  });

  it("does not match when the draft has an extra space", () => {
    expect(holds(["\u276f\u00a0say  ok"], "say ok")).toBe(false);
  });

  it("does not match when the requested text has an extra space", () => {
    expect(holds(["\u276f\u00a0say ok"], "say  ok")).toBe(false);
  });

  it("refuses a wrapped draft with a space hidden at the wrap point", () => {
    const cols = 14;
    const rows = [
      "\u23fa ok",
      "\u2500".repeat(cols),
      "\u276f\u00a0abcdefghijk",
      "  lmnop",
      "\u2500".repeat(cols),
      "  Sonnet 5.5 | ctx 64K",
    ];
    expect(
      terminalScreenInputBoxHoldsText({
        cols,
        cursor: { col: 7, row: 3 },
        rows,
        text: "abcdefghijklmnop",
      }),
    ).toBe(false);
  });

  it.each([" ", "\u00a0", "\t"])(
    "refuses screen payload with leading or trailing boundary whitespace %j",
    (whitespace) => {
      expect(holds([`\u276f ${whitespace}say ok`], `${whitespace}say ok`)).toBe(
        false,
      );
      expect(
        holds([`\u276f\u00a0say ok${whitespace}`], `say ok${whitespace}`),
      ).toBe(false);
    },
  );

  it.each([
    ["case", "Say ok", "say ok"],
    ["leading space", " say ok", "say ok"],
    ["trailing space", "say ok", "say ok "],
    ["newline", "say ok", "say ok\n"],
  ])("compares %s exactly", (_label, draft, text) => {
    expect(holds([`\u276f\u00a0${draft}`], text)).toBe(false);
  });

  it("refuses when the cursor leaves trailing cells that may contain spaces", () => {
    const box = screen("\u276f\u00a0say ok");
    expect(
      terminalScreenInputBoxHoldsText({
        ...box,
        cursor: { ...box.cursor, col: box.cursor.col + 1 },
        text: "say ok",
      }),
    ).toBe(false);
  });

  it("refuses when a trailing space could occupy the final screen cell", () => {
    const box = screen(`\u276f\u00a0${"x".repeat(37)}`);
    expect(
      terminalScreenInputBoxHoldsText({
        ...box,
        text: "x".repeat(37),
      }),
    ).toBe(false);
  });

  it.each([
    ["more typed text", "\u276f\u00a0please say ok", "say ok"],
    ["less typed text", "\u276f\u00a0say ok", "say ok please"],
    ["an empty box", "\u276f\u00a0", "say ok"],
  ])("does not hold the text beside %s", (_label, box, text) => {
    expect(holds([box], text)).toBe(false);
  });

  it("does not hold the text when no border closes the box", () => {
    expect(
      terminalScreenInputBoxHoldsText({
        cols: 40,
        cursor: { col: 8, row: 0 },
        rows: ["\u203a say ok", "  gpt-5 \u00b7 100% context left"],
        text: "say ok",
      }),
    ).toBe(false);
  });

  it("does not take a menu entry below the box for the box", () => {
    const box = screen("\u276f\u00a0/cl");
    expect(
      terminalScreenInputBoxHoldsText({
        rows: [
          ...box.rows,
          "\u276f /clear  Start a new session",
        ],
        cols: box.cols,
        cursor: box.cursor,
        text: "/clear",
      }),
    ).toBe(false);
  });
});
