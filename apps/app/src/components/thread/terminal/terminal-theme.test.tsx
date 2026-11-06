// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TERMINAL_DEFAULT_COLORS, terminalRgbCss } from "@bb/domain";
import { TerminalColorQueries } from "../../../../../host-daemon/src/terminals/terminal-color-queries.js";
import { Terminal } from "@xterm/xterm";
import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import {
  buildTerminalThemeFromCssColors,
  TERMINAL_THEME_OPTIONS,
  TERMINAL_CELL_OPTIONS,
  attachTerminalInputForwarding,
  forwardTerminalData,
} from "./ThreadTerminalView";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../ui/theme.css"),
  "utf8",
);

function themeColor(mode: "light" | "dark", name: string): string {
  const at = css.indexOf(`color-scheme: ${mode};`);
  const block = css.slice(css.lastIndexOf("{", at), css.indexOf("}", at));
  let value = block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
  if (!value && name === "--muted")
    value = "color-mix(in oklch, var(--ink) 11%, var(--canvas))";
  if (!value) throw new Error(`Missing ${name}`);
  const mix = value.match(
    /^color-mix\(in oklch, var\((--[^)]+)\) ([\d.]+)%, var\((--[^)]+)\)\)$/,
  );
  if (mix) {
    const lightness = (token: string) =>
      Number(block.match(new RegExp(`${token}: oklch\\(([\\d.]+)`))?.[1]);
    const weight = Number(mix[2]) / 100;
    value = `oklch(${lightness(mix[1]) * weight + lightness(mix[3]) * (1 - weight)} 0 0)`;
  }
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

function luminance(color: string, background?: string): number {
  const channels = color.startsWith("#")
    ? [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16))
    : (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  if (background && color.startsWith("rgba")) {
    const alpha = Number(color.match(/[\d.]+/g)?.[3] ?? 1);
    const base = (background.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    channels.forEach((channel, index) => {
      channels[index] = channel * alpha + base[index] * (1 - alpha);
    });
  }
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

it.each(
  (["light", "dark"] as const).flatMap((mode) =>
    ["\x07", "\x1b\\"].map((terminator) => ({ mode, terminator })),
  ),
)(
  "forwards $mode theme OSC 10/11 with $terminator, suppressing historical queries",
  async ({ mode, terminator }) => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 9 }),
    } as unknown as CanvasRenderingContext2D);
    const terminal = new Terminal({
      ...TERMINAL_THEME_OPTIONS,
      ...TERMINAL_CELL_OPTIONS,
      theme: buildTerminalThemeFromCssColors((name) =>
        name.startsWith("--terminal-scrollbar")
          ? undefined
          : themeColor(mode, name),
      ),
    });
    const container = document.createElement("div");
    document.body.append(container);
    terminal.open(container);
    const onInput = vi.fn();
    const replayWriteState = { suppressedWriteCount: 0 };
    const subscription = attachTerminalInputForwarding({
      terminal,
      onData: (data, isUserInput) =>
        forwardTerminalData({
          data,
          isUserInput,
          onInput,
          replayWriteState,
          sessionStatus: "running",
        }),
    });
    const query = `\x1b]10;?${terminator}\x1b]11;?${terminator}`;
    try {
      await new Promise<void>((resolve) => terminal.write(query, resolve));
      const replies = onInput.mock.calls.map(([data]) => atob(data));
      const rgb = (name: string) =>
        (themeColor(mode, name).match(/\d+/g) ?? [])
          .map((channel) =>
            Number(channel).toString(16).padStart(2, "0").repeat(2),
          )
          .join("/");
      expect(replies).toEqual([
        `\x1b]10;rgb:${rgb("--foreground")}\x1b\\`,
        `\x1b]11;rgb:${rgb("--sidebar")}\x1b\\`,
      ]);
      const palette = TERMINAL_DEFAULT_COLORS[mode];
      expect(terminalRgbCss(palette.foreground)).toBe(
        themeColor(mode, "--foreground"),
      );
      expect(terminalRgbCss(palette.background)).toBe(
        themeColor(mode, "--sidebar"),
      );
      const hostReplies: string[] = [];
      new TerminalColorQueries(palette).push(query, (reply) => {
        hostReplies.push(reply);
      });
      expect(hostReplies).toEqual(replies);
      expect(onInput.mock.calls.every(([, , user]) => user === false)).toBe(
        true,
      );
      onInput.mockClear();
      replayWriteState.suppressedWriteCount = 1;
      await new Promise<void>((resolve) => terminal.write(query, resolve));
      expect(onInput).not.toHaveBeenCalled();
    } finally {
      subscription.dispose();
      terminal.dispose();
    }
  },
);

it("uses stable readable cells and a steady block cursor across renderer handoffs", () => {
  expect(TERMINAL_CELL_OPTIONS).toEqual({
    lineHeight: 1.12,
    cursorBlink: false,
    cursorStyle: "block",
  });
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
      theme: buildTerminalThemeFromCssColors((name) =>
        name.startsWith("--terminal-scrollbar")
          ? undefined
          : themeColor(mode, name),
      ),
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

it("derives brighter dark ANSI grey from the ink and canvas tokens", () => {
  const dark = css.slice(css.indexOf(".dark {"));
  expect(dark).toContain(
    "--ansi-8: color-mix(in oklch, var(--ink) 70%, var(--canvas))",
  );
});

it.each([
  ["light", "\x1b[2m"],
  ["dark", "\x1b[2m"],
  ["light", "\x1b[2;31m"],
  ["dark", "\x1b[2;31m"],
] as const)(
  "keeps faint output readable in %s mode (%s)",
  async (mode, sgr) => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 9 }),
    } as unknown as CanvasRenderingContext2D);
    const background = themeColor(mode, "--sidebar");
    const terminal = new Terminal({
      ...TERMINAL_THEME_OPTIONS,
      cols: 40,
      rows: 2,
      theme: buildTerminalThemeFromCssColors((name) =>
        name.startsWith("--terminal-scrollbar")
          ? undefined
          : themeColor(mode, name),
      ),
    });
    const container = document.createElement("div");
    document.body.append(container);
    try {
      terminal.open(container);
      await new Promise<void>((resolve) =>
        terminal.write(`${sgr}faint-path\x1b[0m`, resolve),
      );
      await waitFor(() =>
        expect(container.querySelector(".xterm-rows")?.textContent).toContain(
          "faint-path",
        ),
      );
      const span = Array.from(
        container.querySelectorAll(".xterm-rows span"),
      ).find((node) => node.textContent?.includes("faint-path"))!;
      const fg = luminance(getComputedStyle(span).color, background);
      const bg = luminance(background);
      expect(
        (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05),
      ).toBeGreaterThanOrEqual(4.5);
    } finally {
      terminal.dispose();
    }
  },
);

it.each(["light", "dark"] as const)(
  "keeps bright black distinct and readable in %s mode",
  (mode) => {
    const fg = luminance(themeColor(mode, "--ansi-8"));
    const bg = luminance(themeColor(mode, "--sidebar"));
    const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    console.log(`${mode} bright black contrast=${ratio}`);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(themeColor(mode, "--ansi-8")).not.toBe(
      themeColor(mode, "--foreground"),
    );
  },
);
