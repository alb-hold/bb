// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTerminalLongPress } from "./terminal-mobile-gestures";
import { createTerminalTouchHandlers } from "./ThreadTerminalView";

const CELL_WIDTH_PX = 8;
const CELL_HEIGHT_PX = 15;
const COLS = 80;
const ROWS = 24;
const PRESS = /\x1b\[<0;(?:\d+|NaN);(?:\d+|NaN)M/g;
const RELEASE = /\x1b\[<0;(?:\d+|NaN);(?:\d+|NaN)m/g;
const WHEEL = /\x1b\[<6[45];(?:\d+|NaN);(?:\d+|NaN)M/g;

interface TouchPoint {
  x: number;
  y: number;
}

interface Opened {
  screen: HTMLElement;
  wrapper: HTMLElement;
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

function openTerminal(withTouchHandlers: boolean): Opened {
  const wrapper = document.createElement("div");
  const host = document.createElement("div");
  wrapper.append(host);
  document.body.append(wrapper);
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 500 });
  terminal.open(host);
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
  let cancelTouchHandlers = () => {};
  if (withTouchHandlers) {
    const handlers = createTerminalTouchHandlers({ current: terminal });
    cancelTouchHandlers = handlers.cancel;
    wrapper.addEventListener("touchstart", (event) =>
      handlers.start(event as TouchEvent),
    );
    wrapper.addEventListener("touchmove", (event) =>
      handlers.move(event as TouchEvent),
    );
    wrapper.addEventListener("touchend", (event) =>
      handlers.end(event as TouchEvent),
    );
    wrapper.addEventListener("touchcancel", () => handlers.cancel());
  }
  const sent: string[] = [];
  terminal.onData((data) => sent.push(data));
  disposers.push(() => {
    cancelTouchHandlers();
    terminal.dispose();
    wrapper.remove();
  });
  return { screen, wrapper, sent, terminal };
}

function dispatchTouch(
  target: HTMLElement,
  type: "touchstart" | "touchmove" | "touchend",
  point: TouchPoint,
  timeStamp: number,
): void {
  const touch = {
    clientX: point.x,
    clientY: point.y,
    identifier: 1,
    pageX: point.x,
    pageY: point.y,
    target,
  };
  const touchList = (items: (typeof touch)[]) =>
    Object.assign([...items], { item: (index: number) => items[index] });
  const active = touchList(type === "touchend" ? [] : [touch]);
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: active });
  Object.defineProperty(event, "targetTouches", { value: active });
  Object.defineProperty(event, "changedTouches", { value: touchList([touch]) });
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  target.dispatchEvent(event);
}

function tap(
  screen: HTMLElement,
  point: TouchPoint,
  holdMs = 80,
  startAt = 1_000,
): void {
  dispatchTouch(screen, "touchstart", point, startAt);
  dispatchTouch(screen, "touchend", point, startAt + holdMs);
}

function swipe(screen: HTMLElement, from: TouchPoint, dy: number): void {
  dispatchTouch(screen, "touchstart", from, 2_000);
  for (let step = 1; step <= 6; step += 1) {
    dispatchTouch(
      screen,
      "touchmove",
      { x: from.x, y: from.y + (dy * step) / 6 },
      2_000 + step * 16,
    );
  }
  dispatchTouch(screen, "touchend", { x: from.x, y: from.y + dy }, 2_120);
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function count(sent: string[], pattern: RegExp): number {
  return sent.join("").match(pattern)?.length ?? 0;
}

describe("terminal touch flow with mouse tracking on", () => {
  async function trackingTerminal(): Promise<Opened> {
    stubMeasurements();
    const opened = openTerminal(true);
    await write(opened.terminal, "\x1b[?1000h\x1b[?1006h");
    return opened;
  }

  it("sends exactly one press and one release for a short tap", async () => {
    const { screen, sent } = await trackingTerminal();
    tap(screen, { x: 40, y: 40 });
    expect(count(sent, PRESS)).toBe(1);
    expect(count(sent, RELEASE)).toBe(1);
  });

  it("sends no click for a swipe and leaves the swipe to xterm", async () => {
    const { screen, sent } = await trackingTerminal();
    swipe(screen, { x: 40, y: 200 }, -150);
    expect(count(sent, PRESS)).toBe(0);
    expect(count(sent, RELEASE)).toBe(0);
    expect(count(sent, WHEEL)).toBeGreaterThan(0);
  });

  it("sends no click for a long press", async () => {
    const { screen, sent } = await trackingTerminal();
    tap(screen, { x: 40, y: 40 }, 1_000);
    expect(count(sent, PRESS)).toBe(0);
    expect(sent).toEqual([]);
  });

  it("sends nothing for a tap outside the grid", async () => {
    const { screen, sent } = await trackingTerminal();
    tap(screen, { x: 40, y: ROWS * CELL_HEIGHT_PX + 30 });
    expect(sent).toEqual([]);
  });
});

describe("terminal touch flow with mouse tracking off", () => {
  it("sends nothing for a tap", () => {
    stubMeasurements();
    const { screen, sent } = openTerminal(true);
    tap(screen, { x: 40, y: 40 });
    expect(sent).toEqual([]);
  });

  it("scrolls a swipe without sending terminal input", async () => {
    stubMeasurements();
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index}`);
    const withHandlers = openTerminal(true);
    await write(withHandlers.terminal, lines.join("\r\n"));
    swipe(withHandlers.wrapper, { x: 40, y: 200 }, -150);
    expect(withHandlers.sent).toEqual([]);
    expect(withHandlers.terminal.buffer.active.viewportY).toBeLessThan(
      withHandlers.terminal.buffer.active.baseY,
    );
  });

  it("scrolls touchmove distance before the long-press selection delay", async () => {
    stubMeasurements();
    const { wrapper, terminal } = openTerminal(true);
    await write(
      terminal,
      Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\r\n"),
    );
    const startY = terminal.buffer.active.viewportY;
    const sheetOpened = vi.fn();
    let fireLongPress = () => {};
    const longPress = startTerminalLongPress(
      [{ identifier: 1, x: 40, y: 200 }],
      () => 0,
      sheetOpened,
      (callback) => {
        fireLongPress = callback;
        return { cancel: vi.fn() };
      },
    );
    dispatchTouch(wrapper, "touchstart", { x: 40, y: 200 }, 2_000);
    for (let step = 1; step <= 6; step += 1) {
      const point = { x: 40, y: 200 - (150 * step) / 6 };
      dispatchTouch(wrapper, "touchmove", point, 2_000 + step * 50);
      longPress.move([{ identifier: 1, ...point }]);
    }
    fireLongPress();
    dispatchTouch(wrapper, "touchend", { x: 40, y: 50 }, 2_400);

    const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
    if (screen === null || screen === undefined) {
      throw new Error("xterm screen element missing");
    }
    const rowHeight = screen.getBoundingClientRect().height / terminal.rows;
    const expectedRows = Math.round(150 / rowHeight);
    const rowsMoved = startY - terminal.buffer.active.viewportY;

    expect(Math.abs(rowsMoved - expectedRows)).toBeLessThanOrEqual(1);
    expect(sheetOpened).not.toHaveBeenCalled();
  });
});
