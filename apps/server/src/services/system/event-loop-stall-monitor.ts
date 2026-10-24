import { roundDurationMs, startEventLoopDelaySampler } from "@bb/process-utils";
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
  rawDurationMs: number;
  kind: number;
}

const OFF_CPU_MAIN_THREAD_CPU_WALL_RATIO_THRESHOLD = 0.1;
const STALL_CANDIDATE_DURATION_RATIO_THRESHOLD = 0.9;

type ProcessContextSwitchHint =
  | "voluntary-dominant"
  | "involuntary-dominant"
  | "balanced"
  | "no-change";

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
  let previousCpuUsage = process.cpuUsage();
  let previousMainThreadCpuUsage = process.threadCpuUsage();
  let previousResourceUsage = process.resourceUsage();
  const now = options.now ?? Date.now;
  let previousSampleAt = now();
  const Observer = (options.performanceObserver ??
    PerformanceObserver) as GcObserverConstructor;
  const gcObserver = new Observer((list) => {
    for (const entry of list.getEntries()) {
      const gcEntry = entry as PerformanceEntry & { kind?: number };
      if (gcEntry.kind === undefined) continue;
      gcPauses.push({
        durationMs: roundDurationMs(gcEntry.duration),
        rawDurationMs: gcEntry.duration,
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
      const {
        rawLongestSynchronousWorkCpuMs: _rawWorkCpuMs,
        rawLongestSynchronousWorkWallMs: _rawWorkWallMs,
        ...loggedWork
      } = work;
      const loggedStall =
        stall === null
          ? null
          : (({ rawMaxDelayMs: _rawMaxDelayMs, ...fields }) => fields)(stall);
      const sampledAt = now();
      const windowWallMs = sampledAt - previousSampleAt;
      previousSampleAt = sampledAt;
      const cpuUsage = process.cpuUsage();
      const processCpuMs =
        (cpuUsage.user -
          previousCpuUsage.user +
          cpuUsage.system -
          previousCpuUsage.system) /
        1_000;
      previousCpuUsage = cpuUsage;
      const processCpuWallRatio =
        windowWallMs <= 0 ? 0 : processCpuMs / windowWallMs;
      const mainThreadCpuUsage = process.threadCpuUsage();
      const mainThreadCpuMs =
        (mainThreadCpuUsage.user -
          previousMainThreadCpuUsage.user +
          mainThreadCpuUsage.system -
          previousMainThreadCpuUsage.system) /
        1_000;
      previousMainThreadCpuUsage = mainThreadCpuUsage;
      const mainThreadCpuWallRatio =
        windowWallMs <= 0 ? 0 : mainThreadCpuMs / windowWallMs;
      const resourceUsage = process.resourceUsage();
      const minorPageFaults =
        resourceUsage.minorPageFault - previousResourceUsage.minorPageFault;
      const majorPageFaults =
        resourceUsage.majorPageFault - previousResourceUsage.majorPageFault;
      const voluntaryContextSwitches =
        resourceUsage.voluntaryContextSwitches -
        previousResourceUsage.voluntaryContextSwitches;
      const involuntaryContextSwitches =
        resourceUsage.involuntaryContextSwitches -
        previousResourceUsage.involuntaryContextSwitches;
      previousResourceUsage = resourceUsage;
      const offCpu =
        stall !== null &&
        mainThreadCpuMs <
          OFF_CPU_MAIN_THREAD_CPU_WALL_RATIO_THRESHOLD * stall.rawMaxDelayMs;
      const processContextSwitchHint: ProcessContextSwitchHint =
        voluntaryContextSwitches > involuntaryContextSwitches
          ? "voluntary-dominant"
          : involuntaryContextSwitches > voluntaryContextSwitches
            ? "involuntary-dominant"
            : voluntaryContextSwitches > 0
              ? "balanced"
              : "no-change";
      const utilization = performance.eventLoopUtilization(previousUtilization);
      previousUtilization = performance.eventLoopUtilization();
      const gcPausesInWindow = gcPauses;
      gcPauses = [];
      if (stall !== null) {
        const longestGcPauseMs = gcPausesInWindow.reduce(
          (longest, pause) => Math.max(longest, pause.rawDurationMs),
          0,
        );
        const longestSynchronousWorkDurationMs = Math.max(
          work.rawLongestSynchronousWorkCpuMs ?? 0,
          work.rawLongestSynchronousWorkWallMs ?? 0,
        );
        const gcIsStrongest =
          longestGcPauseMs > longestSynchronousWorkDurationMs;
        const candidateDurationMs = gcIsStrongest
          ? longestGcPauseMs
          : longestSynchronousWorkDurationMs;
        const measuredWorkCandidate = gcIsStrongest
          ? longestGcPauseMs > 0
            ? "gc"
            : null
          : work.longestSynchronousWork;
        const candidate = offCpu ? "off-cpu" : measuredWorkCandidate;
        const hasCandidate =
          offCpu ||
          (candidate !== null &&
            candidateDurationMs >=
              STALL_CANDIDATE_DURATION_RATIO_THRESHOLD * stall.rawMaxDelayMs);
        options.logger.info(
          {
            ...loggedStall,
            ...loggedWork,
            processCpuMs: roundDurationMs(processCpuMs),
            processCpuWallRatio:
              Math.round(processCpuWallRatio * 1_000) / 1_000,
            mainThreadCpuMs: roundDurationMs(mainThreadCpuMs),
            mainThreadCpuWallRatio:
              Math.round(mainThreadCpuWallRatio * 1_000) / 1_000,
            minorPageFaults,
            majorPageFaults,
            processVoluntaryContextSwitches: voluntaryContextSwitches,
            processInvoluntaryContextSwitches: involuntaryContextSwitches,
            processContextSwitchHint,
            windowWallMs: roundDurationMs(windowWallMs),
            eventLoopUtilization: {
              activeMs: roundDurationMs(utilization.active),
              idleMs: roundDurationMs(utilization.idle),
              utilization: roundDurationMs(utilization.utilization),
            },
            gcPauses: gcPausesInWindow.map(({ durationMs, kind }) => ({
              durationMs,
              kind,
            })),
            stallAttribution: hasCandidate ? "candidate" : "unattributed",
            stallCauseCandidate: hasCandidate ? candidate : null,
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
