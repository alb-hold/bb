// @vitest-environment jsdom
import { performance as nodePerformance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";

const gate = "terminal-runtime-preload";

afterEach(() => {
  nodePerformance.clearMarks(`${gate}-start`);
  nodePerformance.clearMarks(`${gate}-end`);
  vi.doUnmock("@xterm/xterm");
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("loads a usable terminal on a deep link without a preload", async () => {
  const { importTerminalModules } = await import("./terminal-modules");
  const [{ Terminal }, { FitAddon }, { Unicode11Addon }] =
    await importTerminalModules();
  const terminal = new Terminal({
    cols: 71,
    rows: 29,
    allowProposedApi: true,
  });
  try {
    terminal.loadAddon(new FitAddon());
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    await new Promise<void>((resolve) => terminal.write("deep link", resolve));
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(
      "deep link",
    );
    expect(terminal.cols).toBe(71);
    expect(terminal.rows).toBe(29);
  } finally {
    terminal.dispose();
  }
});

it("retains the first preload timings when later panel consumers preload again", async () => {
  vi.stubGlobal("performance", nodePerformance);
  const { importTerminalModules, preloadTerminalModules } =
    await import("./terminal-modules");
  preloadTerminalModules();
  await importTerminalModules();
  await Promise.resolve();
  const start = performance.getEntriesByName(`${gate}-start`)[0]?.startTime;
  const end = performance.getEntriesByName(`${gate}-end`)[0]?.startTime;
  expect(start).toBeTypeOf("number");
  expect(end).toBeTypeOf("number");
  await new Promise((resolve) => setTimeout(resolve, 1));
  preloadTerminalModules();
  await importTerminalModules();
  await Promise.resolve();
  expect(performance.getEntriesByName(`${gate}-start`)[0]?.startTime).toBe(
    start,
  );
  expect(performance.getEntriesByName(`${gate}-end`)[0]?.startTime).toBe(end);
});

it("retries a rejected runtime import on the next open", async () => {
  vi.stubGlobal("performance", nodePerformance);
  vi.doMock("@xterm/xterm", () => {
    throw new Error("runtime download unavailable");
  });
  const { importTerminalModules, preloadTerminalModules } =
    await import("./terminal-modules");
  preloadTerminalModules();
  await expect(importTerminalModules()).rejects.toThrow(
    "runtime download unavailable",
  );
  await Promise.resolve();
  expect(performance.getEntriesByName(`${gate}-end`)[0]).toMatchObject({
    detail: { outcome: "rejected" },
  });
  vi.doUnmock("@xterm/xterm");
  preloadTerminalModules();
  const [{ Terminal }] = await importTerminalModules();
  await Promise.resolve();
  const terminal = new Terminal({ cols: 40, rows: 31 });
  try {
    await new Promise<void>((resolve) => terminal.write("retried", resolve));
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(
      "retried",
    );
    expect(performance.getEntriesByName(`${gate}-end`)[0]).toMatchObject({
      detail: { outcome: "resolved" },
    });
  } finally {
    terminal.dispose();
  }
});
