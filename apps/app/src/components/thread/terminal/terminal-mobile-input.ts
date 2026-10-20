export type TerminalNavigationKey = "left" | "down" | "up" | "right";

export function suppressDuplicateTerminalCompositionInput(
  element: HTMLElement,
): { dispose: () => void } {
  let composing = false;
  let pendingText = "";
  let pendingCompositionInput = false;
  let pendingCompositionInputTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTextTimeout: ReturnType<typeof setTimeout> | null = null;
  const clearPendingTextTimeout = () => {
    if (pendingTextTimeout === null) return;
    clearTimeout(pendingTextTimeout);
    pendingTextTimeout = null;
  };
  const onCompositionStart = () => {
    composing = true;
    pendingCompositionInput = false;
    clearPendingTextTimeout();
    pendingText = "";
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    composing = false;
    pendingText = event.data;
    pendingCompositionInput = event.data.length > 0;
    clearPendingTextTimeout();
    pendingTextTimeout = setTimeout(() => {
      pendingText = "";
      pendingCompositionInput = false;
      pendingTextTimeout = null;
    }, 0);
  };
  const onInput = (event: Event) => {
    if (!(event instanceof InputEvent) || event.inputType !== "insertText") {
      return;
    }
    if (pendingCompositionInput && event.data && !pendingText.startsWith(event.data)) {
      const input = event.target;
      if (!(input instanceof HTMLTextAreaElement)) return;
      const insertedEnd = input.selectionStart ?? input.value.length;
      const insertedStart = Math.max(0, insertedEnd - event.data.length);
      const nextValue = input.value;
      const nextSelectionStart = input.selectionStart;
      const nextSelectionEnd = input.selectionEnd;
      const nextDirection = input.selectionDirection;
      input.value = `${nextValue.slice(0, insertedStart)}${nextValue.slice(insertedEnd)}`;
      input.setSelectionRange(insertedStart, insertedStart);
      event.preventDefault();
      event.stopImmediatePropagation();
      clearPendingTextTimeout();
      pendingText = "";
      pendingCompositionInput = false;
      if (pendingCompositionInputTimer !== null) clearTimeout(pendingCompositionInputTimer);
      pendingCompositionInputTimer = setTimeout(() => {
        pendingCompositionInputTimer = setTimeout(() => {
          pendingCompositionInputTimer = null;
          input.value = nextValue;
          input.setSelectionRange(nextSelectionStart, nextSelectionEnd, nextDirection ?? "none");
          input.dispatchEvent(
            new InputEvent("input", {
              data: event.data,
              inputType: "insertText",
              bubbles: true,
              composed: true,
            }),
          );
        }, 0);
      }, 0);
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
  };
  element.addEventListener("compositionstart", onCompositionStart, true);
  element.addEventListener("compositionend", onCompositionEnd, true);
  element.addEventListener("input", onInput, true);
  return {
    dispose: () => {
      clearPendingTextTimeout();
      if (pendingCompositionInputTimer !== null) clearTimeout(pendingCompositionInputTimer);
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
