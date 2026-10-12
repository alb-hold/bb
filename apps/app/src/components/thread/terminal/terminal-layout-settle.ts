const STABLE_FRAMES_REQUIRED = 2;

interface WatchTerminalLayoutSettledArgs {
  cancelFrame: (handle: number) => void;
  measure: () => string | null;
  onSettled: () => void;
  requestFrame: (callback: () => void) => number;
}

export function watchTerminalLayoutSettled({
  cancelFrame,
  measure,
  onSettled,
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
  handle = requestFrame(tick);

  return () => {
    stopped = true;
    if (handle !== null) {
      cancelFrame(handle);
      handle = null;
    }
  };
}
