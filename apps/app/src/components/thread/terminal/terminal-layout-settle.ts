import { measureTerminalPerformance } from "@/lib/terminal-performance";

const STABLE_FRAMES_REQUIRED = 2;
const GRACE_FRAMES_AFTER_STABLE = 8;

interface WatchTerminalLayoutSettledArgs {
  cancelFrame: (handle: number) => void;
  graceFrames?: number;
  stableFramesRequired?: number;
  measure: () => string | null;
  onSettled: () => void;
  ready?: Promise<unknown>;
  settleReady?: Promise<unknown>;
  requestFrame: (callback: () => void) => number;
  subscribe?: (onSignal: () => void) => () => void;
}

export function watchTerminalLayoutSettled({
  cancelFrame,
  graceFrames = GRACE_FRAMES_AFTER_STABLE,
  stableFramesRequired = STABLE_FRAMES_REQUIRED,
  measure,
  onSettled,
  ready,
  settleReady,
  requestFrame,
  subscribe,
}: WatchTerminalLayoutSettledArgs): () => void {
  let handle: number | null = null;
  let previous: string | null = null;
  let stableFrames = 0;
  let stopped = false;
  let signalled = false;
  let started = false;
  let canSettle = settleReady === undefined;
  const unsubscribe = subscribe?.(() => {
    signalled = true;
  });
  const framesRequired =
    stableFramesRequired + (subscribe === undefined ? 0 : graceFrames);

  const tick = () => {
    handle = null;
    if (stopped) {
      return;
    }
    const current = measure();
    if (signalled) {
      signalled = false;
      stableFrames = 0;
    } else if (current !== null && current === previous) {
      stableFrames += 1;
    } else {
      stableFrames = 0;
    }
    previous = current;
    if (canSettle && stableFrames >= framesRequired) {
      stopped = true;
      unsubscribe?.();
      onSettled();
      return;
    }
    handle = requestFrame(tick);
  };
  const allowSettle = () => {
    canSettle = true;
    if (stopped || !started) return;
    if (handle !== null) cancelFrame(handle);
    tick();
  };
  void settleReady?.then(allowSettle, allowSettle);
  if (ready === undefined) {
    started = true;
    handle = requestFrame(tick);
  } else {
    const start = () => {
      if (!stopped && handle === null) {
        started = true;
        measureTerminalPerformance("terminal-layout-ready-sample", tick);
      }
    };
    void ready.then(start, start);
  }

  return () => {
    stopped = true;
    unsubscribe?.();
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

interface ObserveLayoutSignalsArgs {
  affectsContainer: (target: EventTarget | null) => boolean;
  document: EventTarget;
  fontSet?: EventTarget;
  onSignal: () => void;
}

export function observeLayoutSignals({
  affectsContainer,
  document,
  fontSet,
  onSignal,
}: ObserveLayoutSignalsArgs): () => void {
  const onTransition = (event: Event) => {
    if (affectsContainer(event.target)) {
      onSignal();
    }
  };
  document.addEventListener("transitionrun", onTransition, true);
  document.addEventListener("transitionstart", onTransition, true);
  fontSet?.addEventListener("loading", onSignal);
  fontSet?.addEventListener("loadingdone", onSignal);
  return () => {
    document.removeEventListener("transitionrun", onTransition, true);
    document.removeEventListener("transitionstart", onTransition, true);
    fontSet?.removeEventListener("loading", onSignal);
    fontSet?.removeEventListener("loadingdone", onSignal);
  };
}
