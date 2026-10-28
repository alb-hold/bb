// @vitest-environment jsdom

import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { handleTerminalServerMessage } from "./ThreadTerminalView";
import { registerTerminalOutputBoundaryHandler } from "./terminal-viewport";
import { createTerminalOutputBoundaries } from "./terminal-output-boundaries";
import { registerTerminalOsc52Handler } from "./terminal-shell-state";

const SELECTED_TEXT =
  "and is never edited or deleted. _Are you OK with that?_ Café ✓ — answer there or here. ".repeat(
    26,
  );

function bufferText(terminal: Terminal): string {
  return Array.from(
    { length: terminal.buffer.active.length },
    (_, index) =>
      terminal.buffer.active.getLine(index)?.translateToString(true) ?? "",
  ).join("\n");
}

function splitAt(bytes: Buffer, sizes: number[]): Buffer[] {
  const parts: Buffer[] = [];
  let offset = 0;
  for (const size of sizes) {
    parts.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  parts.push(bytes.subarray(offset));
  return parts.filter((part) => part.length > 0);
}

async function deliver(parts: Buffer[]) {
  const terminal = new Terminal({
    cols: 100,
    rows: 30,
    allowProposedApi: true,
  });
  const copies: string[] = [];
  const starts: number[] = [];
  const token = "boundary-token";
  const outputBoundaries = createTerminalOutputBoundaries(token);
  registerTerminalOsc52Handler(
    { parser: terminal.parser },
    (text) => copies.push(text),
    () => false,
  );
  registerTerminalOutputBoundaryHandler(terminal.parser, token, (sequence) =>
    starts.push(sequence),
  );
  const emittedToPty: string[] = [];
  terminal.onData((data) => emittedToPty.push(data));
  for (const [sequence, part] of parts.entries()) {
    await new Promise<void>((resolve) => {
      handleTerminalServerMessage({
        acknowledgeOutput: () => undefined,
        message: {
          type: "output",
          chunk: { seq: sequence, dataBase64: part.toString("base64") },
        },
        onOutputParsed: () => resolve(),
        onOutputFrameParsed: () => undefined,
        onReplayComplete: () => undefined,
        replayNextSeq: null,
        replayWriteState: { suppressedWriteCount: 0 },
        setReplayNextSeq: () => undefined,
        terminal,
        outputBoundaries,
      });
    });
  }
  return { terminal, copies, starts, emittedToPty };
}

describe("terminal output boundaries inside escape sequences", () => {
  it.each([
    ["Claude Code (1024-byte PTY reads, BEL)", "\x07", [1024, 1024]],
    ["Codex-style (ST terminator, 700-byte reads)", "\x1b\\", [700, 700, 700]],
    ["tiny reads (3 bytes)", "\x07", Array(40).fill(3)],
  ])(
    "delivers the whole OSC 52 copy and prints nothing: %s",
    async (_name, terminator, sizes) => {
      const osc = Buffer.from(
        `\x1b]52;c;${Buffer.from(SELECTED_TEXT).toString("base64")}${terminator}tail`,
        "latin1",
      );
      const { terminal, copies, starts, emittedToPty } = await deliver(
        splitAt(osc, sizes),
      );

      expect(copies).toEqual([SELECTED_TEXT]);
      expect(bufferText(terminal)).not.toMatch(/[A-Za-z0-9+/=]{40,}/);
      expect(bufferText(terminal)).toContain("tail");
      expect(emittedToPty).toEqual([]);
      expect(starts).toEqual(
        Array.from({ length: starts.length }, (_, index) => index),
      );
      expect(starts.length).toBe(splitAt(osc, sizes).length);
    },
  );

  it("keeps a CSI sequence and a UTF-8 character intact across a chunk boundary", async () => {
    const bytes = Buffer.from("\x1b[31mred\x1b[0m ✓ café", "utf8");
    const checkmark = bytes.indexOf(Buffer.from("✓"));
    const { terminal } = await deliver([
      bytes.subarray(0, 2),
      bytes.subarray(2, checkmark + 1),
      bytes.subarray(checkmark + 1),
    ]);

    expect(bufferText(terminal).split("\n")[0]?.trimEnd()).toBe("red ✓ café");
  });
  it("leaves the visible output identical to an unsplit stream and reports every chunk start once, in order, wherever the chunks are cut", async () => {
    const stream = Buffer.from(
      [
        "\x1b[2J\x1b[H\x1b[38;2;20;120;220mready 界🙂\x1b[0m\r\n",
        `\x1b]52;c;${Buffer.from(SELECTED_TEXT).toString("base64")}\x07`,
        "\x1b]133;A\x07prompt \x1b[1;32m$\x1b[0m café ✓\r\n",
        "\x1b]0;title\x1b\\line two\x1b[2;5Hmoved\x1b[K\r\n",
        "x".repeat(300),
      ].join(""),
      "utf8",
    );
    const reference = new Terminal({
      cols: 100,
      rows: 30,
      allowProposedApi: true,
    });
    await new Promise<void>((resolve) => reference.write(stream, resolve));

    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let round = 0; round < 12; round += 1) {
      const sizes: number[] = [];
      let remaining = stream.length;
      while (remaining > 0) {
        const size = 1 + (next() % (round % 2 === 0 ? 9 : 200));
        sizes.push(Math.min(size, remaining));
        remaining -= size;
      }
      const parts = splitAt(stream, sizes.slice(0, -1));
      const { terminal, copies, starts } = await deliver(parts);

      expect(starts).toEqual(parts.map((_, index) => index));
      expect(copies).toEqual([SELECTED_TEXT]);
      expect(bufferText(terminal)).toBe(bufferText(reference));
      expect(terminal.buffer.active.cursorX).toBe(
        reference.buffer.active.cursorX,
      );
      expect(terminal.buffer.active.cursorY).toBe(
        reference.buffer.active.cursorY,
      );
    }
  });
});
