import { afterEach, expect, it, vi } from "vitest";
import { startEventLoopDelaySampler } from "../src/event-loop-delay.js";

const nanosecondsPerMillisecond = 1_000_000;

function createHistogram() {
  const histogram = {
    disable: vi.fn(),
    enable: vi.fn(),
    max: 0,
    mean: 0,
    percentile: vi.fn(() => 0),
    reset: vi.fn(() => {
      histogram.max = 0;
    }),
  };
  return histogram;
}

afterEach(() => {
  vi.useRealTimers();
});

it("reports timer lag for a synchronous block once", () => {
  vi.useFakeTimers();
  let now = 0;
  const histogram = createHistogram();
  const samples: Array<{ maxDelayMs: number; timerLagMs: number } | null> = [];
  const sampler = startEventLoopDelaySampler({
    histogram,
    now: () => now,
    onSample: (sample) => samples.push(sample.stall),
  });

  now = 7_000;
  vi.advanceTimersByTime(5_000);
  histogram.max = 2_000 * nanosecondsPerMillisecond;
  now = 12_000;
  vi.advanceTimersByTime(5_000);

  expect(samples).toHaveLength(2);
  expect(samples[0]).toMatchObject({ maxDelayMs: 2_000, timerLagMs: 2_000 });
  expect(samples[1]).toBeNull();
  sampler.stop();
});

it("discounts the same block when the histogram records its late tick next window", () => {
  vi.useFakeTimers();
  let now = 0;
  const histogram = createHistogram();
  const stalls: Array<{ maxDelayMs: number; timerLagMs: number }> = [];
  const sampler = startEventLoopDelaySampler({
    histogram,
    now: () => now,
    onSample: ({ stall }) => {
      if (stall !== null) stalls.push(stall);
    },
  });

  now = 7_000;
  vi.advanceTimersByTime(5_000);
  histogram.max = 2_000 * nanosecondsPerMillisecond;
  now = 12_000;
  vi.advanceTimersByTime(5_000);

  expect(stalls.filter((stall) => stall.maxDelayMs >= 2_000)).toHaveLength(1);
  sampler.stop();
});

it("reports a 30-second gap under the suspension guard as timer lag", () => {
  vi.useFakeTimers();
  let now = 0;
  const histogram = createHistogram();
  const samples: Array<{ maxDelayMs: number; timerLagMs: number } | null> = [];
  const sampler = startEventLoopDelaySampler({
    histogram,
    now: () => now,
    onSample: ({ stall }) => samples.push(stall),
  });

  now = 30_000;
  vi.advanceTimersByTime(5_000);

  expect(samples[0]).toMatchObject({ maxDelayMs: 25_000, timerLagMs: 25_000 });
  sampler.stop();
});

it("suppresses gaps at or above the suspension guard", () => {
  vi.useFakeTimers();
  let now = 0;
  const samples: Array<{ stall: unknown }> = [];
  const sampler = startEventLoopDelaySampler({
    histogram: createHistogram(),
    now: () => now,
    onSample: (sample) => samples.push(sample),
  });

  now = 70_000;
  vi.advanceTimersByTime(5_000);

  expect(samples[0]?.stall).toBeNull();
  sampler.stop();
});
