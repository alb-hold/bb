const TERMINAL_SIZE_CLAIM_EVENTS = ["keydown", "paste", "pointerdown"] as const;

interface TerminalSizeClaimsArgs {
  claim: () => void;
  element: HTMLElement;
  textarea: HTMLTextAreaElement | undefined;
}

export interface TerminalSizeClaims {
  claimIfFocused: () => void;
  dispose: () => void;
}

export function listenForTerminalSizeClaims({
  claim,
  element,
  textarea,
}: TerminalSizeClaimsArgs): TerminalSizeClaims {
  const claimIfVisible = () => {
    if (element.clientWidth <= 0 || element.clientHeight <= 0) {
      return;
    }
    claim();
  };
  textarea?.addEventListener("focus", claimIfVisible);
  for (const type of TERMINAL_SIZE_CLAIM_EVENTS) {
    element.addEventListener(type, claimIfVisible, { capture: true });
  }
  return {
    claimIfFocused: () => {
      if (textarea !== undefined && document.activeElement === textarea) {
        claimIfVisible();
      }
    },
    dispose: () => {
      textarea?.removeEventListener("focus", claimIfVisible);
      for (const type of TERMINAL_SIZE_CLAIM_EVENTS) {
        element.removeEventListener(type, claimIfVisible, {
          capture: true,
        });
      }
    },
  };
}
