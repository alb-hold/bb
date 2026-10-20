import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTerminalLatencyDiagnostics,
  recordTerminalInputEnqueued,
  recordTerminalOutputReceived,
  recordTerminalOutputRendered,
} from "./terminal-latency-diagnostics.js";

describe("terminal latency diagnostics", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { innerWidth: 1300 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a fixed-size rolling sample and stores numeric measurements only", () => {
    for (let index = 0; index < 400; index += 1) {
      recordTerminalInputEnqueued(index);
      recordTerminalOutputReceived(index + 1);
      recordTerminalOutputRendered(index, index + 2);
    }

    const snapshot = getTerminalLatencyDiagnostics();
    expect(snapshot.desktop.outputRenderMs.count).toBe(256);
    expect(snapshot.desktop.outputRenderMs.p50Ms).toBe(2);
    expect(snapshot.desktop.outputRenderMs.p95Ms).toBe(2);
    expect(snapshot.desktop.inputToFirstOutputReceivedMs.count).toBe(25);
    expect(snapshot.desktop.inputToFirstOutputRenderMs.count).toBe(25);
    const recordedValues = Object.values(snapshot.desktop).flatMap((metric) => [
      metric.count,
      metric.p50Ms,
      metric.p95Ms,
    ]);
    expect(recordedValues.every((value) => typeof value === "number" || value === null)).toBe(true);
    for (const formFactor of [snapshot.desktop, snapshot.phone]) {
      for (const metric of Object.values(formFactor)) {
        expect(Object.keys(metric)).toEqual(["count", "p50Ms", "p95Ms"]);
        expect(Object.values(metric).every((value) => typeof value === "number" || value === null)).toBe(true);
      }
    }
  });

  it("keeps phone and desktop timing samples separate", () => {
    vi.stubGlobal("window", { innerWidth: 390 });
    recordTerminalOutputRendered(5, 11);

    const snapshot = getTerminalLatencyDiagnostics();
    expect(snapshot.phone.outputRenderMs.p50Ms).toBe(6);
    expect(snapshot.desktop.outputRenderMs.p50Ms).toBe(2);
  });
});
