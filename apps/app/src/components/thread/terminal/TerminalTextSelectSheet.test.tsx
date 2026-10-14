// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalMobileControls } from "./TerminalMobileControls";
import { TerminalTextSelectSheet } from "./TerminalTextSelectSheet";
import { terminalTextSnapshot } from "./terminal-text-snapshot";

const copied = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/clipboard", () => ({
  copyToClipboardWithToast: async (text: string) => {
    copied.push(text);
    return true;
  },
}));

const terminals: Terminal[] = [];

afterEach(() => {
  cleanup();
  copied.length = 0;
  while (terminals.length > 0) {
    terminals.pop()?.dispose();
  }
});

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

async function selectAndCopy(terminal: Terminal): Promise<string> {
  const onOpenChange = vi.fn();
  render(
    <TerminalTextSelectSheet
      open
      text={terminalTextSnapshot(terminal)}
      onOpenChange={onOpenChange}
    />,
  );
  const shown = await waitFor(() => {
    const element = document.querySelector("[data-terminal-text-snapshot]");
    if (element === null) {
      throw new Error("terminal text not rendered yet");
    }
    return element;
  });
  expect(shown.className).toContain("select-text");
  fireEvent.click(screen.getByRole("button", { name: "Copy all" }));
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(copied).toHaveLength(1);
  expect(copied[0]).toBe(shown.textContent);
  return copied[0] ?? "";
}

describe("TerminalTextSelectSheet", () => {
  it("copies scrollback beyond one screen, first line included", async () => {
    const terminal = new Terminal({ cols: 30, rows: 5, scrollback: 500 });
    terminals.push(terminal);
    const lines = Array.from({ length: 40 }, (_, index) => `row ${index}`);
    await write(terminal, lines.join("\r\n"));
    expect(terminal.buffer.active.baseY).toBeGreaterThan(0);

    const text = await selectAndCopy(terminal);
    expect(text).toBe(lines.join("\n"));
    expect(text.split("\n")[0]).toBe("row 0");
  });

  it("copies what a full-screen app draws on the alternate screen", async () => {
    const terminal = new Terminal({ cols: 30, rows: 5, scrollback: 500 });
    terminals.push(terminal);
    await write(terminal, "shell row\r\n\x1b[?1049h\x1b[H\x1b[2J");
    await write(terminal, "app title\r\n\r\n  app body");
    expect(terminal.buffer.active.type).toBe("alternate");

    expect(await selectAndCopy(terminal)).toBe("app title\n\n  app body");
  });

  it("renders no text while closed", () => {
    render(
      <TerminalTextSelectSheet
        open={false}
        text="hidden"
        onOpenChange={vi.fn()}
      />,
    );
    expect(document.querySelector("[data-terminal-text-snapshot]")).toBeNull();
  });
});

describe("TerminalMobileControls select key", () => {
  it("opens text selection from the extra keys", () => {
    const onSelectText = vi.fn();
    render(
      <TerminalMobileControls
        controlActive={false}
        disabled={false}
        onArrow={vi.fn()}
        onControlChange={vi.fn()}
        onInput={vi.fn()}
        onKeyboardToggle={vi.fn()}
        onPaste={vi.fn()}
        onSelectText={onSelectText}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "More terminal keys" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Select terminal text" }),
    );
    expect(onSelectText).toHaveBeenCalledTimes(1);
  });
});
