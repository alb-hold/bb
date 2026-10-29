import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TerminalScreenState } from "../../src/services/terminals/terminal-screen-state.js";
import { terminalScreenInputBoxIsEmpty } from "../../src/services/threads/native-terminal-echo.js";

const chunkSchema = z.object({ seq: z.number(), dataBase64: z.string() });
const recorded = z.object({
  idle: z.object({ chunks: z.array(chunkSchema) }),
  working: z.object({ chunks: z.array(chunkSchema) }),
});

const sessions = recorded.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../fixtures/native-terminal/codex-prompt-sessions.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);

const toBase64 = (bytes: string) =>
  Buffer.from(bytes, "utf8").toString("base64");

async function promptScreenAfter(dataBase64: readonly string[]) {
  const state = new TerminalScreenState(120, 36);
  dataBase64.forEach((data, index) => state.pushBase64(index, data));
  const screen = await state.promptScreen();
  state.dispose();
  if (screen === null) throw new Error("prompt screen unavailable");
  return screen;
}

const codexIdle = sessions.idle.chunks.map((chunk) => chunk.dataBase64);
const codexWorking = sessions.working.chunks.map((chunk) => chunk.dataBase64);
const codexDraftAt = (column: number) =>
  toBase64(
    `\u001b[33;1H\u001b[2K\u001b[1m›\u001b[22m half a thought\u001b[33;${column}H`,
  );

const RULE = "─".repeat(40);
const claudeScreen = (promptRow: string, cursorColumn: number) =>
  toBase64(
    `\u001b[2J\u001b[1;1H⏺ ok\u001b[2;1H${RULE}\u001b[3;1H${promptRow}\u001b[4;1H${RULE}\u001b[5;1H  Sonnet 5.5\u001b[3;${cursorColumn}H`,
  );

describe("the input-box check on recorded Codex screens", () => {
  it("reads the idle Codex prompt, which has no border rows and a dim placeholder, as empty", async () => {
    const screen = await promptScreenAfter(codexIdle);
    expect(screen.rows[screen.cursor.row]).toBe("› Ask Codex to do anything");
    expect(terminalScreenInputBoxIsEmpty(screen)).toBe(true);
  });

  it("reads the prompt of a Codex turn in progress as empty", async () => {
    const screen = await promptScreenAfter(codexWorking);
    expect(screen.rows.some((row) => row.includes("Working ("))).toBe(true);
    expect(terminalScreenInputBoxIsEmpty(screen)).toBe(true);
  });

  it.each([
    ["at the start of the draft", 3],
    ["in the middle of the draft", 9],
    ["at the end of the draft", 17],
  ])(
    "reads a Codex draft as occupied with the cursor %s",
    async (_label, column) => {
      const screen = await promptScreenAfter([
        ...codexIdle,
        codexDraftAt(column),
      ]);
      expect(screen.rows[32]).toBe("› half a thought");
      expect(screen.cursor.col).toBe(column - 1);
      expect(terminalScreenInputBoxIsEmpty(screen)).toBe(false);
    },
  );

  it("cannot call a Codex prompt empty from rendered rows alone", async () => {
    const screen = await promptScreenAfter(codexIdle);
    expect(terminalScreenInputBoxIsEmpty({ rows: screen.rows })).toBe(false);
  });
});

describe("the input-box check on Claude-layout screens", () => {
  it("reads a bare prompt as empty", async () => {
    const screen = await promptScreenAfter([claudeScreen("❯ ", 3)]);
    expect(terminalScreenInputBoxIsEmpty(screen)).toBe(true);
  });

  it("reads a dim placeholder as empty", async () => {
    const screen = await promptScreenAfter([
      claudeScreen('❯ \u001b[2mTry "fix lint errors"\u001b[22m', 3),
    ]);
    expect(screen.rows[2]).toBe('❯ Try "fix lint errors"');
    expect(terminalScreenInputBoxIsEmpty(screen)).toBe(true);
  });

  it.each([
    ["at the start of the draft", 3],
    ["in the middle of the draft", 9],
    ["at the end of the draft", 17],
  ])(
    "reads a Claude draft as occupied with the cursor %s",
    async (_label, column) => {
      const screen = await promptScreenAfter([
        claudeScreen("❯ half a thought", column),
      ]);
      expect(screen.cursor.col).toBe(column - 1);
      expect(terminalScreenInputBoxIsEmpty(screen)).toBe(false);
    },
  );
});
