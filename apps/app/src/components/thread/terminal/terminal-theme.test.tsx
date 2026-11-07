// @vitest-environment jsdom

import { transform, Features } from "lightningcss";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TERMINAL_DEFAULT_COLORS,
  terminalRgbCss,
  TerminalColorQueries,
} from "@bb/domain";
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
  if (!value)
    value = css
      .slice(css.lastIndexOf(":root {"))
      .match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]
      .trim();
  if (!value && name === "--muted")
    value = "color-mix(in oklch, var(--ink) 11%, var(--canvas))";
  if (!value) throw new Error(`Missing ${name}`);
  const resolve = (input: string): string =>
    input.replace(/var\((--[^)]+)\)/g, (_, token: string) =>
      themeColor(mode, token),
    );
  value = resolve(value);
  if (value.startsWith("color-mix")) {
    const output = transform({
      filename: "terminal.css",
      code: Buffer.from(`a { color: ${value}; }`),
      include: Features.Colors,
    }).code.toString();
    value = output.match(/color: (#[0-9a-f]+);/)?.[1] ?? value;
  }
  if (/^#[0-9a-f]{6}$/.test(value))
    return `rgb(${[1, 3, 5].map((at) => parseInt(value!.slice(at, at + 2), 16)).join(", ")})`;
  if (/^#[0-9a-f]{3}$/.test(value))
    return `rgb(${[1, 2, 3].map((at) => parseInt(value![at].repeat(2), 16)).join(", ")})`;

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
  expect(TERMINAL_THEME_OPTIONS.minimumContrastRatio).toBeGreaterThanOrEqual(
    4.5,
  );
  expect(TERMINAL_CELL_OPTIONS).toEqual({
    lineHeight: 1.22,
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
      expect(bg).toBe(luminance(themeColor(mode, "--terminal-ansi-8")));
      const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      console.log(
        `${mode}: foreground=${style.color} background=${themeColor(mode, "--terminal-ansi-8")} contrast=${ratio}`,
      );
      expect(ratio).toBeGreaterThanOrEqual(4.5);
      if (mode === "dark") {
        const canvas = luminance(themeColor(mode, "--sidebar"));
        const bandContrast = (bg + 0.05) / (canvas + 0.05);
        expect(bandContrast).toBeGreaterThanOrEqual(1.5);
        expect(bandContrast).toBeLessThanOrEqual(1.6);
      }
    } finally {
      terminal.dispose();
    }
  },
);

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
  "keeps rendered bright-black text readable in %s mode",
  async (mode) => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 9 }),
    } as unknown as CanvasRenderingContext2D);
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
        terminal.write("\x1b[38;5;8msecondary-text\x1b[0m", resolve),
      );
      await waitFor(() =>
        expect(container.querySelector(".xterm-rows")?.textContent).toContain(
          "secondary-text",
        ),
      );
      const span = Array.from(
        container.querySelectorAll(".xterm-rows span"),
      ).find((node) => node.textContent?.includes("secondary-text"))!;
      const fg = luminance(getComputedStyle(span).color);
      const bg = luminance(themeColor(mode, "--sidebar"));
      const textContrast =
        (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      const band = luminance(themeColor(mode, "--terminal-ansi-8"));
      const bandContrast =
        (Math.max(band, bg) + 0.05) / (Math.min(band, bg) + 0.05);
      console.log(
        `${mode} bright-black: text=${getComputedStyle(span).color}, raw=${themeColor(mode, "--terminal-ansi-8")}, background=${themeColor(mode, "--sidebar")}, text contrast=${textContrast}, band contrast=${bandContrast}`,
      );
      expect(TERMINAL_THEME_OPTIONS.minimumContrastRatio).toBe(7);
      expect(textContrast).toBeGreaterThanOrEqual(7);
    } finally {
      terminal.dispose();
    }
  },
);

it("derives the full terminal palette from theme ink and canvas", () => {
  const names = new Set<string>();
  const theme = buildTerminalThemeFromCssColors((name) => {
    names.add(name);
    return name;
  });
  expect(theme.background).toBe("--sidebar");
  expect(theme.foreground).toBe("--foreground");
  for (let index = 0; index < 16; index++) {
    expect(names.has(`--terminal-ansi-${index}`)).toBe(true);
    const declaration = css.match(
      new RegExp(`--terminal-ansi-${index}:\\s*([^;]+);`),
    )?.[1];
    expect(declaration).toMatch(/var\(--(?:ink|canvas)\)/);
  }
});

it.each(["light", "dark"] as const)(
  "answers OSC 4 with the rendered %s turn-band palette entry",
  async (mode) => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 9 }),
    } as unknown as CanvasRenderingContext2D);
    const terminal = new Terminal({
      theme: buildTerminalThemeFromCssColors((name) =>
        name.startsWith("--terminal-scrollbar")
          ? undefined
          : themeColor(mode, name),
      ),
    });
    const container = document.createElement("div");
    document.body.append(container);
    terminal.open(container);
    const replies: string[] = [];
    terminal.onData((reply) => replies.push(reply));
    try {
      await new Promise<void>((resolve) =>
        terminal.write("\x1b]4;8;?\x07", resolve),
      );
      const rgb = (themeColor(mode, "--terminal-ansi-8").match(/\d+/g) ?? [])
        .map((c) => Number(c).toString(16).padStart(2, "0").repeat(2))
        .join("/");
      expect(replies).toEqual([`\x1b]4;8;rgb:${rgb}\x1b\\`]);
    } finally {
      terminal.dispose();
    }
  },
);

it("keeps light ANSI black darker than white with readable opposite colours", () => {
  const theme = buildTerminalThemeFromCssColors((name) =>
    name.startsWith("--terminal-scrollbar")
      ? undefined
      : themeColor("light", name),
  );
  const black = luminance(theme.black!);
  for (const whiteColor of [theme.white!, theme.brightWhite!]) {
    const white = luminance(whiteColor);
    expect(black).toBeLessThan(white);
    expect((white + 0.05) / (black + 0.05)).toBeGreaterThanOrEqual(4.5);
  }
});
