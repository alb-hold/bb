import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { renderTerminalScreen } from "../../src/services/terminals/terminal-screen.js";
import { terminalScreenInputBoxIsEmpty } from "../../src/services/threads/native-terminal-echo.js";

const chunkSchema = z.object({ seq: z.number(), dataBase64: z.string() });
const recorded = z.object({
  idle: z.object({ chunks: z.array(chunkSchema) }),
  working: z.object({ chunks: z.array(chunkSchema) }),
});
type Chunk = z.infer<typeof chunkSchema>;

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

function render(chunks: Chunk[]) {
  return renderTerminalScreen({
    cols: 120,
    lines: undefined,
    rows: 36,
    output: {
      chunks,
      nextSeq: (chunks.at(-1)?.seq ?? 0) + 1,
      truncated: false,
      status: "running",
      exitCode: null,
      closeReason: null,
    },
  });
}

function typed(chunks: Chunk[], text: string): Chunk[] {
  return [
    ...chunks,
    {
      seq: (chunks.at(-1)?.seq ?? 0) + 1,
      dataBase64: Buffer.from(
        `\u001b[33;1H\u001b[2K› ${text}`,
        "utf8",
      ).toString("base64"),
    },
  ];
}

describe("terminalScreenInputBoxIsEmpty on a recorded Codex session", () => {
  it("reads the idle Codex prompt, which has no border rows, as empty", async () => {
    const screen = await render(sessions.idle.chunks);
    expect(screen.rows[screen.cursor.row]).toBe("› Ask Codex to do anything");
    expect(terminalScreenInputBoxIsEmpty(screen)).toBe(true);
  });

  it("reads the prompt of a Codex turn in progress as empty", async () => {
    const screen = await render(sessions.working.chunks);
    expect(screen.rows.some((row) => row.includes("Working ("))).toBe(true);
    expect(screen.rows[screen.cursor.row]).toBe("› Ask Codex to do anything");
    expect(terminalScreenInputBoxIsEmpty(screen)).toBe(true);
  });

  it("reads a Codex prompt holding the owner's typed text as occupied", async () => {
    const screen = await render(typed(sessions.idle.chunks, "half a thought"));
    expect(screen.rows[screen.cursor.row]).toBe("› half a thought");
    expect(terminalScreenInputBoxIsEmpty(screen)).toBe(false);
  });
});
