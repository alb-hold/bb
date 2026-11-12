import { expect, it, vi } from "vitest";
import { createStartingPluginsRecheck } from "./plugin-frontend-starting-recheck";

function harness(starting: { value: boolean }) {
  const timers: { callback: () => void; ms: number }[] = [];
  const recheck = vi.fn();
  const clearTimeout = vi.fn();
  const subject = createStartingPluginsRecheck({
    isServerPluginsStarting: () => starting.value,
    recheck,
    setTimeout: (callback, ms) => {
      timers.push({ callback, ms });
      return timers.length;
    },
    clearTimeout,
    delaysMs: [10, 20],
  });
  return { subject, timers, recheck, clearTimeout };
}

it("does nothing when no plugin is starting", () => {
  const { subject, timers } = harness({ value: false });
  subject.afterReconcile();
  expect(timers).toHaveLength(0);
});

it("backs off while plugins stay starting, holding one timer at a time", () => {
  const starting = { value: true };
  const { subject, timers, recheck } = harness(starting);
  subject.afterReconcile();
  subject.afterReconcile();
  expect(timers.map((timer) => timer.ms)).toEqual([10]);
  timers[0]!.callback();
  expect(recheck).toHaveBeenCalledTimes(1);
  subject.afterReconcile();
  timers[1]!.callback();
  subject.afterReconcile();
  expect(timers.map((timer) => timer.ms)).toEqual([10, 20, 20]);
});

it("keeps re-checking at the last delay for as long as plugins stay starting", () => {
  const { subject, timers, recheck } = harness({ value: true });
  for (let i = 0; i < 200; i += 1) {
    subject.afterReconcile();
    timers.at(-1)?.callback();
  }
  expect(timers).toHaveLength(200);
  expect(recheck).toHaveBeenCalledTimes(200);
  expect(new Set(timers.slice(1).map((timer) => timer.ms))).toEqual(
    new Set([20]),
  );
});

it("cancels a pending re-check and resets the backoff once plugins are running", () => {
  const starting = { value: true };
  const { subject, timers, clearTimeout } = harness(starting);
  subject.afterReconcile();
  starting.value = false;
  subject.afterReconcile();
  expect(clearTimeout).toHaveBeenCalledWith(1);
  starting.value = true;
  subject.afterReconcile();
  expect(timers.map((timer) => timer.ms)).toEqual([10, 10]);
});

it("re-arms after a failed re-check while a re-check run is in progress", () => {
  const starting = { value: true };
  const { subject, timers } = harness(starting);
  subject.afterFailedReconcile();
  expect(timers).toHaveLength(0);
  subject.afterReconcile();
  timers[0]!.callback();
  starting.value = false;
  subject.afterFailedReconcile();
  expect(timers.map((timer) => timer.ms)).toEqual([10, 20]);
});
