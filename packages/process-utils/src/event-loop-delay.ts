import { monitorEventLoopDelay } from "node:perf_hooks";

interface EventLoopStall {
  intervalMs: number;
  maxDelayMs: number;
  rawMaxDelayMs: number;
  timerLagMs: number;
  meanDelayMs: number;
  p99DelayMs: number;
  resolutionMs: number;
  thresholdMs: number;
}

interface StartEventLoopDelaySamplerArgs {
  thresholdMs?: number | (() => number);
  now?: () => number;
  histogram?: EventLoopDelayHistogram;
  intervalMs?: number;
  defer?: (callback: () => void) => void;
  onSample: (sample: { stall: EventLoopStall | null }) => void;
}

interface EventLoopDelayHistogram {
  disable: () => void;
  enable: () => void;
  max: number;
  mean: number;
  percentile: (percentile: number) => number;
  reset: () => void;
}

interface EventLoopDelaySampler {
  stop: () => void;
}

const EVENT_LOOP_STALL_THRESHOLD_MS = 500;
const EVENT_LOOP_DELAY_SAMPLE_INTERVAL_MS = 5_000;
const EVENT_LOOP_DELAY_RESOLUTION_MS = 20;
const LIKELY_SYSTEM_SUSPENSION_MIN_DELAY_MS = 60_000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

function nanosecondsToMilliseconds(durationNs: number): number {
  return durationNs / NANOSECONDS_PER_MILLISECOND;
}

export function roundDurationMs(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
}

export function isLikelySystemSuspensionDelay(args: {
  gapMs: number;
  intervalMs: number;
}): boolean {
  return args.gapMs - args.intervalMs >= LIKELY_SYSTEM_SUSPENSION_MIN_DELAY_MS;
}

export function startEventLoopDelaySampler(
  args: StartEventLoopDelaySamplerArgs,
): EventLoopDelaySampler {
  const now = args.now ?? (() => Date.now());
  const intervalMs = args.intervalMs ?? EVENT_LOOP_DELAY_SAMPLE_INTERVAL_MS;
  const defer = args.defer ?? ((callback) => setImmediate(callback));
  const histogram =
    args.histogram ??
    monitorEventLoopDelay({ resolution: EVENT_LOOP_DELAY_RESOLUTION_MS });
  histogram.enable();
  let lastSampleAt = now();
  let stopped = false;

  const interval = setInterval(() => {
    const sampledAt = now();
    const gapMs = sampledAt - lastSampleAt;
    lastSampleAt = sampledAt;
    const timerLagMs = Math.max(0, gapMs - intervalMs);
    const thresholdMs =
      typeof args.thresholdMs === "function"
        ? args.thresholdMs()
        : (args.thresholdMs ?? EVENT_LOOP_STALL_THRESHOLD_MS);
    const suspended = isLikelySystemSuspensionDelay({ gapMs, intervalMs });
    const readAndReport = () => {
      if (stopped) return;
      const histogramMaxDelayMs = nanosecondsToMilliseconds(histogram.max);
      const maxDelayMs = Math.max(histogramMaxDelayMs, timerLagMs);
      const stalled = !suspended && maxDelayMs >= thresholdMs;
      args.onSample({
        stall: stalled
          ? {
              intervalMs,
              maxDelayMs: roundDurationMs(maxDelayMs),
              rawMaxDelayMs: maxDelayMs,
              timerLagMs: roundDurationMs(timerLagMs),
              meanDelayMs: roundDurationMs(
                nanosecondsToMilliseconds(histogram.mean),
              ),
              p99DelayMs: roundDurationMs(
                nanosecondsToMilliseconds(histogram.percentile(99)),
              ),
              resolutionMs: EVENT_LOOP_DELAY_RESOLUTION_MS,
              thresholdMs,
            }
          : null,
      });
      histogram.reset();
    };
    if (!suspended && timerLagMs >= thresholdMs) defer(readAndReport);
    else readAndReport();
  }, intervalMs);
  interval.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
      histogram.disable();
    },
  };
}
