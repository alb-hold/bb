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

async function start() {
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
      runtimeSlots: [],
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
  };
  markRouteContentPainted();
  const done = reconcilePluginFrontends(
    createPluginFrontendReconcileState(),
    deps,
  );
  await vi.advanceTimersByTimeAsync(0);
  return { imports, prefetch, done, markHomeComposerReady };
}

it("keeps non-home plugin downloads behind ready, a long settle and idle", async () => {
  const h = await start();
  expect(h.imports.mock.calls.flat()).toEqual(["/plugins/thread-list.js"]);
  await vi.advanceTimersByTimeAsync(12_000);
  expect(h.imports).toHaveBeenCalledTimes(1);
  expect(h.prefetch).not.toHaveBeenCalled();
  h.markHomeComposerReady();
  await vi.advanceTimersByTimeAsync(14_999);
  expect(h.imports).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10);
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
  await vi.advanceTimersByTimeAsync(15_010);
  expect(h.imports).toHaveBeenCalledTimes(2);
  document
    .querySelector("textarea")!
    .dispatchEvent(new Event("input", { bubbles: true }));
  finish();
  await vi.advanceTimersByTimeAsync(999);
  expect(h.imports).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5);
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
  await vi.advanceTimersByTimeAsync(10);
  await h.done;
  expect(h.imports).toHaveBeenCalledTimes(3);
});

it.each([false, true])(
  "lets navigation escape the home wait but waits for terminal paint (marked=%s)",
  async (marked) => {
    const h = await start();
    if (marked) {
      h.markHomeComposerReady();
      await vi.advanceTimersByTimeAsync(100);
    }
    window.history.pushState(null, "", "/threads/terminal");
    document.body.replaceChildren();
    window.dispatchEvent(new PopStateEvent("popstate"));
    await vi.advanceTimersByTimeAsync(500);
    expect(h.imports).toHaveBeenCalledTimes(1);
    document.body.innerHTML = '<div class="xterm-screen"></div>';
    await vi.advanceTimersByTimeAsync(10);
    await h.done;
    expect(h.imports).toHaveBeenCalledTimes(3);
  },
);
