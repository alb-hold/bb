import { describe, expect, it } from "vitest";
import {
  decodeTerminalOutputChunks,
  terminalOutputAlreadyShowsText,
  terminalOutputShowsPaste,
  terminalOutputShowsPasteAgain,
  terminalScreenAlreadyShowsText,
} from "../../src/services/threads/native-terminal-echo.js";

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
});
