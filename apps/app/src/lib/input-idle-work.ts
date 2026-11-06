import { requestBrowserIdle } from "./plugin-frontend-boot-schedule";

let lastInput = -Infinity;
let composing = false;
let lane = Promise.resolve();

export function createSettledWorkSchedule(isActive: () => boolean) {
  let stopped = false;
  let timer: number | null = null;
  let cancelIdle: (() => void) | null = null;
  let resume: ((active: boolean) => void) | null = null;
  const clear = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    cancelIdle?.();
    cancelIdle = null;
  };
  const schedule = () => {
    clear();
    if (composing) return;
    timer = window.setTimeout(
      () => {
        timer = null;
        cancelIdle = requestBrowserIdle(() => {
          cancelIdle = null;
          if (composing || Date.now() - lastInput < 1_000) return schedule();
          const next = resume;
          resume = null;
          next?.(!stopped && isActive());
        });
      },
      Math.max(0, lastInput + 1_000 - Date.now()),
    );
  };
  const input = (event: Event) => {
    lastInput = Date.now();
    if (event.type === "compositionstart") composing = true;
    if (event.type === "compositionend") composing = false;
    if (resume !== null) schedule();
  };
  const events = [
    "input",
    "keydown",
    "pointerdown",
    "touchstart",
    "wheel",
    "compositionstart",
    "compositionend",
  ];
  for (const event of events)
    document.addEventListener(event, input, { capture: true, passive: true });
  const whenIdle = () =>
    new Promise<boolean>((resolve) => {
      if (stopped || !isActive()) return resolve(false);
      resume = resolve;
      schedule();
    });
  const run = <T>(work: () => Promise<T>): Promise<T | undefined> => {
    const result = lane.then(async () =>
      (await whenIdle()) ? work() : undefined,
    );
    lane = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const cancel = () => {
    stopped = true;
    clear();
    resume?.(false);
    resume = null;
    for (const event of events)
      document.removeEventListener(event, input, { capture: true });
  };
  return { whenIdle, run, cancel };
}
