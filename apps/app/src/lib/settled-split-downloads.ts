import { requestBrowserIdle } from "./plugin-frontend-boot-schedule";
import { downloadSplitInBackground } from "./split-prefetch";

export function createSettledWorkSchedule(
  isActive: () => boolean,
  settledAt = Date.now() + 15_000,
): { whenIdle: () => Promise<boolean>; cancel: () => void } {
  let lastInput = 0;
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
    const delay = Math.max(settledAt, lastInput + 1_000) - Date.now();
    timer = window.setTimeout(
      () => {
        timer = null;
        cancelIdle = requestBrowserIdle(() => {
          cancelIdle = null;
          const next = resume;
          resume = null;
          next?.(!stopped && isActive());
        });
      },
      Math.max(0, delay),
    );
  };
  const input = () => {
    lastInput = Date.now();
    if (resume !== null) schedule();
  };
  const events = ["input", "keydown", "pointerdown", "touchstart", "wheel"];
  for (const event of events)
    document.addEventListener(event, input, { capture: true, passive: true });
  const whenIdle = () =>
    new Promise<boolean>((resolve) => {
      if (stopped || !isActive()) return resolve(false);
      resume = resolve;
      schedule();
    });
  const cancel = () => {
    stopped = true;
    clear();
    resume?.(false);
    resume = null;
    for (const event of events)
      document.removeEventListener(event, input, { capture: true });
  };
  return { whenIdle, cancel };
}

export function scheduleSettledSplitDownloads(
  ids: readonly string[],
  isActive: () => boolean,
): () => void {
  const schedule = createSettledWorkSchedule(isActive);
  void (async () => {
    for (const id of ids) {
      if (!isActive()) return;
      await downloadSplitInBackground(id, schedule.whenIdle);
    }
  })()
    .catch(() => undefined)
    .finally(schedule.cancel);
  return schedule.cancel;
}
