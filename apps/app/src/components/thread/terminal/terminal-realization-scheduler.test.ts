import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalRealizationScheduler } from "./terminal-realization-scheduler";

describe("TerminalRealizationScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("realizes a prioritized terminal first and spreads work over frames", () => {
    vi.useFakeTimers();
    const realized: string[] = [];
    const scheduler = new TerminalRealizationScheduler({
      cancelFrame: clearTimeout,
      requestFrame: (callback) => Number(setTimeout(callback, 16)),
    });
    scheduler.schedule(() => realized.push("background-1"));
    scheduler.schedule(() => realized.push("focused"), true);
    scheduler.schedule(() => realized.push("background-2"));

    vi.advanceTimersByTime(16);
    expect(realized).toEqual(["focused"]);
    vi.advanceTimersByTime(16);
    expect(realized).toEqual(["focused", "background-1"]);
    vi.advanceTimersByTime(16);
    expect(realized).toEqual(["focused", "background-1", "background-2"]);
  });

  it("does not realize an unmounted terminal", () => {
    vi.useFakeTimers();
    const realized = vi.fn();
    const scheduler = new TerminalRealizationScheduler({
      cancelFrame: clearTimeout,
      requestFrame: (callback) => Number(setTimeout(callback, 16)),
    });
    const cancel = scheduler.schedule(realized);

    cancel();
    vi.advanceTimersByTime(16);

    expect(realized).not.toHaveBeenCalled();
  });
});
