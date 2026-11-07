import { getAppThemeEpoch } from "@/lib/app-theme-css";

export const TERMINAL_FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "MesloLGS NF", "Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

export function resolveTerminalFontFamily(
  get: (name: string) => string | undefined,
): string {
  return get("--font-terminal")?.trim() || TERMINAL_FONT_FAMILY;
}

export function readTerminalFontFamily(): string {
  if (typeof document === "undefined") return TERMINAL_FONT_FAMILY;
  return resolveTerminalFontFamily((name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name),
  );
}

export const TERMINAL_LINE_HEIGHT = 1.22;

let cachedMetrics: {
  key: string;
  fontSize: number;
  fontWeight: number;
} | null = null;

export function readTerminalFontMetrics() {
  if (typeof document === "undefined")
    return { fontFamily: TERMINAL_FONT_FAMILY, fontSize: 14, fontWeight: 400 };
  const key = `${window.innerWidth < 768}:${getAppThemeEpoch()}:${document.documentElement.className}`;
  if (cachedMetrics?.key === key)
    return {
      fontFamily: readTerminalFontFamily(),
      fontSize: cachedMetrics.fontSize,
      fontWeight: cachedMetrics.fontWeight,
    };
  const probe = document.createElement("span");
  probe.className = "font-mono text-terminal font-normal";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const fontSize =
    parseFloat(style.fontSize) || (window.innerWidth < 768 ? 15 : 14);
  const fontWeight = Number(style.fontWeight) || 400;
  probe.remove();
  cachedMetrics = { key, fontSize, fontWeight };
  return { fontFamily: readTerminalFontFamily(), fontSize, fontWeight };
}
