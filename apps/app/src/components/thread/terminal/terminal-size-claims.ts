const TERMINAL_SIZE_CLAIM_EVENTS = ["keydown", "paste", "pointerdown"] as const;

interface TerminalSizeClaimsArgs {
  claim: (reclaim: boolean) => void;
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
  const claimIfVisible = (reclaim: boolean) => {
    if (element.clientWidth <= 0 || element.clientHeight <= 0) {
      return;
    }
    claim(reclaim);
  };
  const reclaimIfVisible = () => claimIfVisible(true);
  textarea?.addEventListener("focus", reclaimIfVisible);
  for (const type of TERMINAL_SIZE_CLAIM_EVENTS) {
    element.addEventListener(type, reclaimIfVisible, { capture: true });
  }
  return {
    claimIfFocused: () => {
      if (textarea !== undefined && document.activeElement === textarea) {
        claimIfVisible(false);
      }
    },
    dispose: () => {
      textarea?.removeEventListener("focus", reclaimIfVisible);
      for (const type of TERMINAL_SIZE_CLAIM_EVENTS) {
        element.removeEventListener(type, reclaimIfVisible, {
          capture: true,
        });
      }
    },
  };
}
