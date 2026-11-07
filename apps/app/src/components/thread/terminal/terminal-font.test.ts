// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { readTerminalFontMetrics } from "./terminal-font";

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.style.removeProperty("--font-mono");
  vi.restoreAllMocks();
});

it.each([360, 390, 1280])(
  "reads mono family, size and weight at %i px",
  (width) => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
    document.documentElement.style.setProperty(
      "--font-mono",
      "Test Mono, monospace",
    );
    const style = document.createElement("style");
    style.textContent =
      ".text-sm { font-size: 15px; } .font-normal { font-weight: 450; }";
    document.body.append(style);
    expect(readTerminalFontMetrics()).toEqual({
      fontFamily: "Test Mono, monospace",
      fontSize: 15,
      fontWeight: 450,
    });
    expect(document.body.children).toHaveLength(1);
  },
);
