import { expect, it, vi } from "vitest";
import { createStartingPluginsRecheck } from "./plugin-frontend-starting-recheck";

function harness(starting: { value: boolean }, maxAttempts = 3) {
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
    maxAttempts,
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

it("stops after the attempt cap", () => {
  const { subject, timers } = harness({ value: true }, 2);
  for (let i = 0; i < 5; i += 1) {
    subject.afterReconcile();
    timers.at(-1)?.callback();
  }
  expect(timers).toHaveLength(2);
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
