// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachTerminalWheelLines,
  terminalWheelLines,
  type TerminalWheelLineState,
} from "./terminal-wheel";

const CELL_HEIGHT_PX = 15;
const ROWS = 24;
const SGR_WHEEL_UP = /\x1b\[<64;(?:\d+|NaN);(?:\d+|NaN)M/g;
const SGR_WHEEL_DOWN = /\x1b\[<65;(?:\d+|NaN);(?:\d+|NaN)M/g;

function pixelWheel(deltaY: number) {
  return { deltaMode: 0, deltaY };
}

describe("terminalWheelLines", () => {
  it("turns small trackpad deltas into lines once they add up to a cell", () => {
    const state: TerminalWheelLineState = { remainderPx: 0 };
    const lines = [4, 4, 4, 4, 4, 4, 4, 4].map((deltaY) =>
      terminalWheelLines(state, pixelWheel(deltaY), CELL_HEIGHT_PX, ROWS),
    );
    expect(lines.reduce((sum, value) => sum + value, 0)).toBe(2);
    expect(lines.filter((value) => value !== 0)).toEqual([1, 1]);
  });

  it("scrolls one line per cell height of a mouse wheel notch", () => {
    const state: TerminalWheelLineState = { remainderPx: 0 };
    expect(
      terminalWheelLines(state, pixelWheel(-100), CELL_HEIGHT_PX, ROWS),
    ).toBe(-6);
  });

  it("drops the remainder when the direction reverses", () => {
    const state: TerminalWheelLineState = { remainderPx: 0 };
    terminalWheelLines(state, pixelWheel(14), CELL_HEIGHT_PX, ROWS);
    expect(
      terminalWheelLines(state, pixelWheel(-14), CELL_HEIGHT_PX, ROWS),
    ).toBe(0);
    expect(
      terminalWheelLines(state, pixelWheel(-2), CELL_HEIGHT_PX, ROWS),
    ).toBe(-1);
  });

  it("uses line and page deltas as given and caps at one screen", () => {
    const state: TerminalWheelLineState = { remainderPx: 0 };
    expect(
      terminalWheelLines(state, { deltaMode: 1, deltaY: 3 }, 0, ROWS),
    ).toBe(3);
    expect(
      terminalWheelLines(state, { deltaMode: 2, deltaY: -1 }, 0, ROWS),
    ).toBe(-ROWS);
    expect(
      terminalWheelLines(state, pixelWheel(5000), CELL_HEIGHT_PX, ROWS),
    ).toBe(ROWS);
  });

  it("does nothing without a measured cell height", () => {
    const state: TerminalWheelLineState = { remainderPx: 0 };
    expect(terminalWheelLines(state, pixelWheel(100), 0, ROWS)).toBe(0);
  });
});

describe("attachTerminalWheelLines", () => {
  let terminal: Terminal | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    terminal?.dispose();
    terminal = null;
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  async function openTerminal(): Promise<{
    terminal: Terminal;
    screen: HTMLElement;
    sent: string[];
  }> {
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
    terminal = new Terminal({ cols: 80, rows: ROWS, allowProposedApi: true });
    terminal.open(container);
    attachTerminalWheelLines(terminal);
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
    return { terminal, screen, sent };
  }

  function write(target: Terminal, data: string): Promise<void> {
    return new Promise((resolve) => target.write(data, resolve));
  }

  function wheel(screen: HTMLElement, deltaY: number): WheelEvent {
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 40,
      deltaMode: 0,
      deltaY,
    });
    screen.dispatchEvent(event);
    return event;
  }

  it("sends one wheel report per scrolled line when the app tracks the mouse", async () => {
    const opened = await openTerminal();
    await write(opened.terminal, "\x1b[?1000h\x1b[?1006h");
    wheel(opened.screen, -100);
    const reports = opened.sent.join("");
    expect(reports.match(SGR_WHEEL_UP)?.length).toBe(6);
    expect(reports.match(SGR_WHEEL_DOWN)).toBeNull();
  });

  it("sends trackpad scrolling that xterm would round down to nothing", async () => {
    const opened = await openTerminal();
    await write(opened.terminal, "\x1b[?1000h\x1b[?1006h");
    for (let index = 0; index < 10; index += 1) {
      wheel(opened.screen, 6);
    }
    expect(opened.sent.join("").match(SGR_WHEEL_DOWN)?.length).toBe(4);
  });

  it("leaves wheel scrolling to xterm when the app does not track the mouse", async () => {
    const opened = await openTerminal();
    wheel(opened.screen, -100);
    expect(opened.sent.join("")).toBe("");
  });
});
