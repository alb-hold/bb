// @vitest-environment jsdom
import { performance as nodePerformance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";

const importGate = vi.hoisted(() => {
  vi.resetModules();
  let enter!: () => void;
  let reject!: (error: Error) => void;
  return {
    entered: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    pending: new Promise<never>((_resolve, rejectImport) => {
      reject = rejectImport;
    }),
    enter: () => enter(),
    reject: (error: Error) => reject(error),
  };
});

vi.mock("@xterm/addon-unicode11", async () => {
  importGate.enter();
  return importGate.pending;
});

afterEach(async () => {
  await vi.dynamicImportSettled();
  nodePerformance.clearMarks("terminal-runtime-preload-start");
  nodePerformance.clearMarks("terminal-runtime-preload-end");
  vi.doUnmock("@xterm/addon-unicode11");
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("retries a rejected runtime import on the next open", async () => {
  vi.stubGlobal("performance", nodePerformance);
  const { importTerminalModules, preloadTerminalModules } =
    await import("./terminal-modules");
  preloadTerminalModules();
  const firstOpen = importTerminalModules();
  const failure = new Error("runtime download unavailable");
  const rejected = expect(firstOpen).rejects.toMatchObject({ cause: failure });
  await importGate.entered;
  importGate.reject(failure);
  await rejected;
  await vi.dynamicImportSettled();
  expect(
    performance.getEntriesByName("terminal-runtime-preload-end")[0],
  ).toMatchObject({ detail: { outcome: "rejected" } });
  vi.doUnmock("@xterm/addon-unicode11");
  preloadTerminalModules();
  const [{ Terminal }] = await importTerminalModules();
  await vi.dynamicImportSettled();
  const terminal = new Terminal({ cols: 40, rows: 31 });
  try {
    await new Promise<void>((resolve) => terminal.write("retried", resolve));
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(
      "retried",
    );
    expect(
      performance.getEntriesByName("terminal-runtime-preload-end")[0],
    ).toMatchObject({ detail: { outcome: "resolved" } });
  } finally {
    terminal.dispose();
  }
});
