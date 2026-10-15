export const TERMINAL_MOBILE_FONT_STORAGE_KEY = "bb.terminal.mobile.font-size";
export const TERMINAL_MOBILE_FONT_DEFAULT = 12;
export const TERMINAL_MOBILE_FONT_MIN = 8;
export const TERMINAL_MOBILE_FONT_MAX = 28;

export function clampTerminalFontSize(size: number): number {
  return Math.max(
    TERMINAL_MOBILE_FONT_MIN,
    Math.min(TERMINAL_MOBILE_FONT_MAX, Math.round(size)),
  );
}

export function readTerminalMobileFontSize(storage: Storage): number {
  const size = Number(storage.getItem(TERMINAL_MOBILE_FONT_STORAGE_KEY));
  return Number.isFinite(size) && size > 0
    ? clampTerminalFontSize(size)
    : TERMINAL_MOBILE_FONT_DEFAULT;
}

export function writeTerminalMobileFontSize(storage: Storage, size: number): number {
  const clamped = clampTerminalFontSize(size);
  storage.setItem(TERMINAL_MOBILE_FONT_STORAGE_KEY, String(clamped));
  return clamped;
}

export function mobileKeyboardDockBottom(
  layoutHeight: number,
  offsetTop: number,
  visualHeight: number,
): number {
  return Math.max(0, Math.round(layoutHeight - offsetTop - visualHeight));
}
