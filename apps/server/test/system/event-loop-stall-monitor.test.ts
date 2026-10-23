import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setExperiments } from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { startGatedPerformanceDiagnostics } from "../../src/services/system/performance-diagnostics.js";
import { NotificationHub } from "../../src/ws/hub.js";

interface MockEventLoopDelayHistogram {
  disable: () => void;
  enable: () => void;
  max: number;
  mean: number;
  percentile: (percentile: number) => number;
  reset: () => void;
}

const perfHooksMock = vi.hoisted(() => {
  const state: { histogram: MockEventLoopDelayHistogram | null } = {
    histogram: null,
  };

  return {
    monitorEventLoopDelay: vi.fn(() => {
      if (state.histogram === null) {
        throw new Error("Expected test histogram to be installed");
      }
      return state.histogram;
    }),
    state,
  };
});

vi.mock("node:perf_hooks", async () => {
  const actual =
    await vi.importActual<typeof import("node:perf_hooks")>("node:perf_hooks");
  return {
    ...actual,
    monitorEventLoopDelay: perfHooksMock.monitorEventLoopDelay,
  };
});

import { performance as nodePerformance } from "node:perf_hooks";
import { startEventLoopStallMonitor } from "../../src/services/system/event-loop-stall-monitor.js";
import {
  resetEventLoopWorkForTests,
  runEventLoopWork,
  runEventLoopWorkSync,
} from "../../src/services/system/event-loop-work.js";

const EVENT_LOOP_STALL_MONITOR_INTERVAL_MS = 5_000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

interface InstallHistogramArgs {
  maxDelayMs: number;
  meanDelayMs: number;
  p99DelayMs: number;
}

function millisecondsToNanoseconds(durationMs: number): number {
  return durationMs * NANOSECONDS_PER_MILLISECOND;
}

function installHistogram(
  args: InstallHistogramArgs,
): MockEventLoopDelayHistogram {
  const histogram = {
    disable: vi.fn(),
    enable: vi.fn(),
    max: millisecondsToNanoseconds(args.maxDelayMs),
    mean: millisecondsToNanoseconds(args.meanDelayMs),
    percentile: vi.fn(() => millisecondsToNanoseconds(args.p99DelayMs)),
    reset: vi.fn(),
  };
  perfHooksMock.state.histogram = histogram;
  return histogram;
}

const EMPTY_WORK_SNAPSHOT = {
  inFlightWorkAtObservation: null,
  lastCompletedWork: null,
  lastCompletedWorkWallMs: null,
  longestSynchronousWork: null,
  longestSynchronousWorkWallMs: null,
  longestSynchronousWorkCpuMs: null,
  synchronousWorkCpuMs: 0,
};

