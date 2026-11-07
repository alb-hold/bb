export const TERMINAL_FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "MesloLGS NF", "Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

export function resolveTerminalFontFamily(
  get: (name: string) => string | undefined,
): string {
  return get("--font-mono")?.trim() || TERMINAL_FONT_FAMILY;
}

export function readTerminalFontFamily(): string {
  if (typeof document === "undefined") return TERMINAL_FONT_FAMILY;
  return resolveTerminalFontFamily((name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name),
  );
}

export const TERMINAL_LINE_HEIGHT = 1.22;

export function readTerminalFontMetrics() {
  if (typeof document === "undefined")
    return { fontFamily: TERMINAL_FONT_FAMILY, fontSize: 13, fontWeight: 400 };
  const probe = document.createElement("span");
  probe.className = "font-mono text-sm font-normal";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const fontSize = parseFloat(style.fontSize) || 13;
  const fontWeight = Number(style.fontWeight) || 400;
  probe.remove();
  return { fontFamily: readTerminalFontFamily(), fontSize, fontWeight };
}
