// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { definePluginApp } from "./plugin-app-definition";
import {
  createPluginFrontendReconcileState,
  reconcilePluginFrontends,
  type PluginFrontendCandidate,
  type PluginFrontendReconcileDeps,
} from "./plugin-frontend";

let dispose = () => {};
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("performance", { mark: vi.fn() });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    })),
  );
  vi.stubGlobal("requestIdleCallback", (callback: () => void) =>
    window.setTimeout(callback, 1),
  );
  vi.stubGlobal("cancelIdleCallback", (id: number) => window.clearTimeout(id));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(Date.now()), 1),
  );
  window.history.replaceState(null, "", "/");
  document.body.innerHTML =
    "<div data-app-composer><textarea></textarea></div>";
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function start(
  overrides: Partial<PluginFrontendReconcileDeps> = {},
  runtimeSlots: string[] = [],
) {
  const { createDeferredPluginFrontendSchedule } =
    await import("./deferred-plugin-frontend-schedule");
  const { markRouteContentPainted } = await import("./route-content-paint");
  const { markHomeComposerReady } = await import("./home-composer-ready");
  const schedule = createDeferredPluginFrontendSchedule();
  dispose = schedule.dispose;
  const module = {
    default: definePluginApp((app) => {
      app.slots.homepageSection({
        id: "section",
        title: "Section",
        component: () => null,
      });
    }),
  };
  const candidate = (pluginId: string): PluginFrontendCandidate => ({
    pluginId,
    bundle: {
      jsUrl: `/plugins/${pluginId}.js`,
      cssUrl: `/plugins/${pluginId}.css`,
      jsBytes: 100,
      hash: "h",
      sdkMajor: 0,
      sdkVersion: "0.1.0",
      compatible: true,
      runtimeSlots: pluginId === "git" ? runtimeSlots : [],
    },
  });
  const imports = vi.fn(async (_url: string) => module);
  const prefetch = vi.fn();
  const deps: PluginFrontendReconcileDeps = {
    fetchCandidates: async () => ["thread-list", "git", "usage"].map(candidate),
    importModule: imports,
    importRetryDelaysMs: [],
    applyCss: vi.fn(),
    prefetchCss: vi.fn(),
    prefetchModule: prefetch,
    retainCss: () => () => {},
    resetCrashedSlots: vi.fn(),
    setRegistrations: vi.fn(),
    removeRegistrations: vi.fn(),
    warn: vi.fn(),
    priorityPluginIds: () => ["thread-list"],
    beginSlotBatch: () => () => {},
    flushSlotBatch: () => {},
    ...schedule,
    ...overrides,
  };
  markRouteContentPainted();
  const done = reconcilePluginFrontends(
    createPluginFrontendReconcileState(),
    deps,
  );
  await vi.advanceTimersByTimeAsync(0);
  return { imports, prefetch, done, markHomeComposerReady };
}

it("keeps non-home plugin downloads behind ready and input-aware idle", async () => {
  const h = await start();
  expect(h.imports.mock.calls.flat()).toEqual(["/plugins/thread-list.js"]);
  await vi.advanceTimersByTimeAsync(12_000);
  expect(h.imports).toHaveBeenCalledTimes(1);
  expect(h.prefetch).not.toHaveBeenCalled();
  h.markHomeComposerReady();
  expect(h.imports).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(100);
  await h.done;
  expect(h.imports.mock.calls.flat()).toEqual([
    "/plugins/thread-list.js",
    "/plugins/git.js",
    "/plugins/usage.js",
  ]);
});

it("paces evaluations and yields the next bundle while the user types", async () => {
  const h = await start();
  const module = await h.imports.mock.results[0]!.value;
  let finish = () => {};
  h.imports.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(module);
      }),
  );
  h.markHomeComposerReady();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.imports).toHaveBeenCalledTimes(2);
  document
    .querySelector("textarea")!
    .dispatchEvent(new Event("input", { bubbles: true }));
  finish();
  await vi.advanceTimersByTimeAsync(999);
  expect(h.imports).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(100);
  await h.done;
  expect(h.imports).toHaveBeenCalledTimes(3);
});

it("can release on explicit composer input when an empty sidebar has no ready mark", async () => {
  const h = await start();
  document
    .querySelector("textarea")!
    .dispatchEvent(new Event("input", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(999);
  expect(h.imports).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(100);
  await h.done;
  expect(h.imports).toHaveBeenCalledTimes(3);
});

it.each([false, true])(
  "lets navigation escape the home wait but waits for terminal paint (marked=%s)",
  async (marked) => {
    const h = await start();
    if (marked) {
      h.markHomeComposerReady();
    }
    window.history.pushState(null, "", "/threads/terminal");
    document.body.replaceChildren();
    window.dispatchEvent(new PopStateEvent("popstate"));
    await vi.advanceTimersByTimeAsync(500);
    expect(h.imports).toHaveBeenCalledTimes(1);
    document.body.innerHTML = '<div class="xterm-screen"></div>';
    await vi.advanceTimersByTimeAsync(30);
    await h.done;
    expect(h.imports).toHaveBeenCalledTimes(3);
  },
);

it("waits for input quiet before publishing a completed deferred import", async () => {
  const h = await start();
  const module = await h.imports.mock.results[0]!.value;
  let finish = () => {};
  h.imports.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(module);
      }),
  );
  h.markHomeComposerReady();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.imports).toHaveBeenCalledTimes(2);
  document
    .querySelector("textarea")!
    .dispatchEvent(new Event("input", { bubbles: true }));
  finish();
  await vi.advanceTimersByTimeAsync(999);
  expect(h.imports).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(100);
  await h.done;
  expect(h.imports.mock.calls.flat()).toEqual([
    "/plugins/thread-list.js",
    "/plugins/git.js",
    "/plugins/usage.js",
  ]);
  expect(fetch).not.toHaveBeenCalled();
});

it("gates cache-busting retries after input during a failed import", async () => {
  const h = await start({
    importRetryDelaysMs: [1],
  });
  const module = await h.imports.mock.results[0]!.value;
  h.imports.mockImplementationOnce(async () => {
    document
      .querySelector("textarea")!
      .dispatchEvent(new Event("input", { bubbles: true }));
    throw new TypeError("Failed to fetch dynamically imported module");
  });
  h.markHomeComposerReady();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.imports).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(900);
  expect(h.imports).toHaveBeenCalledTimes(2);
  h.imports.mockResolvedValue(module);
  await vi.advanceTimersByTimeAsync(210);
  await h.done;
  expect(h.imports).toHaveBeenCalledTimes(4);
  expect(h.imports.mock.calls.flat()).toEqual([
    "/plugins/thread-list.js",
    "/plugins/git.js",
    "/plugins/git.js?bb_retry=1",
    "/plugins/usage.js",
  ]);
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps deferred runtime-slot bundles out of eager modulepreload compilation", async () => {
  const h = await start({}, ["radixCheckbox"]);
  h.markHomeComposerReady();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.prefetch).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(h.imports).toHaveBeenCalledTimes(3), {
    timeout: 10_000,
  });
  await h.done;
  expect(fetch).not.toHaveBeenCalled();
});
