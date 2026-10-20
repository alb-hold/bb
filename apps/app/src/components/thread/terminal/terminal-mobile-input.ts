export type TerminalNavigationKey = "left" | "down" | "up" | "right";

interface DeferredCompositionInput {
  data: string;
  input: HTMLTextAreaElement;
  selectionDirection: "forward" | "backward" | "none" | null;
  selectionEnd: number | null;
  selectionStart: number | null;
  value: string;
}

export function suppressDuplicateTerminalCompositionInput(
  element: HTMLElement,
  sendInput: (data: string) => void,
): { dispose: () => void; flushPendingInput: () => void } {
  let composing = false;
  let pendingText = "";
  let pendingCompositionInput = false;
  let compositionText = "";
  let compositionInput: HTMLTextAreaElement | null = null;
  let compositionBaseValue = "";
  let compositionBaseStart: number | null = 0;
  let compositionBaseEnd: number | null = 0;
  let compositionBaseDirection: "forward" | "backward" | "none" | null = "none";
  let pendingCompositionInputTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTextTimeout: ReturnType<typeof setTimeout> | null = null;
  const deferredInputs: DeferredCompositionInput[] = [];
  const clearPendingTextTimeout = () => {
    if (pendingTextTimeout === null) return;
    clearTimeout(pendingTextTimeout);
    pendingTextTimeout = null;
  };
  const clearDeferredInputTimer = () => {
    if (pendingCompositionInputTimer === null) return;
    clearTimeout(pendingCompositionInputTimer);
    pendingCompositionInputTimer = null;
  };
  const clearDeferredInputs = () => {
    clearDeferredInputTimer();
    deferredInputs.length = 0;
  };
  const resetCompositionTextarea = () => {
    if (compositionInput === null) return;
    compositionInput.value = compositionBaseValue;
    compositionInput.setSelectionRange(
      compositionBaseStart,
      compositionBaseEnd,
      compositionBaseDirection ?? "none",
    );
  };
  const replayDeferredInputs = () => {
    clearDeferredInputTimer();
    pendingCompositionInput = false;
    const queued = deferredInputs.splice(0);
    for (const deferred of queued) {
      deferred.input.value = deferred.value;
      deferred.input.setSelectionRange(
        deferred.selectionStart,
        deferred.selectionEnd,
        deferred.selectionDirection ?? "none",
      );
      deferred.input.dispatchEvent(
        new InputEvent("input", {
          data: deferred.data,
          inputType: "insertText",
          bubbles: true,
          composed: true,
        }),
      );
    }
  };
  const flushPendingInput = () => {
    if (deferredInputs.length === 0) return;
    const trailingText = deferredInputs.map(({ data }) => data).join("");
    clearDeferredInputs();
    clearPendingTextTimeout();
    pendingText = "";
    pendingCompositionInput = false;
    sendInput(`${compositionText}${trailingText}`);
    resetCompositionTextarea();
  };
  const onCompositionStart = (event: CompositionEvent) => {
    composing = true;
    pendingCompositionInput = false;
    compositionInput = event.target instanceof HTMLTextAreaElement ? event.target : null;
    compositionBaseValue = compositionInput?.value ?? "";
    compositionBaseStart = compositionInput?.selectionStart ?? 0;
    compositionBaseEnd = compositionInput?.selectionEnd ?? compositionBaseStart;
    compositionBaseDirection = compositionInput?.selectionDirection ?? "none";
    clearPendingTextTimeout();
    pendingText = "";
    compositionText = "";
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    composing = false;
    pendingText = event.data;
    compositionText = event.data;
    pendingCompositionInput = event.data.length > 0;
    clearPendingTextTimeout();
    pendingTextTimeout = setTimeout(() => {
      pendingText = "";
      pendingCompositionInput = false;
      pendingTextTimeout = null;
    }, 0);
  };
  const onKeydown = () => flushPendingInput();
  const onInput = (event: Event) => {
    if (!(event instanceof InputEvent) || event.inputType !== "insertText") {
      return;
    }
    if (
      (pendingCompositionInput || deferredInputs.length > 0) &&
      event.data &&
      !pendingText.startsWith(event.data)
    ) {
      const input = event.target;
      if (!(input instanceof HTMLTextAreaElement)) return;
      const insertedEnd = input.selectionStart ?? input.value.length;
      const insertedStart = Math.max(0, insertedEnd - event.data.length);
      const priorQueuedText = deferredInputs.map(({ data }) => data).join("");
      const nextValue = input.value;
      const nextSelectionStart = input.selectionStart;
      const nextSelectionEnd = input.selectionEnd;
      const nextDirection = input.selectionDirection;
      const valueWithQueuedText = `${nextValue.slice(0, insertedStart)}${priorQueuedText}${nextValue.slice(insertedStart)}`;
      const selectionOffset = priorQueuedText.length;
      deferredInputs.push({
        data: event.data,
        input,
        selectionDirection: nextDirection,
        selectionEnd:
          nextSelectionEnd === null ? null : nextSelectionEnd + selectionOffset,
        selectionStart:
          nextSelectionStart === null ? null : nextSelectionStart + selectionOffset,
        value: valueWithQueuedText,
      });
      input.value = `${nextValue.slice(0, insertedStart)}${nextValue.slice(insertedEnd)}`;
      input.setSelectionRange(insertedStart, insertedStart);
      event.preventDefault();
      event.stopImmediatePropagation();
      pendingCompositionInput = true;
      clearPendingTextTimeout();
      pendingText = "";
      if (pendingCompositionInputTimer === null) {
        pendingCompositionInputTimer = setTimeout(() => {
          pendingCompositionInputTimer = setTimeout(replayDeferredInputs, 0);
        }, 0);
      }
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
    if (!pendingText) {
      clearPendingTextTimeout();
      pendingTextTimeout = setTimeout(() => {
        pendingCompositionInput = false;
        pendingTextTimeout = null;
      }, 0);
    }
  };
  element.addEventListener("compositionstart", onCompositionStart, true);
  element.addEventListener("compositionend", onCompositionEnd, true);
  element.addEventListener("keydown", onKeydown, true);
  element.addEventListener("input", onInput, true);
  return {
    dispose: () => {
      clearPendingTextTimeout();
      if (deferredInputs.length > 0) resetCompositionTextarea();
      clearDeferredInputs();
      element.removeEventListener("compositionstart", onCompositionStart, true);
      element.removeEventListener("compositionend", onCompositionEnd, true);
      element.removeEventListener("keydown", onKeydown, true);
      element.removeEventListener("input", onInput, true);
    },
    flushPendingInput,
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
