// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalTouchHandlers,
} from "./ThreadTerminalView";
import { createTerminalTouchViewportSaveScheduler } from "./terminal-viewport";

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
const maxTouchPointsDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "maxTouchPoints",
);

afterEach(() => {
  while (disposers.length > 0) {
    disposers.pop()?.();
  }
  if (maxTouchPointsDescriptor === undefined) {
    Reflect.deleteProperty(navigator, "maxTouchPoints");
  } else {
    Object.defineProperty(
      navigator,
      "maxTouchPoints",
      maxTouchPointsDescriptor,
    );
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
  Object.defineProperty(navigator, "maxTouchPoints", {
    configurable: true,
    value: 1,
  });
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
  return { screen, sent, terminal, wrapper };
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
    withHandlers.terminal.scrollToLine(
      withHandlers.terminal.buffer.active.baseY - 20,
    );
    const startViewportY = withHandlers.terminal.buffer.active.viewportY;
    swipe(withHandlers.screen, { x: 40, y: 200 }, -150);
    expect(withHandlers.sent).toEqual([]);
    expect(withHandlers.terminal.buffer.active.viewportY).toBeGreaterThan(
      startViewportY,
    );
  });

  it("keeps the eight-move drag on xterm native scrolling", async () => {
    stubMeasurements();
    const { screen, terminal } = openTerminal(true);
    await write(
      terminal,
      Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\r\n"),
    );
    terminal.scrollToLine(terminal.buffer.active.baseY - 100);
    const scrollToLine = vi.spyOn(terminal, "scrollToLine");
    const startViewportY = terminal.buffer.active.viewportY;
    let nativeMoves = 0;
    screen.addEventListener("-xterm-gesturechange", () => {
      nativeMoves += 1;
    });
    let now = 2_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    dispatchTouch(screen, "touchstart", { x: 40, y: 350 }, 2_000);
    for (let step = 1; step <= 8; step += 1) {
      now += 40;
      dispatchTouch(
        screen,
        "touchmove",
        { x: 40, y: 350 - (300 * step) / 8 },
        2_000 + step * 40,
      );
    }

    const rowsMoved = terminal.buffer.active.viewportY - startViewportY;
    const expectedRows = Math.round(300 / CELL_HEIGHT_PX);
    expect(nativeMoves).toBe(8);
    expect(Math.abs(rowsMoved - expectedRows)).toBeLessThanOrEqual(1);
    now += 40;
    dispatchTouch(screen, "touchend", { x: 40, y: 50 }, 2_360);
    expect(scrollToLine).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 350));
  });

  it("saves a native touch scroll when xterm changes viewport without onScroll", async () => {
    stubMeasurements();
    const { screen, terminal, wrapper } = openTerminal(true);
    await write(
      terminal,
      Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\r\n"),
    );
    const onScrollCallback = vi.fn();
    Object.defineProperty(terminal, "onScroll", {
      configurable: true,
      value: () => ({ dispose: () => undefined }),
    });
    terminal.onScroll(onScrollCallback);
    const pendingFrames = new Map<number, () => void>();
    let nextFrame = 0;
    const save = vi.fn();
    const scheduler = createTerminalTouchViewportSaveScheduler({
      getViewportY: () => terminal.buffer.active.viewportY,
      requestFrame: (callback) => {
        const id = ++nextFrame;
        pendingFrames.set(id, callback);
        return id;
      },
      cancelFrame: (id) => pendingFrames.delete(id),
      save,
    });
    wrapper.addEventListener("touchmove", () => scheduler.schedule(), {
      capture: true,
      passive: true,
    });

    const before = terminal.buffer.active.viewportY;
    swipe(screen, { x: 40, y: 100 }, 150);
    [...pendingFrames.values()].forEach((callback) => callback());

    expect(terminal.buffer.active.viewportY).not.toBe(before);
    expect(onScrollCallback).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
    scheduler.dispose();
  });
});
