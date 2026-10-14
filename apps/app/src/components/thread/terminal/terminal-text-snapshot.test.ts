import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import { terminalTextSnapshot } from "./terminal-text-snapshot";

describe("terminalTextSnapshot", () => {
  let terminal: Terminal | null = null;

  afterEach(() => {
    terminal?.dispose();
    terminal = null;
  });

  function write(target: Terminal, data: string): Promise<void> {
    return new Promise((resolve) => target.write(data, resolve));
  }

  it("returns scrollback and screen text without trailing blank rows", async () => {
    terminal = new Terminal({ cols: 20, rows: 4, scrollback: 100 });
    await write(
      terminal,
      Array.from({ length: 8 }, (_, index) => `line ${index}`).join("\r\n"),
    );
    expect(terminalTextSnapshot(terminal)).toBe(
      Array.from({ length: 8 }, (_, index) => `line ${index}`).join("\n"),
    );
  });

  it("joins soft-wrapped rows back into one line", async () => {
    terminal = new Terminal({ cols: 10, rows: 4 });
    await write(terminal, "abcdefghijKLMNO\r\nnext");
    expect(terminalTextSnapshot(terminal)).toBe("abcdefghijKLMNO\nnext");
  });

  it("keeps only the most recent lines", async () => {
    terminal = new Terminal({ cols: 20, rows: 4, scrollback: 100 });
    await write(
      terminal,
      Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\r\n"),
    );
    expect(terminalTextSnapshot(terminal, 3)).toBe("line 7\nline 8\nline 9");
  });

  it("returns the alternate screen a full-screen app is drawing", async () => {
    terminal = new Terminal({ cols: 20, rows: 4, scrollback: 100 });
    await write(terminal, "shell history\r\n\x1b[?1049h\x1b[2;3Hin the app");
    expect(terminalTextSnapshot(terminal)).toBe("\n  in the app");
  });
});
