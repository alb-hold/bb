import type { Terminal as XTermTerminal } from "@xterm/xterm";

interface AttachTerminalCopyShortcutArgs {
  copy: (text: string) => void;
  onOtherKey?: (event: KeyboardEvent) => boolean;
  terminal: Pick<XTermTerminal, "attachCustomKeyEventHandler" | "getSelection">;
}

function isCopyChord(event: KeyboardEvent): boolean {
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) {
    return false;
  }
  return /^[a-z]$/iu.test(event.key)
    ? event.key.toLowerCase() === "c"
    : event.code === "KeyC";
}

export function attachTerminalCopyShortcut({
  copy,
  onOtherKey,
  terminal,
}: AttachTerminalCopyShortcutArgs): void {
  terminal.attachCustomKeyEventHandler((event) => {
    if (!isCopyChord(event)) {
      return onOtherKey === undefined ? true : onOtherKey(event);
    }
    event.preventDefault();
    event.stopPropagation();
    const selection = terminal.getSelection();
    if (event.type === "keydown" && selection.length > 0) {
      copy(selection);
    }
    return false;
  });
}
