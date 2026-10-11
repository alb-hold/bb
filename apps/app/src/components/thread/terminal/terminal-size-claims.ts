const TERMINAL_SIZE_CLAIM_INTERVAL_MS = 1_000;
const TERMINAL_SIZE_CLAIM_EVENTS = ["keydown", "paste", "pointerdown"] as const;

interface TerminalSizeClaimsArgs {
  claim: () => void;
  element: HTMLElement;
  now?: () => number;
  textarea: HTMLTextAreaElement | undefined;
}

export interface TerminalSizeClaims {
  claimIfFocused: () => void;
  dispose: () => void;
}

export function listenForTerminalSizeClaims({
  claim,
  element,
  now = Date.now,
  textarea,
}: TerminalSizeClaimsArgs): TerminalSizeClaims {
  let lastClaimAt: number | null = null;
  const claimIfVisible = () => {
    if (element.clientWidth <= 0 || element.clientHeight <= 0) {
      return;
    }
    lastClaimAt = now();
    claim();
  };
  const claimOnUserInput = () => {
    if (
      lastClaimAt === null ||
      now() - lastClaimAt > TERMINAL_SIZE_CLAIM_INTERVAL_MS
    ) {
      claimIfVisible();
    }
  };
  textarea?.addEventListener("focus", claimIfVisible);
  for (const type of TERMINAL_SIZE_CLAIM_EVENTS) {
    element.addEventListener(type, claimOnUserInput, { capture: true });
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
        element.removeEventListener(type, claimOnUserInput, { capture: true });
      }
    },
  };
}
