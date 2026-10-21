import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalPinchGesture,
  startTerminalLongPress,
  terminalFontSizeForPinch,
} from "./terminal-mobile-gestures";

describe("terminal touch selection", () => {
  afterEach(() => vi.useRealTimers());

  it("opens selection at the line pressed after a stationary long press", () => {
    vi.useFakeTimers();
    const openSelection = vi.fn();
    const gesture = startTerminalLongPress(
      [{ identifier: 1, x: 20, y: 48 }],
      (touch) => Math.floor(touch.y / 12),
      openSelection,
      (callback, delay) => {
        const timer = setTimeout(callback, delay);
        return { cancel: () => clearTimeout(timer) };
      },
    );

    vi.advanceTimersByTime(500);

    expect(openSelection).toHaveBeenCalledExactlyOnceWith(4);
    gesture.cancel();
  });

  it("keeps one-finger scrolling available by canceling selection after movement", () => {
    vi.useFakeTimers();
    const openSelection = vi.fn();
    const gesture = startTerminalLongPress(
      [{ identifier: 1, x: 20, y: 48 }],
      () => 4,
      openSelection,
      (callback, delay) => {
        const timer = setTimeout(callback, delay);
        return { cancel: () => clearTimeout(timer) };
      },
    );

    gesture.move([{ identifier: 1, x: 20, y: 70 }]);
    vi.advanceTimersByTime(500);

    expect(openSelection).not.toHaveBeenCalled();
  });
});

describe("terminal pinch zoom", () => {
  it("zooms in and sends one resize after the gesture ends", () => {
    let zoomLevel = 12;
    const setFontSize = vi.fn((size: number) => {
      zoomLevel = size;
    });
    const fitAndResize = vi.fn();
    const pinch = createTerminalPinchGesture({
      getFontSize: () => zoomLevel,
      setFontSize,
      fitAndResize,
    });
    pinch.start([
      { identifier: 1, x: 0, y: 0 },
      { identifier: 2, x: 100, y: 0 },
    ]);
    pinch.move([
      { identifier: 1, x: 0, y: 0 },
      { identifier: 2, x: 150, y: 0 },
    ]);
    pinch.move([
      { identifier: 1, x: 0, y: 0 },
      { identifier: 2, x: 170, y: 0 },
    ]);

    expect(Math.round(zoomLevel)).toBe(20);
    expect(fitAndResize).not.toHaveBeenCalled();
    pinch.end();

    expect(fitAndResize).toHaveBeenCalledOnce();
  });

  it("scales every pinch frame from the gesture-start font size", () => {
    let zoomLevel = 12;
    const pinch = createTerminalPinchGesture({
      getFontSize: () => zoomLevel,
      setFontSize: (size) => {
        zoomLevel = size;
      },
      fitAndResize: vi.fn(),
    });
    pinch.start([
      { identifier: 1, x: 0, y: 0 },
      { identifier: 2, x: 100, y: 0 },
    ]);
    pinch.move([
      { identifier: 1, x: 0, y: 0 },
      { identifier: 2, x: 120, y: 0 },
    ]);
    pinch.move([
      { identifier: 1, x: 0, y: 0 },
      { identifier: 2, x: 130, y: 0 },
    ]);

    expect(zoomLevel).toBeCloseTo(15.6);
    pinch.end();
    expect(zoomLevel).toBe(16);
  });

  it("zooms out and clamps both ends of the supported font range", () => {
    let zoomLevel = 12;
    const apply = (startSize: number, scale: number) => {
      zoomLevel = startSize;
      const pinch = createTerminalPinchGesture({
        getFontSize: () => zoomLevel,
        setFontSize: (size) => {
          zoomLevel = size;
        },
        fitAndResize: vi.fn(),
      });
      pinch.start([
        { identifier: 1, x: 0, y: 0 },
        { identifier: 2, x: 100, y: 0 },
      ]);
      pinch.move([
        { identifier: 1, x: 0, y: 0 },
        { identifier: 2, x: 100 * scale, y: 0 },
      ]);
      pinch.end();
      return Math.round(zoomLevel);
    };

    expect(apply(12, 0.5)).toBe(8);
    expect(apply(12, 3)).toBe(28);
  });

  it("restores the start grid after reciprocal gestures and resizes once per end", () => {
    let zoomLevel = 12;
    let fontSize = 12;
    let grid = { cols: 49, rows: 46 };
    const startGrid = grid;
    const resize = vi.fn(() => {
      grid = {
        cols: Math.floor(357 / (fontSize * 0.6)),
        rows: Math.floor(658 / (fontSize * 1.17)),
      };
    });
    const pinch = createTerminalPinchGesture({
      getFontSize: () => zoomLevel,
      setFontSize: (nextZoomLevel) => {
        zoomLevel = nextZoomLevel;
        fontSize = terminalFontSizeForPinch(nextZoomLevel, 1);
      },
      fitAndResize: resize,
    });
    const gesture = (scale: number) => {
      const resizeCount = resize.mock.calls.length;
      pinch.start([
        { identifier: 1, x: 0, y: 0 },
        { identifier: 2, x: 100, y: 0 },
      ]);
      pinch.move([
        { identifier: 1, x: 0, y: 0 },
        { identifier: 2, x: 100 * scale, y: 0 },
      ]);
      expect(resize).toHaveBeenCalledTimes(resizeCount);
      pinch.end();
      expect(resize).toHaveBeenCalledTimes(resizeCount + 1);
    };

    gesture(1.5);

    expect(fontSize).toBe(18);
    expect(grid).toEqual({ cols: 33, rows: 31 });
    expect(resize).toHaveBeenCalledOnce();

    gesture(1 / 1.5);

    expect(fontSize).toBe(12);
    expect(grid).toEqual(startGrid);
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it("returns to the exact start font and grid after uneven out-and-back moves", () => {
    let zoomLevel = 12;
    let fontSize = 12;
    const liveFontSizes: number[] = [];
    let grid = { cols: 49, rows: 46 };
    const startGrid = grid;
    const resize = vi.fn(() => {
      grid = {
        cols: Math.floor(357 / (fontSize * 0.6)),
        rows: Math.floor(658 / (fontSize * 1.17)),
      };
    });
    const pinch = createTerminalPinchGesture({
      getFontSize: () => zoomLevel,
      setFontSize: (nextZoomLevel) => {
        zoomLevel = nextZoomLevel;
        fontSize = terminalFontSizeForPinch(nextZoomLevel, 1);
        liveFontSizes.push(fontSize);
      },
      fitAndResize: resize,
    });
    pinch.start([
      { identifier: 1, x: 0, y: 0 },
      { identifier: 2, x: 100, y: 0 },
    ]);
    for (const distance of [
      108.3, 119.6, 131.2, 143.9, 150, 139.1, 128.4, 117.8, 106.2, 100,
    ]) {
      pinch.move([
        { identifier: 1, x: 0, y: 0 },
        { identifier: 2, x: distance, y: 0 },
      ]);
    }

    expect(zoomLevel).toBe(12);
    expect(liveFontSizes.some((size) => !Number.isInteger(size))).toBe(true);
    pinch.end();

    expect(fontSize).toBe(12);
    expect(grid).toEqual(startGrid);
    expect(resize).toHaveBeenCalledOnce();
  });
});
