import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { startEventLoopDelaySampler } from "../src/event-loop-delay.js";

const nanosecondsPerMillisecond = 1_000_000;
const trRuns = 50;

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

it("defers a late histogram tick and reports one 7,980 ms block", () => {
  vi.useFakeTimers();
  let now = 0;
  const histogram = createHistogram();
  const deferred: Array<() => void> = [];
  const samples: Array<{ maxDelayMs: number; timerLagMs: number } | null> = [];
  const sampler = startEventLoopDelaySampler({
    histogram,
    now: () => now,
    defer: (callback) => deferred.push(callback),
    onSample: ({ stall }) => samples.push(stall),
  });

  now = 12_000;
  vi.advanceTimersByTime(5_000);
  expect(samples).toHaveLength(0);
  expect(deferred).toHaveLength(1);
  histogram.max = 7_980 * nanosecondsPerMillisecond;
  deferred.shift()?.();
  now = 17_000;
  vi.advanceTimersByTime(5_000);

  expect(samples).toHaveLength(2);
  expect(samples[0]).toMatchObject({ maxDelayMs: 7_980, timerLagMs: 7_000 });
  expect(samples[1]).toBeNull();
  sampler.stop();
});

it("keeps a larger independent histogram stall in the following window", () => {
  vi.useFakeTimers();
  let now = 0;
  const histogram = createHistogram();
  const deferred: Array<() => void> = [];
  const stalls: Array<{ maxDelayMs: number; timerLagMs: number }> = [];
  const sampler = startEventLoopDelaySampler({
    histogram,
    now: () => now,
    defer: (callback) => deferred.push(callback),
    onSample: ({ stall }) => {
      if (stall !== null) stalls.push(stall);
    },
  });

  now = 7_000;
  vi.advanceTimersByTime(5_000);
  histogram.max = 2_000 * nanosecondsPerMillisecond;
  deferred.shift()?.();
  histogram.max = 2_400 * nanosecondsPerMillisecond;
  now = 12_000;
  vi.advanceTimersByTime(5_000);

  expect(stalls).toHaveLength(2);
  expect(stalls[0]).toMatchObject({ maxDelayMs: 2_000, timerLagMs: 2_000 });
  expect(stalls[1]).toMatchObject({ maxDelayMs: 2_400, timerLagMs: 0 });
  sampler.stop();
});

it("reports a 30-second gap under the suspension guard as timer lag", () => {
  vi.useFakeTimers();
  let now = 0;
  const histogram = createHistogram();
  const deferred: Array<() => void> = [];
  const samples: Array<{ maxDelayMs: number; timerLagMs: number } | null> = [];
  const sampler = startEventLoopDelaySampler({
    histogram,
    now: () => now,
    defer: (callback) => deferred.push(callback),
    onSample: ({ stall }) => samples.push(stall),
  });

  now = 30_000;
  vi.advanceTimersByTime(5_000);
  deferred.shift()?.();
  now = 35_000;
  vi.advanceTimersByTime(5_000);

  expect(samples).toHaveLength(2);
  expect(samples[0]).toMatchObject({ maxDelayMs: 25_000, timerLagMs: 25_000 });
  expect(samples[1]).toBeNull();
  sampler.stop();
});

it("reports timer lag when the deferred histogram maximum is smaller", () => {
  vi.useFakeTimers();
  let now = 0;
  const histogram = createHistogram();
  const deferred: Array<() => void> = [];
  const samples: Array<{ maxDelayMs: number; timerLagMs: number } | null> = [];
  const sampler = startEventLoopDelaySampler({
    histogram,
    now: () => now,
    defer: (callback) => deferred.push(callback),
    onSample: ({ stall }) => samples.push(stall),
  });

  now = 7_000;
  vi.advanceTimersByTime(5_000);
  histogram.max = 1_500 * nanosecondsPerMillisecond;
  deferred.shift()?.();

  expect(samples[0]).toMatchObject({ maxDelayMs: 2_000, timerLagMs: 2_000 });
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

interface RealHistogramTrial {
  maxAtCallbackMs: number;
  maxAtDeferredReadMs: number;
  stallCount: number;
}

async function runRealHistogramTrial(): Promise<RealHistogramTrial> {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  const stalls: unknown[] = [];
  let maxAtCallbackMs = 0;
  let maxAtDeferredReadMs = 0;
  let sampleCount = 0;
  let resolveTrial: ((result: RealHistogramTrial) => void) | undefined;
  const completed = new Promise<RealHistogramTrial>((resolve) => {
    resolveTrial = resolve;
  });
  const sampler = startEventLoopDelaySampler({
    histogram,
    intervalMs: 200,
    thresholdMs: 100,
    defer: (callback) => {
      maxAtCallbackMs = histogram.max / nanosecondsPerMillisecond;
      setImmediate(() => {
        maxAtDeferredReadMs = histogram.max / nanosecondsPerMillisecond;
        callback();
      });
    },
    onSample: ({ stall }) => {
      if (stall !== null) stalls.push(stall);
      sampleCount += 1;
      if (sampleCount === 3) {
        sampler.stop();
        resolveTrial?.({
          maxAtCallbackMs,
          maxAtDeferredReadMs,
          stallCount: stalls.length,
        });
      }
    },
  });
  setTimeout(() => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < 300) {}
  }, 100);
  return completed;
}

it("observes each real histogram late tick before the deferred read", async () => {
  const rows: RealHistogramTrial[] = [];
  for (let run = 0; run < trRuns; run += 1) {
    rows.push(await runRealHistogramTrial());
  }

  expect(rows).toHaveLength(trRuns);
  for (const row of rows) {
    expect(row.maxAtDeferredReadMs).toBeGreaterThanOrEqual(260);
    expect(row.stallCount).toBe(1);
  }
  process.stdout.write("TR_RESULT_BEGIN\nrun,maxAtCallbackMs,maxAtDeferredReadMs,stallCount\n");
  rows.forEach((row, index) => {
    process.stdout.write(
      `${index + 1},${row.maxAtCallbackMs.toFixed(1)},${row.maxAtDeferredReadMs.toFixed(1)},${row.stallCount}\n`,
    );
  });
  process.stdout.write(`TR_SUMMARY=${rows.filter((row) => row.maxAtDeferredReadMs >= 260 && row.stallCount === 1).length}/${trRuns}\nTR_RESULT_END\n`);
}, 60_000);
