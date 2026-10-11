import { describe, expect, it } from "vitest";
import {
  decodeTerminalOutputChunks,
  terminalOutputAlreadyShowsText,
  terminalOutputShowsPaste,
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

  it("does not count text that was on screen before the paste", () => {
    expect(
      terminalOutputShowsPaste({
        before: "› run the tests\r\n• Ran pnpm test",
        output: "\u001b[H\u001b[2J› run the tests\r\n• Ran pnpm test",
        pastePlaceholders: [],
        text: "run the tests",
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
