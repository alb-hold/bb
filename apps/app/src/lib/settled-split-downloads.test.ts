// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./plugin-module-preload", () => ({
  preloadPluginModule: vi.fn(async () => true),
}));
let cancel = () => {};
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("performance", { getEntriesByName: () => [] });
  vi.stubGlobal("requestIdleCallback", (callback: () => void) =>
    window.setTimeout(callback, 1),
  );
  vi.stubGlobal("cancelIdleCallback", (id: number) => window.clearTimeout(id));
  document.body.innerHTML =
    '<script id="bb-prefetch-thread-detail" type="application/json">["/first.js","/second.js"]</script><script id="bb-prefetch-terminal-runtime" type="application/json">["/terminal.js"]</script>';
});
afterEach(() => {
  cancel();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const response = () => ({
  ok: true,
  arrayBuffer: async () => new ArrayBuffer(0),
});

it("downloads quiet home serially and yields the next asset to typing", async () => {
  const { scheduleSettledSplitDownloads } =
    await import("./settled-split-downloads");
  let completeFirst: (() => void) | undefined;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeFirst = () => resolve(response());
        }),
    )
    .mockImplementation(async () => response());
  vi.stubGlobal("fetch", fetch);
  cancel = scheduleSettledSplitDownloads(
    ["thread-detail", "terminal-runtime"],
    () => true,
  );
  expect(fetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(500);
  expect(fetch).toHaveBeenCalledTimes(1);
  document.dispatchEvent(new Event("input", { bubbles: true }));
  completeFirst!();
  await vi.advanceTimersByTimeAsync(999);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4);
  expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    "/first.js",
    "/second.js",
    "/terminal.js",
  ]);
  expect(fetch).toHaveBeenCalledWith(expect.any(String), {
    cache: "force-cache",
    priority: "low",
  });
});

it("lets intent imports bypass a paused background queue", async () => {
  const { scheduleSettledSplitDownloads } =
    await import("./settled-split-downloads");
  const { prepareSplitImport } = await import("./split-prefetch");
  const fetch = vi.fn(async (_url: string) => response());
  vi.stubGlobal("fetch", fetch);
  cancel = scheduleSettledSplitDownloads(
    ["thread-detail", "terminal-runtime"],
    () => true,
  );
  let imported = false;
  void prepareSplitImport("thread-detail").then(() => {
    imported = true;
  });
  await Promise.resolve();
  expect(imported).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(15_010);
  expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    "/terminal.js",
  ]);
});

it.each(["unmount", "navigation"])(
  "stops queued work on %s",
  async (reason) => {
    const { scheduleSettledSplitDownloads } =
      await import("./settled-split-downloads");
    let active = true;
    const fetch = vi.fn(async (_url: string) => response());
    vi.stubGlobal("fetch", fetch);
    cancel = scheduleSettledSplitDownloads(["thread-detail"], () => active);
    if (reason === "unmount") cancel();
    else active = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("retries a failed background asset on demand", async () => {
  const { downloadSplitInBackground, downloadSplit } =
    await import("./split-prefetch");
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockImplementation(async () => response());
  vi.stubGlobal("fetch", fetch);
  await downloadSplitInBackground("thread-detail", async () => true);
  await downloadSplit("thread-detail");
  expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    "/first.js",
    "/second.js",
    "/first.js",
  ]);
});

it("starts quiet home downloads immediately instead of waiting fifteen seconds", async () => {
  const { scheduleSettledSplitDownloads } =
    await import("./settled-split-downloads");
  const fetch = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetch);
  cancel = scheduleSettledSplitDownloads(["thread-detail"], () => true);
  await vi.advanceTimersByTimeAsync(10);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("serializes separate producers and pauses every evaluation for a full second after input", async () => {
  const { createSettledWorkSchedule } =
    await import("./settled-split-downloads");
  const first = createSettledWorkSchedule(() => true);
  const second = createSettledWorkSchedule(() => true);
  cancel = () => {
    first.cancel();
    second.cancel();
  };
  const evaluations: number[] = [];
  let finish = () => {};
  const pending = first.run(async () => {
    evaluations.push(Date.now());
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const next = second.run(async () => {
    evaluations.push(Date.now());
  });
  await vi.advanceTimersByTimeAsync(10);
  expect(evaluations).toHaveLength(1);
  document.dispatchEvent(new Event("input", { bubbles: true }));
  finish();
  await pending;
  await vi.advanceTimersByTimeAsync(999);
  expect(evaluations).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(10);
  await next;
  expect(evaluations).toHaveLength(2);
  expect(evaluations[1]! - evaluations[0]!).toBeGreaterThanOrEqual(1_010);
});

it("does not evaluate between IME composition events even after a long pause", async () => {
  const { createSettledWorkSchedule } =
    await import("./settled-split-downloads");
  const schedule = createSettledWorkSchedule(() => true);
  cancel = schedule.cancel;
  const evaluate = vi.fn(async () => {});
  document.dispatchEvent(
    new CompositionEvent("compositionstart", { bubbles: true }),
  );
  const done = schedule.run(evaluate);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(evaluate).not.toHaveBeenCalled();
  document.dispatchEvent(
    new CompositionEvent("compositionend", { bubbles: true }),
  );
  await vi.advanceTimersByTimeAsync(999);
  expect(evaluate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10);
  await done;
  expect(evaluate).toHaveBeenCalledOnce();
});

it("imports dependency chunks in separate quiet tasks without fetching them twice", async () => {
  const { createSettledWorkSchedule } =
    await import("./settled-split-downloads");
  const { prepareBackgroundSplit } = await import("./split-prefetch");
  const evaluations: number[] = [];
  vi.stubGlobal("__p41Evaluations", evaluations);
  const dependency =
    "data:text/javascript," +
    encodeURIComponent(
      'globalThis.__p41Evaluations.push(Date.now()); document.dispatchEvent(new Event("input", { bubbles: true }));',
    );
  const parent =
    "data:text/javascript," +
    encodeURIComponent(
      `import ${JSON.stringify(dependency)}; globalThis.__p41Evaluations.push(Date.now());`,
    );
  document.getElementById("bb-prefetch-thread-detail")!.textContent =
    JSON.stringify([dependency, parent]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response()),
  );
  const schedule = createSettledWorkSchedule(() => true);
  cancel = schedule.cancel;
  const done = prepareBackgroundSplit("thread-detail", schedule.run);
  await vi.waitFor(() => expect(evaluations).toHaveLength(1));
  const inputAt = evaluations[0]!;
  await vi.advanceTimersByTimeAsync(500);
  expect(evaluations).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(600);
  await vi.waitFor(() => expect(evaluations).toHaveLength(2));
  await done;
  expect(evaluations[1]! - inputAt).toBeGreaterThanOrEqual(1_000);
  expect(fetch).not.toHaveBeenCalled();
});
