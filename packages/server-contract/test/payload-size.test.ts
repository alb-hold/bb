import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { ThreadTimelineResponse } from "../src/api-types.js";
import {
  applyThreadTimelineDelta,
  computeThreadTimelineDelta,
} from "../src/thread-timeline-delta.js";
import type { TimelineRow } from "../src/thread-timeline.js";

interface PayloadSize {
  gzipBytes: number;
  jsonBytes: number;
}

interface WindowMeasurement {
  appendDelta: PayloadSize;
  appendResult: ThreadTimelineResponse | null;
  appended: ThreadTimelineResponse;
  full: PayloadSize;
  rowCount: number;
  streamDelta: PayloadSize;
  streamResult: ThreadTimelineResponse | null;
  streamed: ThreadTimelineResponse;
}

const GZIP_TOLERANCE = 0.05;
const WINDOW_SIZES = [1, 20, 100] as const;

function payloadSize(value: unknown): PayloadSize {
  const json = JSON.stringify(value);
  return {
    gzipBytes: gzipSync(json).byteLength,
    jsonBytes: Buffer.byteLength(json),
  };
}

function row(index: number, detail = "stable"): TimelineRow {
  return {
    id: `timeline-row-${String(index).padStart(4, "0")}`,
    kind: "system",
    threadId: "thr_payload_measurement_123456789",
    turnId: "turn_payload_measurement_123456789",
    sourceSeqStart: index + 1,
    sourceSeqEnd: index + 1,
    startedAt: 1_750_000_000_000 + index,
    createdAt: 1_750_000_000_000 + index,
    systemKind: "debug",
    title: `Timeline measurement row ${index}`,
    detail,
    status: null,
  };
}

function window(
  rows: TimelineRow[],
  tag: string,
  maxSeq: number,
): ThreadTimelineResponse {
  return {
    rows,
    contextBoundarySeq: null,
    completedTurnDisplay: "flat",
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    activeBackgroundCommands: [],
    pendingTodos: null,
    goal: null,
    providerCommands: null,
    sessionOptions: null,
    modelFallback: null,
    timelinePage: {
      returnedSegmentCount: 1,
      olderCursor: null,
      historySnapshot: "snapshot",
      olderRowsSourceSeqEnd: null,
    },
    maxSeq,
    tag,
  };
}

function measureWindow(rowCount: number): WindowMeasurement {
  const rows = Array.from({ length: rowCount }, (_, index) => row(index));
  const previous = window(rows, `tag-${rowCount}`, rowCount);
  const streamed = window(
    rows.map((item, index) =>
      index === rowCount - 1
        ? row(index, "streamed update ".repeat(20))
        : item,
    ),
    `tag-${rowCount}-streamed`,
    rowCount + 1,
  );
  const appended = window(
    [...rows, row(rowCount)],
    `tag-${rowCount}-appended`,
    rowCount + 1,
  );
  const appendDelta = computeThreadTimelineDelta(previous, appended);
  const streamDelta = computeThreadTimelineDelta(previous, streamed);
  return {
    appendDelta: payloadSize(appendDelta),
    appendResult: applyThreadTimelineDelta(previous, appendDelta),
    appended,
    full: payloadSize(streamed),
    rowCount,
    streamDelta: payloadSize(streamDelta),
    streamResult: applyThreadTimelineDelta(previous, streamDelta),
    streamed,
  };
}

function assertWithinBudget(
  label: string,
  size: PayloadSize,
  budget: PayloadSize,
): void {
  if (size.jsonBytes > budget.jsonBytes) {
    throw new Error(
      `${label}: ${size.jsonBytes} JSON bytes exceeds the budget of ${budget.jsonBytes}`,
    );
  }
  if (size.gzipBytes > budget.gzipBytes * (1 + GZIP_TOLERANCE)) {
    throw new Error(
      `${label}: ${size.gzipBytes} gzip bytes exceeds the budget of ${budget.gzipBytes} + ${GZIP_TOLERANCE * 100}%`,
    );
  }
}

const STREAM_DELTA_BUDGET: Record<number, PayloadSize> = {
  1: { gzipBytes: 268, jsonBytes: 719 },
  20: { gzipBytes: 272, jsonBytes: 725 },
  100: { gzipBytes: 273, jsonBytes: 730 },
};

const APPEND_DELTA_BUDGET: Record<number, PayloadSize> = {
  1: { gzipBytes: 276, jsonBytes: 444 },
  20: { gzipBytes: 278, jsonBytes: 451 },
  100: { gzipBytes: 278, jsonBytes: 458 },
};

describe("server-to-browser timeline payload sizes", () => {
  const measurements = WINDOW_SIZES.map(measureWindow);

  it("keeps a streamed update to one row within its recorded budget at every window size", () => {
    for (const measurement of measurements) {
      const budget = STREAM_DELTA_BUDGET[measurement.rowCount];
      if (budget === undefined) throw new Error("missing stream budget");
      assertWithinBudget(
        `stream delta of ${measurement.rowCount} rows`,
        measurement.streamDelta,
        budget,
      );
      expect(measurement.streamResult).toEqual(measurement.streamed);
      expect(measurement.streamResult?.rows.at(-1)).toEqual(
        row(measurement.rowCount - 1, "streamed update ".repeat(20)),
      );
    }
  });

  it("keeps an appended row within its recorded budget at every window size", () => {
    for (const measurement of measurements) {
      const budget = APPEND_DELTA_BUDGET[measurement.rowCount];
      if (budget === undefined) throw new Error("missing append budget");
      assertWithinBudget(
        `append delta of ${measurement.rowCount} rows`,
        measurement.appendDelta,
        budget,
      );
      expect(measurement.appendResult).toEqual(measurement.appended);
      expect(measurement.appendResult?.rows.map((item) => item.id)).toEqual(
        measurement.appended.rows.map((item) => item.id),
      );
      expect(measurement.appendResult?.rows.at(-1)?.id).toBe(
        row(measurement.rowCount).id,
      );
    }
  });

  it("does not grow a streamed-update delta with the window size", () => {
    const sizes = measurements.map(({ streamDelta }) => streamDelta.jsonBytes);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(16);
  });

  it("sends a delta far smaller than the full window it replaces", () => {
    const widest = measurements.at(-1);
    if (widest === undefined) throw new Error("missing measurement");
    expect(widest.streamDelta.jsonBytes * 20).toBeLessThan(
      widest.full.jsonBytes,
    );
    expect(widest.appendDelta.jsonBytes * 10).toBeLessThan(
      widest.full.jsonBytes,
    );
  });

  it("fails a delta that carries the whole row order", () => {
    const widest = measurements.at(-1);
    if (widest === undefined) throw new Error("missing measurement");
    const rows = Array.from({ length: 100 }, (_, index) => row(index));
    const bloated = payloadSize({
      ...computeThreadTimelineDelta(
        window(rows, "tag-a", 100),
        window(rows, "tag-b", 101),
      ),
      rowOrder: rows.map((item) => item.id),
    });
    expect(() =>
      assertWithinBudget(
        "bloated delta",
        bloated,
        STREAM_DELTA_BUDGET[100] ?? widest.streamDelta,
      ),
    ).toThrow(/exceeds the budget/);
  });
});
