// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";

let cancel = () => {};
afterEach(() => {
  cancel();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([true, false])(
  "warms every deferred home interaction only after readiness, paint and idle (native idle=%s)",
  async (nativeIdle) => {
    vi.resetModules();
    const { HOME_INTERACTION_SPLITS, scheduleHomeInteractionPreloads } =
      await import("./home-interaction-preloads");
    expect(HOME_INTERACTION_SPLITS).toEqual([
      "thread-detail",
      "root-compose-panel-tab-content",
      "thread-action-menu-items",
      "prompt-voice-runtime",
      "model-reasoning-picker-body",
      "model-reasoning-menu",
      "extended-icons",
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
    if (nativeIdle) idle.shift()!();
    else await vi.advanceTimersByTimeAsync(1_000);
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
