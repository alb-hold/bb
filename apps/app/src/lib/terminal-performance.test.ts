import { afterEach, expect, it } from "vitest";
import { PerformanceObserver } from "node:perf_hooks";
import {
  markTerminalPerformance,
  traceTerminalGate,
} from "./terminal-performance";

const name = "terminal-replay-parsed";

afterEach(() => performance.clearMarks(name));

it("bounds retained marks while delivering every replay timing to observers", async () => {
  const received = new Promise<number>((resolve) => {
    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntriesByName(name);
      observer.disconnect();
      resolve(entries.length);
    });
    observer.observe({ entryTypes: ["mark"] });
  });
  for (let index = 0; index < 10_000; index++) {
    markTerminalPerformance(name, { detail: { terminalId: String(index) } });
  }
  expect(await received).toBe(10_000);
  const retained = performance.getEntriesByName(name);
  expect(retained).toHaveLength(1);
  expect(retained[0]).toMatchObject({ detail: { terminalId: "9999" } });
});

it("records a rejected gate and bounds repeated gate timings", async () => {
  const failure = new Error("download unavailable");
  try {
    for (let i = 0; i < 3; i++) {
      await expect(
        traceTerminalGate("terminal-test-gate", () => Promise.reject(failure)),
      ).rejects.toBe(failure);
    }
    expect(
      performance.getEntriesByName("terminal-test-gate-start"),
    ).toHaveLength(1);
    expect(performance.getEntriesByName("terminal-test-gate-end")).toHaveLength(
      1,
    );
    expect(
      performance.getEntriesByName("terminal-test-gate-end")[0],
    ).toMatchObject({ detail: { outcome: "rejected" } });
    await traceTerminalGate("terminal-test-gate", async () => "loaded");
    expect(
      performance.getEntriesByName("terminal-test-gate-end")[0],
    ).toMatchObject({ detail: { outcome: "resolved" } });
  } finally {
    performance.clearMarks("terminal-test-gate-start");
    performance.clearMarks("terminal-test-gate-end");
  }
});
