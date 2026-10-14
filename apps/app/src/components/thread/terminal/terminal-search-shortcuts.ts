import { isMacKeyboardPlatform } from "@bb/domain";

export type TerminalSearchShortcut = "open" | "next" | "previous" | null;

export function getTerminalSearchShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
  >,
  platform: string,
  searchOpen: boolean,
): TerminalSearchShortcut {
  if (event.altKey) return null;
  const isMac = isMacKeyboardPlatform(platform);
  const key = event.key.toLowerCase();
  if (isMac) {
    if (!event.metaKey || event.ctrlKey) return null;
    if (key === "f" && !event.shiftKey) return "open";
    if (searchOpen && key === "g") return event.shiftKey ? "previous" : "next";
    return null;
  }
  return key === "f" && event.ctrlKey && event.shiftKey && !event.metaKey
    ? "open"
    : null;
}
