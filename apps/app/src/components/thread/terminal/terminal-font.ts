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
