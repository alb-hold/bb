// @vitest-environment jsdom
import { applyAppThemeCss } from "@/lib/app-theme-css";
import { afterEach, expect, it, vi } from "vitest";
import {
  readTerminalFontMetrics,
  resolveTerminalFontFamily,
} from "./terminal-font";

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.classList.remove("p85-metrics");
  document.documentElement.style.removeProperty("--font-terminal");
  vi.restoreAllMocks();
});

it.each([360, 390, 1280])(
  "reads mono family, size and weight at %i px",
  (width) => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
    document.documentElement.style.setProperty(
      "--font-terminal",
      "Test Mono, monospace",
    );
    const style = document.createElement("style");
    style.textContent =
      ".text-terminal { font-size: 15px; } .font-normal { font-weight: 450; }";
    document.body.append(style);
    expect(readTerminalFontMetrics()).toEqual({
      fontFamily: "Test Mono, monospace",
      fontSize: 15,
      fontWeight: 450,
    });
    expect(document.body.children).toHaveLength(1);
  },
);

it("keeps the terminal Nerd Font glyph coverage", () => {
  const family = resolveTerminalFontFamily((name) =>
    name === "--font-terminal"
      ? '\"JetBrainsMono Nerd Font Mono\", \"MesloLGS NF\", \"Symbols Nerd Font Mono\", monospace'
      : "monospace",
  );
  expect(family).toContain("JetBrainsMono Nerd Font Mono");
  expect(family).toContain("MesloLGS NF");
  expect(family).toContain("Symbols Nerd Font Mono");
});

it("remeasures cached metrics only after viewport class or theme epoch changes", () => {
  document.documentElement.classList.add("p85-metrics");
  const width = vi.spyOn(window, "innerWidth", "get").mockReturnValue(1280);
  const style = document.createElement("style");
  style.textContent =
    ".text-terminal { font-size: 15px; } .font-normal { font-weight: 450; }";
  document.body.append(style);
  const append = vi.spyOn(document.body, "append");
  expect(readTerminalFontMetrics().fontSize).toBe(15);
  expect(readTerminalFontMetrics().fontWeight).toBe(450);
  expect(append).toHaveBeenCalledTimes(1);
  style.textContent =
    ".text-terminal { font-size: 16px; } .font-normal { font-weight: 450; }";
  width.mockReturnValue(390);
  expect(readTerminalFontMetrics().fontSize).toBe(16);
  expect(append).toHaveBeenCalledTimes(2);
  style.textContent =
    ".text-terminal { font-size: 16px; } .font-normal { font-weight: 500; }";
  applyAppThemeCss(".p85-theme-epoch {}");
  expect(readTerminalFontMetrics().fontWeight).toBe(500);
  expect(append).toHaveBeenCalledTimes(3);
});

it.each([
  [360, 15],
  [390, 15],
  [1280, 14],
])("uses terminal typography at %i px", (width, size) => {
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
  document.documentElement.className = `terminal-size-${width}`;
  const style = document.createElement("style");
  style.textContent = `.text-terminal { font-size: ${width < 768 ? 15 : 14}px; }`;
  document.body.append(style);
  expect(readTerminalFontMetrics().fontSize).toBe(size);
  document.documentElement.className = "";
});
