// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";

let cancel = () => {};
beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 100, 20),
  );
  vi.stubGlobal("performance", {
    mark: vi.fn(),
    getEntriesByName: () => [],
  });
});
afterEach(() => {
  cancel();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([true, false])(
  "warms the first-click model picker only after readiness, paint and idle (native idle=%s)",
  async (nativeIdle) => {
    vi.resetModules();
    const {
      HOME_INTERACTION_SPLITS,
      HOME_SETTLED_SPLITS,
      scheduleHomeInteractionPreloads,
    } = await import("./home-interaction-preloads");
    expect(HOME_INTERACTION_SPLITS).toEqual([
      "model-reasoning-picker-body",
      "model-reasoning-menu",
    ]);
    expect(HOME_SETTLED_SPLITS).toEqual([
      "thread-detail",
      "thread-terminal",
      "terminal-runtime",
      "terminal-fit",
      "terminal-unicode",
      "terminal-webgl",
      "terminal-search",
      "terminal-web-links",
    ]);
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/");
    const frames: FrameRequestCallback[] = [];
    const idle: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "requestIdleCallback",
      nativeIdle
        ? vi.fn((callback: () => void) => {
            idle.push(callback);
            return 1;
          })
        : undefined,
    );
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    vi.stubGlobal("fetch", fetch);
    for (const id of HOME_INTERACTION_SPLITS) {
      const script = document.createElement("script");
      script.id = `bb-prefetch-${id}`;
      script.type = "application/json";
      script.textContent = JSON.stringify([`/assets/${id}-${nativeIdle}.js`]);
      document.body.append(script);
    }
    cancel = scheduleHomeInteractionPreloads();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetch).not.toHaveBeenCalled();
    const input = document.createElement("textarea");
    document.body.append(input);
    await Promise.resolve();
    expect(frames).toHaveLength(0);
    const row = document.createElement("div");
    row.dataset.sidebarThreadId = "thread";
    document.body.append(row);
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
    frames.shift()!(0);
    expect(fetch).not.toHaveBeenCalled();
    frames.shift()!(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(performance.mark).toHaveBeenCalledExactlyOnceWith(
      "app-home-composer-ready",
    );
    expect(idle).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(249);
    expect(fetch).not.toHaveBeenCalled();
    expect(idle).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    if (nativeIdle) idle.shift()!();
    else {
      await vi.advanceTimersByTimeAsync(999);
      expect(fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
    }
    await Promise.resolve();
    expect(
      fetch.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual(
      HOME_INTERACTION_SPLITS.map((id) => `/assets/${id}-${nativeIdle}.js`),
    );
    expect(fetch).toHaveBeenCalledWith(expect.any(String), {
      cache: "force-cache",
      priority: "low",
    });
  },
);

it("cancels pending warming when the route unmounts", async () => {
  const { scheduleHomeInteractionPreloads } =
    await import("./home-interaction-preloads");
  document.body.innerHTML =
    '<textarea></textarea><div data-sidebar-thread-id="thread"></div>';
  const frame = vi.fn(() => 1);
  const cancelFrame = vi.fn();
  vi.stubGlobal("requestAnimationFrame", frame);
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  cancel = scheduleHomeInteractionPreloads();
  cancel();
  expect(frame).toHaveBeenCalledOnce();
  expect(cancelFrame).toHaveBeenCalledWith(1);
});

it.each(["hidden", "empty"])(
  "does not prefetch thread details for a %s composer that exists before readiness",
  async (state) => {
    vi.resetModules();
    vi.useFakeTimers();
    const { scheduleHomeInteractionPreloads } =
      await import("./home-interaction-preloads");
    document.body.innerHTML =
      '<textarea></textarea><div data-sidebar-thread-id="thread"></div><script id="bb-prefetch-model-reasoning-picker-body" type="application/json">["/assets/model-reasoning-picker-body.js"]</script>';
    const input = document.querySelector("textarea")!;
    input.checkVisibility = () => true;
    if (state === "hidden") input.style.visibility = "hidden";
    const box = vi.spyOn(input, "getBoundingClientRect");
    if (state === "empty") box.mockReturnValue(new DOMRect());
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 16),
    );
    vi.stubGlobal("cancelAnimationFrame", window.clearTimeout);
    vi.stubGlobal("requestIdleCallback", undefined);
    const fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    vi.stubGlobal("fetch", fetch);
    cancel = scheduleHomeInteractionPreloads();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(performance.mark).not.toHaveBeenCalled();
    input.style.visibility = "visible";
    box.mockReturnValue(new DOMRect(0, 0, 100, 20));
    input.className = "mounted";
    await vi.advanceTimersByTimeAsync(32);
    expect(performance.mark).toHaveBeenCalledExactlyOnceWith(
      "app-home-composer-ready",
    );
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_250);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("/assets/model-reasoning-picker-body.js"),
      { cache: "force-cache", priority: "low" },
    );
  },
);

it("cancels the post-ready delay before an idle fallback can start", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  const { scheduleHomeInteractionPreloads } =
    await import("./home-interaction-preloads");
  document.body.innerHTML =
    '<textarea></textarea><div data-sidebar-thread-id="thread"></div><script id="bb-prefetch-model-reasoning-picker-body" type="application/json">["/assets/model-reasoning-picker-body.js"]</script>';
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", window.clearTimeout);
  vi.stubGlobal("requestIdleCallback", undefined);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  cancel = scheduleHomeInteractionPreloads();
  await vi.advanceTimersByTimeAsync(32);
  expect(performance.mark).toHaveBeenCalledExactlyOnceWith(
    "app-home-composer-ready",
  );
  cancel();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetch).not.toHaveBeenCalled();
});
