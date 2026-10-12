const STABLE_FRAMES_REQUIRED = 2;

interface WatchTerminalLayoutSettledArgs {
  cancelFrame: (handle: number) => void;
  measure: () => string | null;
  onSettled: () => void;
  ready?: Promise<unknown>;
  requestFrame: (callback: () => void) => number;
}

export function watchTerminalLayoutSettled({
  cancelFrame,
  measure,
  onSettled,
  ready,
  requestFrame,
}: WatchTerminalLayoutSettledArgs): () => void {
  let handle: number | null = null;
  let previous: string | null = null;
  let stableFrames = 0;
  let stopped = false;

  const tick = () => {
    handle = null;
    if (stopped) {
      return;
    }
    const current = measure();
    if (current !== null && current === previous) {
      stableFrames += 1;
    } else {
      stableFrames = 0;
    }
    previous = current;
    if (stableFrames >= STABLE_FRAMES_REQUIRED) {
      stopped = true;
      onSettled();
      return;
    }
    handle = requestFrame(tick);
  };
  if (ready === undefined) {
    handle = requestFrame(tick);
  } else {
    const start = () => {
      if (!stopped && handle === null) {
        handle = requestFrame(tick);
      }
    };
    void ready.then(start, start);
  }

  return () => {
    stopped = true;
    if (handle !== null) {
      cancelFrame(handle);
      handle = null;
    }
  };
}

export function hasRunningLayoutAnimation(element: Element): boolean {
  for (
    let current: Element | null = element;
    current !== null;
    current = current.parentElement
  ) {
    if (typeof current.getAnimations !== "function") {
      return false;
    }
    if (
      current
        .getAnimations()
        .some((animation) => animation.playState === "running")
    ) {
      return true;
    }
  }
  return false;
}
