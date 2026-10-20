import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalPinchGesture,
  startTerminalLongPress,
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
    let fontSize = 12;
    const setFontSize = vi.fn((size: number) => {
      fontSize = size;
    });
    const fitAndResize = vi.fn();
    const pinch = createTerminalPinchGesture({
      getFontSize: () => fontSize,
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

    expect(fontSize).toBe(20);
    expect(fitAndResize).not.toHaveBeenCalled();
    pinch.end();

    expect(fitAndResize).toHaveBeenCalledOnce();
  });

  it("zooms out and clamps both ends of the supported font range", () => {
    let fontSize = 12;
    const apply = (startSize: number, scale: number) => {
      fontSize = startSize;
      const pinch = createTerminalPinchGesture({
        getFontSize: () => fontSize,
        setFontSize: (size) => {
          fontSize = size;
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
      return fontSize;
    };

    expect(apply(12, 0.5)).toBe(8);
    expect(apply(12, 3)).toBe(28);
  });
});
