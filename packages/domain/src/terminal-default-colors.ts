import { z } from "zod";

export const terminalRgbSchema = z.tuple([
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
]);
export const terminalDefaultColorsSchema = z
  .object({ foreground: terminalRgbSchema, background: terminalRgbSchema })
  .strict();

export type TerminalRgb = [number, number, number];

export interface TerminalDefaultColors {
  foreground: TerminalRgb;
  background: TerminalRgb;
}

function neutralSrgb(lightness: number): TerminalRgb {
  const linear = lightness ** 3;
  const channel = Math.round(
    255 *
      (linear <= 0.0031308
        ? 12.92 * linear
        : 1.055 * linear ** (1 / 2.4) - 0.055),
  );
  return [channel, channel, channel];
}

export const TERMINAL_DEFAULT_COLORS = {
  dark: {
    foreground: neutralSrgb(0.81),
    background: neutralSrgb(0.81 * 0.043 + 0.195 * (1 - 0.043)),
  },
  light: {
    foreground: neutralSrgb(0.3211),
    background: neutralSrgb(0.3211 * 0.022 + 1 * (1 - 0.022)),
  },
} satisfies Record<string, TerminalDefaultColors>;

export function terminalRgbCss(rgb: TerminalRgb): string {
  return `rgb(${rgb.join(", ")})`;
}

export function terminalColorReply(
  slot: 10 | 11,
  rgb: TerminalRgb,
  terminator: string,
): string {
  const channels = rgb
    .map((channel) => channel.toString(16).padStart(2, "0").repeat(2))
    .join("/");
  return `\x1b]${slot};rgb:${channels}${terminator}`;
}
