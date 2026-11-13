import { describe, expect, it, vi } from "vitest";
import { createStickyRowStateReporter } from "./stickyOffset.js";

describe("sticky row height reports", () => {
  it("keeps another reporter's height when one reporter is removed", () => {
    const heights = new Map<string, number>();
    const setHeight = vi.fn();
    const reporter = createStickyRowStateReporter(heights, setHeight);

    reporter.report("row-a", 34.5);
    reporter.report("row-b", 42);
    expect(heights).toEqual(
      new Map([
        ["row-a", 34.5],
        ["row-b", 42],
      ]),
    );
    reporter.remove("row-a");
    expect(heights).toEqual(new Map([["row-b", 42]]));
    expect(setHeight).toHaveBeenLastCalledWith(42);
    reporter.report("row-b", 36);
    reporter.remove("row-b");
    expect(heights).toEqual(new Map());
    expect(setHeight).toHaveBeenLastCalledWith(0);
  });
});