describe("event loop stall monitor", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "setInterval",
        "clearTimeout",
        "clearInterval",
        "Date",
        "performance",
      ],
    });
    let processCpuUser = 0;
    let mainThreadCpuUser = 0;
    vi.spyOn(process, "cpuUsage").mockImplementation(() => {
      const current = { user: processCpuUser, system: 0 };
      processCpuUser += 5_000_000;
      return current;
    });
    vi.spyOn(process, "threadCpuUsage").mockImplementation(() => {
      const current = { user: mainThreadCpuUser, system: 0 };
      mainThreadCpuUser += 5_000_000;
      return current;
    });
    let minorPageFault = 0;
    let majorPageFault = 0;
    vi.spyOn(process, "resourceUsage").mockImplementation(() => {
      const current = {
        userCPUTime: 0,
        systemCPUTime: 0,
        maxRSS: 0,
        sharedMemorySize: 0,
        unsharedDataSize: 0,
        unsharedStackSize: 0,
        minorPageFault,
        majorPageFault,
        swappedOut: 0,
        fsRead: 0,
        fsWrite: 0,
        ipcSent: 0,
        ipcReceived: 0,
        signalsCount: 0,
        voluntaryContextSwitches: 0,
        involuntaryContextSwitches: 0,
      } satisfies NodeJS.ResourceUsage;
      minorPageFault += 7;
      majorPageFault += 1;
      return current;
    });
    perfHooksMock.monitorEventLoopDelay.mockClear();
    perfHooksMock.state.histogram = null;
    resetEventLoopWorkForTests();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([undefined, 100])(
    "logs and resets at the configured threshold %s",
    (thresholdMs) => {
      const expectedThreshold = thresholdMs ?? 500;
      const histogram = installHistogram({
        maxDelayMs: expectedThreshold,
        meanDelayMs: 25,
        p99DelayMs: 450,
      });
      const logger = { info: vi.fn() };

      const monitor = startEventLoopStallMonitor({ logger, thresholdMs });
      vi.advanceTimersByTime(EVENT_LOOP_STALL_MONITOR_INTERVAL_MS);

      expect(perfHooksMock.monitorEventLoopDelay).toHaveBeenCalledWith({
        resolution: 20,
      });
      expect(histogram.enable).toHaveBeenCalledTimes(1);
      expect(histogram.percentile).toHaveBeenCalledWith(99);
      expect(histogram.reset).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          intervalMs: 5_000,
          maxDelayMs: expectedThreshold,
          meanDelayMs: 25,
          p99DelayMs: 450,
          resolutionMs: 20,
          thresholdMs: expectedThreshold,
          stallAttribution: "unattributed",
          stallCauseCandidate: null,
          processCpuMs: 5_000,
          processCpuWallRatio: 1,
          mainThreadCpuMs: 5_000,
          mainThreadCpuWallRatio: 1,
          minorPageFaults: 7,
          majorPageFaults: 1,
          windowWallMs: 5_000,
          eventLoopUtilization: expect.objectContaining({
            activeMs: expect.any(Number),
            idleMs: expect.any(Number),
            utilization: expect.any(Number),
          }),
          gcPauses: [],
          ...EMPTY_WORK_SNAPSHOT,
        }),
        "Event loop stalled",
      );

      monitor.stop();
    },
  );

  it("restores the normal threshold without restarting the sampler", () => {
    installHistogram({ maxDelayMs: 150, meanDelayMs: 25, p99DelayMs: 100 });
    const logger = { info: vi.fn() };
    let enabled = true;
    const monitor = startEventLoopStallMonitor({
      logger,
      thresholdMs: () => (enabled ? 100 : 500),
    });
    vi.advanceTimersByTime(EVENT_LOOP_STALL_MONITOR_INTERVAL_MS);
    expect(logger.info).toHaveBeenCalledTimes(1);
    enabled = false;
    vi.advanceTimersByTime(EVENT_LOOP_STALL_MONITOR_INTERVAL_MS);
    expect(logger.info).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it("attributes a low process CPU to descheduled work", () => {
    installHistogram({ maxDelayMs: 1_000, meanDelayMs: 25, p99DelayMs: 450 });
    let processCpuUser = 0;
    let mainThreadCpuUser = 0;
    vi.spyOn(process, "cpuUsage").mockImplementation(() => {
      const current = { user: processCpuUser, system: 0 };
      processCpuUser += 100_000;
      return current;
    });
    vi.spyOn(process, "threadCpuUsage").mockImplementation(() => {
      const current = { user: mainThreadCpuUser, system: 0 };
      mainThreadCpuUser += 100_000;
      return current;
    });
    const logger = { info: vi.fn() };
    const monitor = startEventLoopStallMonitor({ logger });
    vi.advanceTimersByTime(EVENT_LOOP_STALL_MONITOR_INTERVAL_MS);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        processCpuMs: 100,
        processCpuWallRatio: 0.02,
        mainThreadCpuMs: 100,
        mainThreadCpuWallRatio: 0.02,
        windowWallMs: 5_000,
        stallAttribution: "candidate",
        stallCauseCandidate: "descheduled",
      }),
      "Event loop stalled",
    );
    monitor.stop();
  });

  it("reports low main-thread CPU when helper threads keep process CPU high", () => {
    installHistogram({ maxDelayMs: 1_000, meanDelayMs: 25, p99DelayMs: 450 });
    let mainThreadCpuUser = 0;
    vi.spyOn(process, "threadCpuUsage").mockImplementation(() => {
      const current = { user: mainThreadCpuUser, system: 0 };
      mainThreadCpuUser += 100_000;
      return current;
    });
    const logger = { info: vi.fn() };
    const monitor = startEventLoopStallMonitor({ logger });
    vi.advanceTimersByTime(EVENT_LOOP_STALL_MONITOR_INTERVAL_MS);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        processCpuWallRatio: 1,
        mainThreadCpuMs: 100,
        mainThreadCpuWallRatio: 0.02,
      }),
      "Event loop stalled",
    );
    monitor.stop();
  });

  it("does not log below the threshold", () => {
    const histogram = installHistogram({
      maxDelayMs: 499,
      meanDelayMs: 25,
      p99DelayMs: 450,
    });
    const logger = { info: vi.fn() };

    const monitor = startEventLoopStallMonitor({ logger });
    vi.advanceTimersByTime(EVENT_LOOP_STALL_MONITOR_INTERVAL_MS);

    expect(logger.info).not.toHaveBeenCalled();
    expect(histogram.reset).toHaveBeenCalledTimes(1);

    monitor.stop();
  });

  it("stops sampling after stop", () => {
    const histogram = installHistogram({
      maxDelayMs: 500,
      meanDelayMs: 25,
      p99DelayMs: 450,
    });
    const logger = { info: vi.fn() };

    const monitor = startEventLoopStallMonitor({ logger });
    monitor.stop();
    vi.advanceTimersByTime(EVENT_LOOP_STALL_MONITOR_INTERVAL_MS);

    expect(histogram.disable).toHaveBeenCalledTimes(1);
    expect(histogram.reset).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("does not attribute an in-flight async wait as the event loop block", async () => {
    installHistogram({
      maxDelayMs: 500,
      meanDelayMs: 25,
      p99DelayMs: 450,
    });
    const logger = { info: vi.fn() };
    const monitor = startEventLoopStallMonitor({ logger });
    let release!: () => void;
    const held = runEventLoopWork(
      "GET /api/v1/threads/thr_example/timeline",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    vi.advanceTimersByTime(EVENT_LOOP_STALL_MONITOR_INTERVAL_MS);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        inFlightWorkAtObservation: "GET /api/v1/threads/thr_example/timeline",
        lastCompletedWork: null,
        lastCompletedWorkWallMs: null,
        longestSynchronousWork: null,
        longestSynchronousWorkWallMs: null,
        stallAttribution: "unattributed",
        stallCauseCandidate: null,
      }),
      "Event loop stalled",
    );

    release();
    await held;
    monitor.stop();
  });

  it("includes the last finished unit of work on the stall report", () => {
    installHistogram({
      maxDelayMs: 500,
      meanDelayMs: 25,
      p99DelayMs: 450,
    });
    const logger = { info: vi.fn() };
    const monitor = startEventLoopStallMonitor({ logger });

    runEventLoopWorkSync("sweep:database-maintenance", () => undefined);
    vi.advanceTimersByTime(EVENT_LOOP_STALL_MONITOR_INTERVAL_MS);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        inFlightWorkAtObservation: null,
        lastCompletedWork: "sweep:database-maintenance",
      }),
      "Event loop stalled",
    );
    const fields = logger.info.mock.calls[0]?.[0] as {
      lastCompletedWorkWallMs: number | null;
    };
    expect(fields.lastCompletedWorkWallMs).toEqual(expect.any(Number));

    monitor.stop();
  });

  it("nests the current work label when units overlap", async () => {
    installHistogram({
      maxDelayMs: 500,
      meanDelayMs: 25,
      p99DelayMs: 450,
    });
    const logger = { info: vi.fn() };
    const monitor = startEventLoopStallMonitor({ logger });
    let release!: () => void;
    const held = runEventLoopWork(
      "GET /api/v1/threads/thr_example/timeline",
      () =>
        runEventLoopWork(
          "timeline-build thr_example",
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        ),
    );

    vi.advanceTimersByTime(EVENT_LOOP_STALL_MONITOR_INTERVAL_MS);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        inFlightWorkAtObservation:
          "GET /api/v1/threads/thr_example/timeline > timeline-build thr_example",
      }),
      "Event loop stalled",
    );

    release();
    await held;
    monitor.stop();
  });

  it("keeps sibling frames when one request finishes first", async () => {
    installHistogram({
      maxDelayMs: 500,
      meanDelayMs: 25,
      p99DelayMs: 450,
    });
    const logger = { info: vi.fn() };
    const monitor = startEventLoopStallMonitor({ logger });
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = runEventLoopWork(
      "GET /api/v1/first",
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const second = runEventLoopWork(
      "GET /api/v1/second",
      () =>
        new Promise<void>((resolve) => {
          releaseSecond = resolve;
        }),
    );

    releaseFirst();
    await first;
    vi.advanceTimersByTime(EVENT_LOOP_STALL_MONITOR_INTERVAL_MS);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        inFlightWorkAtObservation: "GET /api/v1/second",
        lastCompletedWork: "GET /api/v1/first",
      }),
      "Event loop stalled",
    );

    releaseSecond();
    await second;
    monitor.stop();
  });

  it("reports synchronous wall and CPU separately after later short work", () => {
    installHistogram({
      maxDelayMs: 500,
      meanDelayMs: 25,
      p99DelayMs: 450,
    });
    const logger = { info: vi.fn() };
    const nowSpy = vi.spyOn(nodePerformance, "now");
    const cpuSpy = vi.spyOn(process, "threadCpuUsage");
    cpuSpy.mockReturnValueOnce({ user: 1000, system: 0 });
    cpuSpy.mockReturnValueOnce({ user: 2000, system: 0 });
    cpuSpy.mockReturnValueOnce({ user: 10000, system: 0 });
    cpuSpy.mockReturnValueOnce({ user: 100, system: 0 });
    nowSpy.mockReturnValueOnce(0);
    nowSpy.mockReturnValueOnce(650);
    runEventLoopWorkSync("sweep:database-maintenance", () => undefined);
    nowSpy.mockReturnValueOnce(650);
    nowSpy.mockReturnValueOnce(651);
    runEventLoopWorkSync("ws:daemon heartbeat", () => undefined);
    nowSpy.mockRestore();
    cpuSpy.mockRestore();

    const monitor = startEventLoopStallMonitor({ logger });
    vi.advanceTimersByTime(EVENT_LOOP_STALL_MONITOR_INTERVAL_MS);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        lastCompletedWork: "ws:daemon heartbeat",
        lastCompletedWorkWallMs: 1,
        longestSynchronousWork: "sweep:database-maintenance",
        longestSynchronousWorkWallMs: 650,
        longestSynchronousWorkCpuMs: 2,
        stallAttribution: "candidate",
        stallCauseCandidate: "sweep:database-maintenance",
      }),
      "Event loop stalled",
    );

    monitor.stop();
  });

  it("attributes a GC pause as the strongest stall candidate", () => {
    installHistogram({ maxDelayMs: 500, meanDelayMs: 25, p99DelayMs: 450 });
    type SyntheticEntryList = {
      getEntries: () => Array<PerformanceEntry & { kind?: number }>;
    };
    let observerCallback: ((list: SyntheticEntryList) => void) | undefined;
    class SyntheticPerformanceObserver {
      constructor(callback: (list: SyntheticEntryList) => void) {
        observerCallback = callback;
      }
      observe() {}
      disconnect() {}
    }
    const logger = { info: vi.fn() };
    const monitor = startEventLoopStallMonitor({
      logger,
      performanceObserver: SyntheticPerformanceObserver,
    });
    observerCallback?.(
      {
        getEntries: () =>
          [
            { duration: 490, startTime: performance.now(), kind: 2 },
          ] as Array<PerformanceEntry & { kind?: number }>,
      },
    );
    vi.advanceTimersByTime(EVENT_LOOP_STALL_MONITOR_INTERVAL_MS);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        gcPauses: [{ durationMs: 490, kind: 2 }],
        stallAttribution: "candidate",
        stallCauseCandidate: "gc",
      }),
      "Event loop stalled",
    );
    monitor.stop();
  });

  it("attributes a synchronous plugin proxy chunk by its route label", () => {
    installHistogram({ maxDelayMs: 500, meanDelayMs: 25, p99DelayMs: 450 });
    const logger = { info: vi.fn() };
    const nowSpy = vi.spyOn(nodePerformance, "now");
    const cpuSpy = vi.spyOn(process, "threadCpuUsage");
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(520);
    cpuSpy.mockReturnValueOnce({ user: 0, system: 0 });
    cpuSpy.mockReturnValueOnce({ user: 520_000, system: 0 });
    runEventLoopWorkSync("plugin HTTP POST /v1/responses:sync", () => undefined);
    nowSpy.mockRestore();
    cpuSpy.mockRestore();
    const monitor = startEventLoopStallMonitor({ logger });
    vi.advanceTimersByTime(EVENT_LOOP_STALL_MONITOR_INTERVAL_MS);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        longestSynchronousWork: "plugin HTTP POST /v1/responses:sync",
        stallAttribution: "candidate",
        stallCauseCandidate: "plugin HTTP POST /v1/responses:sync",
      }),
      "Event loop stalled",
    );
    monitor.stop();
  });

  it("leaves a two-second stall unattributed when measured work took one millisecond", () => {
    installHistogram({ maxDelayMs: 2_000, meanDelayMs: 25, p99DelayMs: 450 });
    const logger = { info: vi.fn() };
    const nowSpy = vi.spyOn(nodePerformance, "now");
    let mainThreadCpuUser = 0;
    vi.spyOn(process, "threadCpuUsage").mockImplementation(() => {
      const current = { user: mainThreadCpuUser, system: 0 };
      mainThreadCpuUser += 1_000;
      return current;
    });
    try {
      nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1);
      runEventLoopWorkSync("ws:daemon heartbeat", () => undefined);
    } finally {
      nowSpy.mockRestore();
    }
    const monitor = startEventLoopStallMonitor({ logger });
    try {
      vi.advanceTimersByTime(EVENT_LOOP_STALL_MONITOR_INTERVAL_MS);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          maxDelayMs: 2_000,
          longestSynchronousWork: "ws:daemon heartbeat",
          longestSynchronousWorkWallMs: 1,
          stallAttribution: "unattributed",
          stallCauseCandidate: "ws:daemon heartbeat",
        }),
        "Event loop stalled",
      );
    } finally {
      monitor.stop();
    }
  });

  it("serializes CPU profiles outside the server thread", async () => {
    installHistogram({ maxDelayMs: 0, meanDelayMs: 0, p99DelayMs: 0 });
    const db = createMigratedConnection();
    setExperiments(db, { performanceDiagnostics: true });
    const dataDir = await mkdtemp(join(tmpdir(), "bb-profile-attribution-"));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const stringify = JSON.stringify;
    const serializedProfiles: unknown[] = [];
    const stringifySpy = vi
      .spyOn(JSON, "stringify")
      .mockImplementation((value, replacer, space) => {
        if (value && Array.isArray(value.nodes)) serializedProfiles.push(value);
        return stringify(value, replacer, space);
      });
    let recorder:
      | Awaited<ReturnType<typeof startGatedPerformanceDiagnostics>>
      | undefined;
    try {
      recorder = await startGatedPerformanceDiagnostics({
        allowed: true,
        dataDir,
        db,
        hub: new NotificationHub(),
        logger,
      });
      await recorder.stop();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          path: expect.stringMatching(/\.cpuprofile$/),
        }),
        "Server CPU profile saved",
      );
      expect(serializedProfiles).toEqual([]);
    } finally {
      await recorder?.stop();
      stringifySpy.mockRestore();
      db.$client.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
