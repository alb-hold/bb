// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cssColorToHex } from "./terminal-search-color";

afterEach(() => vi.restoreAllMocks());

describe("terminal search highlight colour conversion", () => {
  it.each([
    ["oklab(0.8 0.02 0.08)", [221, 183, 129], "#ddb781"],
    ["color(srgb 0.91 0.69 0.16 / 0.4)", [232, 176, 41], "#e8b029"],
  ])("converts %s to opaque sRGB hex", (cssColor, channels, expected) => {
    const context = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: "",
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray([...channels, 102]),
      })),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );

    expect(cssColorToHex(cssColor)).toBe(expected);
    expect(context.fillStyle).toBe(cssColor);
  });
});
