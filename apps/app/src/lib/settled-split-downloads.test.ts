// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";

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

it("waits for settled home, downloads serially, and yields the next asset to typing", async () => {
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
  await vi.advanceTimersByTimeAsync(15_000);
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
    await vi.advanceTimersByTimeAsync(15_000);
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
