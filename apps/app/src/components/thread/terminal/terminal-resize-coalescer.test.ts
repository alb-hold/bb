import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalResizeCoalescer } from "./terminal-resize-coalescer";

describe("createTerminalResizeCoalescer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fits and resizes once after a 500 ms geometry burst settles", () => {
    vi.useFakeTimers();
    const fit = vi.fn();
    const resize = vi.fn();
    let settled = false;
    const coalescer = createTerminalResizeCoalescer({
      isSettled: () => settled,
      onSettled: () => {
        fit();
        resize();
      },
      quietPeriodMs: 120,
    });

    for (let elapsed = 0; elapsed <= 500; elapsed += 16) {
      vi.advanceTimersByTime(16);
      coalescer.schedule();
    }
    settled = true;
    vi.advanceTimersByTime(119);
    expect(fit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(fit).toHaveBeenCalledOnce();
    expect(resize).toHaveBeenCalledOnce();
    coalescer.cancel();
  });

  it("waits for animated geometry and can be cancelled on unmount", () => {
    vi.useFakeTimers();
    const fit = vi.fn();
    let settled = false;
    const coalescer = createTerminalResizeCoalescer({
      isSettled: () => settled,
      onSettled: fit,
      quietPeriodMs: 100,
    });

    coalescer.schedule();
    vi.advanceTimersByTime(100);
    expect(fit).not.toHaveBeenCalled();
    coalescer.cancel();
    settled = true;
    vi.advanceTimersByTime(1_000);

    expect(fit).not.toHaveBeenCalled();
  });
});
