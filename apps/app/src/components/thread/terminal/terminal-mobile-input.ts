export type TerminalNavigationKey = "left" | "down" | "up" | "right";

export function suppressDuplicateTerminalCompositionInput(
  element: HTMLElement,
): { dispose: () => void } {
  let composing = false;
  let pendingText = "";
  let pendingTextTimeout: ReturnType<typeof setTimeout> | null = null;
  const clearPendingTextTimeout = () => {
    if (pendingTextTimeout === null) return;
    clearTimeout(pendingTextTimeout);
    pendingTextTimeout = null;
  };
  const onCompositionStart = () => {
    composing = true;
    clearPendingTextTimeout();
    pendingText = "";
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    composing = false;
    pendingText = event.data;
    clearPendingTextTimeout();
    pendingTextTimeout = setTimeout(() => {
      pendingText = "";
      pendingTextTimeout = null;
    }, 0);
  };
  const onInput = (event: Event) => {
    if (!(event instanceof InputEvent) || event.inputType !== "insertText") {
      return;
    }
    if (!pendingText || !event.data || !pendingText.startsWith(event.data)) {
      if (!composing) {
        clearPendingTextTimeout();
        pendingText = "";
      }
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    pendingText = pendingText.slice(event.data.length);
    if (!pendingText) clearPendingTextTimeout();
  };
  element.addEventListener("compositionstart", onCompositionStart, true);
  element.addEventListener("compositionend", onCompositionEnd, true);
  element.addEventListener("input", onInput, true);
  return {
    dispose: () => {
      clearPendingTextTimeout();
      element.removeEventListener("compositionstart", onCompositionStart, true);
      element.removeEventListener("compositionend", onCompositionEnd, true);
      element.removeEventListener("input", onInput, true);
    },
  };
}

const ARROW_SUFFIXES = { left: "D", down: "B", up: "A", right: "C" };

export function encodeTerminalArrow(
  key: TerminalNavigationKey,
  applicationCursorKeys: boolean,
): string {
  return `\x1b${applicationCursorKeys ? "O" : "["}${ARROW_SUFFIXES[key]}`;
}

export function applyTerminalControl(data: string): string {
  if (data.length !== 1 || !/^[a-zA-Z@\[\]\\^_?]$/u.test(data)) return data;
  return data === "?"
    ? "\x7f"
    : String.fromCharCode(data.toUpperCase().charCodeAt(0) & 0x1f);
}
