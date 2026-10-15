export interface TerminalResizeCoalescerOptions {
  isSettled: () => boolean;
  onSettled: () => void;
  quietPeriodMs?: number;
}

export interface TerminalResizeCoalescer {
  cancel: () => void;
  schedule: () => void;
}

export function createTerminalResizeCoalescer({
  isSettled,
  onSettled,
  quietPeriodMs = 120,
}: TerminalResizeCoalescerOptions): TerminalResizeCoalescer {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const check = () => {
    timeout = null;
    if (disposed) {
      return;
    }
    if (isSettled()) {
      onSettled();
      return;
    }
    timeout = setTimeout(check, quietPeriodMs);
  };
  return {
    schedule: () => {
      if (disposed) {
        return;
      }
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      timeout = setTimeout(check, quietPeriodMs);
    },
    cancel: () => {
      disposed = true;
      if (timeout !== null) {
        clearTimeout(timeout);
        timeout = null;
      }
    },
  };
}
