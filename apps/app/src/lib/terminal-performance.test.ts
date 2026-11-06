import { afterEach, expect, it } from "vitest";
import { PerformanceObserver } from "node:perf_hooks";
import { markTerminalPerformance } from "./terminal-performance";

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
