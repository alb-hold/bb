// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Terminal } from "@xterm/xterm";
import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import {
  buildTerminalThemeFromCssColors,
  TERMINAL_THEME_OPTIONS,
} from "./ThreadTerminalView";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../ui/theme.css"),
  "utf8",
);

function themeColor(mode: "light" | "dark", name: string): string {
  const at = css.indexOf(`color-scheme: ${mode};`);
  const block = css.slice(css.lastIndexOf("{", at), css.indexOf("}", at));
  const value = block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
  if (!value) throw new Error(`Missing ${name}`);
  const alias = value.match(/^var\((--[^)]+)\)$/);
  if (alias) return themeColor(mode, alias[1]);
  const neutral = value.match(/^oklch\(([\d.]+) 0 0\)$/);
  if (neutral) {
    const linear = Number(neutral[1]) ** 3;
    const channel = Math.round(
      255 *
        (linear <= 0.0031308
          ? 12.92 * linear
          : 1.055 * linear ** (1 / 2.4) - 0.055),
    );
    return `rgb(${channel}, ${channel}, ${channel})`;
  }
  return value;
}

function luminance(color: string): number {
  const channels = color.startsWith("#")
    ? [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16))
    : (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  expect(channels).toHaveLength(3);
  return channels.reduce((sum, channel, index) => {
    const s = channel / 255;
    return (
      sum +
      [0.2126, 0.7152, 0.0722][index] *
        (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4)
    );
  }, 0);
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it.each(["light", "dark"] as const)(
  "keeps the recorded Codex prompt echo readable in %s mode",
  async (mode) => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 9 }),
    } as unknown as CanvasRenderingContext2D);
    const terminal = new Terminal({
      ...TERMINAL_THEME_OPTIONS,
      cols: 80,
      rows: 5,
      theme: buildTerminalThemeFromCssColors((name) => themeColor(mode, name)),
    });
    const container = document.createElement("div");
    document.body.append(container);
    try {
      terminal.open(container);
      await new Promise<void>((resolve) =>
        terminal.write(
          "\x1b[0m\x1b[48;5;8m\x1b[K\x1b[1m\x1b[2m› \x1b[22m\x1b[22mReply with exactly LIGHT-PROMPT-CHECK.\x1b[0m",
          resolve,
        ),
      );
      await waitFor(() =>
        expect(container.querySelector(".xterm-rows")?.textContent).toContain(
          "LIGHT-PROMPT-CHECK",
        ),
      );
      const span = Array.from(
        container.querySelectorAll(".xterm-rows span"),
      ).find((element) => element.textContent?.includes("LIGHT-PROMPT-CHECK"));
      expect(span).toBeDefined();
      const style = getComputedStyle(span!);
      const fg = luminance(style.color);
      const bg = luminance(style.backgroundColor);
      expect(bg).toBe(luminance(themeColor(mode, "--ansi-8")));
      const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      console.log(
        `${mode}: foreground=${style.color} background=${themeColor(mode, "--ansi-8")} contrast=${ratio}`,
      );
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    } finally {
      terminal.dispose();
    }
  },
);
