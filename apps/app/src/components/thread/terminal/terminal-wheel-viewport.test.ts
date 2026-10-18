// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachTerminalWheelLines } from "./terminal-wheel";

const CELL_WIDTH_PX = 8;
const CELL_HEIGHT_PX = 15;
const COLS = 80;
const ROWS = 24;
const WHEEL_UP = /\x1b\[<64;(?:\d+|NaN);(?:\d+|NaN)M/g;
const SCROLLBACK_LINES = Array.from(
  { length: 200 },
  (_, index) => `line ${index}`,
).join("\r\n");

interface Opened {
  screen: HTMLElement;
  sent: string[];
  terminal: Terminal;
}

const disposers: (() => void)[] = [];

afterEach(() => {
  while (disposers.length > 0) {
    disposers.pop()?.();
  }
  vi.restoreAllMocks();
});

function stubMeasurements(): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    measureText: (text: string) => ({ width: text.length * CELL_WIDTH_PX }),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function offsetWidth(this: HTMLElement) {
      return this.classList.contains("xterm-char-measure-element")
        ? 32 * CELL_WIDTH_PX
        : COLS * CELL_WIDTH_PX;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function offsetHeight(this: HTMLElement) {
      return this.classList.contains("xterm-char-measure-element")
        ? CELL_HEIGHT_PX
        : ROWS * CELL_HEIGHT_PX;
    },
  );
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

async function openTerminal(
  withWheelLines: boolean,
  setup: string,
): Promise<Opened> {
  const host = document.createElement("div");
  document.body.append(host);
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 500 });
  terminal.open(host);
  if (withWheelLines) {
    attachTerminalWheelLines(terminal);
  }
  const screen = host.querySelector(".xterm-screen");
  if (!(screen instanceof HTMLElement)) {
    throw new Error("xterm screen element missing");
  }
  screen.getBoundingClientRect = () =>
    DOMRect.fromRect({
      x: 0,
      y: 0,
      width: COLS * CELL_WIDTH_PX,
      height: ROWS * CELL_HEIGHT_PX,
    });
  await write(terminal, SCROLLBACK_LINES + setup);
  const sent: string[] = [];
  terminal.onData((data) => sent.push(data));
  disposers.push(() => {
    terminal.dispose();
    host.remove();
  });
  return { screen, sent, terminal };
}

function wheel(screen: HTMLElement, deltaY: number, shiftKey = false): void {
  screen.dispatchEvent(
    new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 40,
      deltaMode: 0,
      deltaY,
      shiftKey,
    }),
  );
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function viewport(opened: Opened): { baseY: number; viewportY: number } {
  const buffer = opened.terminal.buffer.active;
  return { baseY: buffer.baseY, viewportY: buffer.viewportY };
}

async function compareWithUnmodified(
  setup: string,
  input: (screen: HTMLElement) => void,
): Promise<{ changed: Opened; unmodified: Opened }> {
  stubMeasurements();
  const changed = await openTerminal(true, setup);
  const unmodified = await openTerminal(false, setup);
  input(changed.screen);
  input(unmodified.screen);
  await settle();
  return { changed, unmodified };
}

describe("wheel viewport behaviour compared with unmodified xterm", () => {
  it("scrolls the viewport exactly like xterm when the app does not track the mouse", async () => {
    const { changed, unmodified } = await compareWithUnmodified("", (screen) =>
      wheel(screen, -300),
    );
    expect(viewport(changed)).toEqual(viewport(unmodified));
    expect(changed.sent).toEqual(unmodified.sent);
    expect(changed.sent).toEqual([]);
    expect(viewport(changed).viewportY).toBeLessThan(viewport(changed).baseY);
  });

  it("leaves Shift-held wheel input to xterm while the app tracks the mouse", async () => {
    const { changed, unmodified } = await compareWithUnmodified(
      "\x1b[?1000h\x1b[?1006h",
      (screen) => wheel(screen, -300, true),
    );
    expect(viewport(changed)).toEqual(viewport(unmodified));
    expect(changed.sent).toEqual(unmodified.sent);
    expect(changed.sent).toEqual([]);
  });

  it("leaves Shift-held wheel input to xterm when the app does not track the mouse", async () => {
    const { changed, unmodified } = await compareWithUnmodified("", (screen) =>
      wheel(screen, -300, true),
    );
    expect(viewport(changed)).toEqual(viewport(unmodified));
    expect(changed.sent).toEqual(unmodified.sent);
  });

  it("sends one report per line and does not move the viewport while the app tracks the mouse", async () => {
    const { changed, unmodified } = await compareWithUnmodified(
      "\x1b[?1000h\x1b[?1006h",
      (screen) => wheel(screen, -300),
    );
    const before = changed.terminal.buffer.active.baseY;
    expect(changed.sent.join("").match(WHEEL_UP)?.length).toBe(20);
    expect(unmodified.sent.join("").match(WHEEL_UP)?.length).toBe(1);
    expect(viewport(changed)).toEqual({ baseY: before, viewportY: before });
    expect(viewport(unmodified)).toEqual(viewport(changed));
  });
});
