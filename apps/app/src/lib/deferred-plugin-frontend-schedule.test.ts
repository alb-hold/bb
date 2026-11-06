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
    await vi.advanceTimersByTimeAsync(30);
    await h.done;
    expect(h.imports).toHaveBeenCalledTimes(3);
  },
);

it("waits for input quiet again when a deferred download completes during typing", async () => {
  let finish = () => {};
  const download = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const h = await start({ downloadDeferredModule: download });
  h.markHomeComposerReady();
  await vi.advanceTimersByTimeAsync(15_010);
  expect(download).toHaveBeenCalledExactlyOnceWith("/plugins/git.js");
  expect(h.imports).toHaveBeenCalledTimes(1);
  document
    .querySelector("textarea")!
    .dispatchEvent(new Event("input", { bubbles: true }));
  download.mockResolvedValue(undefined);
  finish();
  await vi.advanceTimersByTimeAsync(999);
  expect(h.imports).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10);
  await h.done;
  expect(h.imports.mock.calls.flat()).toEqual([
    "/plugins/thread-list.js",
    "/plugins/git.js",
    "/plugins/usage.js",
  ]);
});

it("gates cache-busting retries after input during a failed import", async () => {
  const download = vi.fn(async (_url: string) => {});
  const h = await start({
    downloadDeferredModule: download,
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
  await vi.advanceTimersByTimeAsync(15_010);
  expect(h.imports).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(900);
  expect(h.imports).toHaveBeenCalledTimes(2);
  h.imports.mockResolvedValue(module);
  await vi.advanceTimersByTimeAsync(110);
  await h.done;
  expect(h.imports).toHaveBeenCalledTimes(4);
  expect(download.mock.calls.flat()).toEqual([
    "/plugins/git.js",
    "/plugins/git.js?bb_retry=1",
    "/plugins/usage.js",
  ]);
});

it.each(["network", "status", "body"])(
  "keeps the real import available after a %s cache-download failure",
  async (failure) => {
    const response = {
      ok: failure !== "status",
      arrayBuffer: vi.fn(async () => {
        if (failure === "body") throw new Error("Truncated download");
        return new ArrayBuffer(0);
      }),
    };
    const fetch = vi.fn(async () => {
      if (failure === "network") throw new TypeError("Network unavailable");
      return response;
    });
    vi.stubGlobal("fetch", fetch);
    const h = await start();
    h.markHomeComposerReady();
    await vi.advanceTimersByTimeAsync(15_030);
    await h.done;
    expect(h.imports.mock.calls.flat()).toEqual([
      "/plugins/thread-list.js",
      "/plugins/git.js",
      "/plugins/usage.js",
    ]);
    expect(fetch).toHaveBeenCalledWith("/plugins/git.js", {
      cache: "force-cache",
      priority: "low",
    });
    expect(response.arrayBuffer).toHaveBeenCalledTimes(
      failure === "body" ? 2 : 0,
    );
  },
);

it("keeps deferred runtime-slot bundles out of eager modulepreload compilation", async () => {
  const h = await start({}, ["radixCheckbox"]);
  h.markHomeComposerReady();
  await vi.advanceTimersByTimeAsync(15_030);
  expect(h.prefetch).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(h.imports).toHaveBeenCalledTimes(3), {
    timeout: 10_000,
  });
  await h.done;
  expect(fetch).toHaveBeenCalledWith("/plugins/git.js", {
    cache: "force-cache",
    priority: "low",
  });
});
