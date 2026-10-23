import {
  roundDurationMs,
  startEventLoopDelaySampler,
} from "@bb/process-utils";
import { PerformanceObserver, performance } from "node:perf_hooks";
import type { ServerLogger } from "../../types.js";
import { takeEventLoopWorkWindowSnapshot } from "./event-loop-work.js";

export interface EventLoopStallMonitorOptions {
  logger: Pick<ServerLogger, "info">;
  now?: () => number;
  thresholdMs?: number | (() => number);
  performanceObserver?: GcObserverConstructor;
}

interface GcPause {
  durationMs: number;
  kind: number;
}

interface GcEntryList {
  getEntries: () => Array<PerformanceEntry & { kind?: number }>;
}

interface GcObserver {
  disconnect: () => void;
  observe: (options: { entryTypes: string[] }) => void;
}

type GcObserverConstructor = new (
  callback: (list: GcEntryList) => void,
) => GcObserver;

export interface EventLoopStallMonitor {
  stop: () => void;
}

export function startEventLoopStallMonitor(
  options: EventLoopStallMonitorOptions,
): EventLoopStallMonitor {
  let gcPauses: GcPause[] = [];
  let previousUtilization = performance.eventLoopUtilization();
  const Observer = (options.performanceObserver ??
    PerformanceObserver) as GcObserverConstructor;
  const gcObserver = new Observer((list) => {
    for (const entry of list.getEntries()) {
      const gcEntry = entry as PerformanceEntry & { kind?: number };
      if (gcEntry.kind === undefined) continue;
      gcPauses.push({
        durationMs: roundDurationMs(gcEntry.duration),
        kind: gcEntry.kind,
      });
    }
  });
  gcObserver.observe({ entryTypes: ["gc"] });
  const sampler = startEventLoopDelaySampler({
    now: options.now,
    thresholdMs: options.thresholdMs,
    onSample: ({ stall }) => {
      const work = takeEventLoopWorkWindowSnapshot();
      const utilization = performance.eventLoopUtilization(previousUtilization);
      previousUtilization = performance.eventLoopUtilization();
      const gcPausesInWindow = gcPauses;
      gcPauses = [];
      if (stall !== null) {
        const totalGcPauseMs = gcPausesInWindow.reduce(
          (total, pause) => total + pause.durationMs,
          0,
        );
        const synchronousWorkDurationMs = Math.max(
          work.synchronousWorkCpuMs,
          work.longestSynchronousWorkWallMs ?? 0,
        );
        const gcIsStrongest = totalGcPauseMs > synchronousWorkDurationMs;
        const candidateDurationMs = gcIsStrongest
          ? totalGcPauseMs
          : synchronousWorkDurationMs;
        const candidate = gcIsStrongest
          ? totalGcPauseMs > 0
            ? "gc"
            : null
          : work.longestSynchronousWork;
        const hasCandidate =
          candidate !== null &&
          candidateDurationMs + stall.resolutionMs >= stall.maxDelayMs;
        options.logger.info(
          {
            ...stall,
            ...work,
            eventLoopUtilization: {
              activeMs: roundDurationMs(utilization.active),
              idleMs: roundDurationMs(utilization.idle),
              utilization: roundDurationMs(utilization.utilization),
            },
            gcPauses: gcPausesInWindow,
            stallAttribution: hasCandidate ? "candidate" : "unattributed",
            stallCauseCandidate: candidate,
          },
          "Event loop stalled",
        );
      }
    },
  });
  return {
    stop: () => {
      sampler.stop();
      gcObserver.disconnect();
    },
  };
}
