import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { terminalScreenQuerySchema } from "@bb/server-contract";
import { renderTerminalScreen } from "./terminal-screen.js";

function output(data: string, truncated = false) {
  return {
    chunks: [{ seq: 0, dataBase64: Buffer.from(data).toString("base64") }],
    nextSeq: 1,
    truncated,
    status: "exited" as const,
    exitCode: 0,
    closeReason: null,
  };
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

  it("drops a partial first line when retained output starts mid-sequence", async () => {
    const screen = await renderTerminalScreen({
      cols: 20,
      rows: 2,
      lines: undefined,
      output: output("31mcorrupt\nclean\n", true),
    });
    expect(screen.rows).toEqual(["clean", ""]);
    expect(screen.truncated).toBe(true);
    expect(screen.complete).toBe(false);
  });

  it("reports an incomplete screen after the initial redraw falls out of retention", async () => {
    const stream = execFileSync(
      process.execPath,
      [fileURLToPath(new URL("../../../test/fixtures/terminal-screen-stress.mjs", import.meta.url))],
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
