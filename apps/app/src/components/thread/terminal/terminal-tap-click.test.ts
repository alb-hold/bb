// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendTerminalTapClick } from "./terminal-tap-click";

const CELL_HEIGHT_PX = 15;
const ROWS = 24;
const SGR_PRESS = /\x1b\[<0;(?:\d+|NaN);(?:\d+|NaN)M/g;
const SGR_RELEASE = /\x1b\[<0;(?:\d+|NaN);(?:\d+|NaN)m/g;

describe("sendTerminalTapClick", () => {
  let terminal: Terminal | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    terminal?.dispose();
    terminal = null;
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  function openTerminal(): { terminal: Terminal; sent: string[] } {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 8 }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function offsetWidth(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element")
          ? 256
          : 640;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function offsetHeight(this: HTMLElement) {
        return this.classList.contains("xterm-char-measure-element")
          ? CELL_HEIGHT_PX
          : ROWS * CELL_HEIGHT_PX;
      },
    );
    container = document.createElement("div");
    document.body.append(container);
    terminal = new Terminal({ cols: 80, rows: ROWS });
    terminal.open(container);
    const screen = container.querySelector(".xterm-screen");
    if (!(screen instanceof HTMLElement)) {
      throw new Error("xterm screen element missing");
    }
    screen.getBoundingClientRect = () =>
      DOMRect.fromRect({
        x: 0,
        y: 0,
        width: 80 * 8,
        height: ROWS * CELL_HEIGHT_PX,
      });
    const sent: string[] = [];
    terminal.onData((data) => sent.push(data));
    return { terminal, sent };
  }

  function write(target: Terminal, data: string): Promise<void> {
    return new Promise((resolve) => target.write(data, resolve));
  }

  it("sends a press and a release when the app tracks the mouse", async () => {
    const opened = openTerminal();
    await write(opened.terminal, "\x1b[?1000h\x1b[?1006h");
    expect(sendTerminalTapClick(opened.terminal, { x: 40, y: 40 })).toBe(true);
    const reports = opened.sent.join("");
    expect(reports.match(SGR_PRESS)?.length).toBe(1);
    expect(reports.match(SGR_RELEASE)?.length).toBe(1);
  });

  it("sends nothing when the app does not track the mouse", () => {
    const opened = openTerminal();
    expect(sendTerminalTapClick(opened.terminal, { x: 40, y: 40 })).toBe(false);
    expect(opened.sent).toEqual([]);
  });

  it("ignores taps outside the terminal grid", async () => {
    const opened = openTerminal();
    await write(opened.terminal, "\x1b[?1000h\x1b[?1006h");
    expect(sendTerminalTapClick(opened.terminal, { x: 40, y: ROWS * 40 })).toBe(
      false,
    );
    expect(opened.sent).toEqual([]);
  });
});
