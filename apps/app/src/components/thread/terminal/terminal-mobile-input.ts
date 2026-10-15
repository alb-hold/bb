export type TerminalNavigationKey = "left" | "down" | "up" | "right";

const ARROW_SUFFIXES = { left: "D", down: "B", up: "A", right: "C" };

export function encodeTerminalArrow(
  key: TerminalNavigationKey,
  applicationCursorKeys: boolean,
  control = false,
): string {
  if (control) return `\x1b[1;5${ARROW_SUFFIXES[key]}`;
  return `\x1b${applicationCursorKeys ? "O" : "["}${ARROW_SUFFIXES[key]}`;
}

export function applyTerminalControl(data: string): string {
  if (data.length !== 1 || !/^[a-zA-Z@\[\]\\^_?]$/u.test(data)) return data;
  return data === "?"
    ? "\x7f"
    : String.fromCharCode(data.toUpperCase().charCodeAt(0) & 0x1f);
}

export function applyTerminalControlMode(
  data: string,
  mode: "off" | "one-shot" | "locked",
): { data: string; nextMode: "off" | "one-shot" | "locked" } {
  if (mode === "off") return { data, nextMode: "off" };
  return {
    data: applyTerminalControl(data),
    nextMode: mode === "one-shot" ? "off" : "locked",
  };
}
