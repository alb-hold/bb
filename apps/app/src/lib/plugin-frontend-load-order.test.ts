import { describe, expect, it, vi } from "vitest";
import { frontendPriorityPluginIds } from "./plugin-surface-providers";
import { definePluginApp } from "./plugin-app-definition";
import {
  getPluginSlotSnapshot,
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "./plugin-slots";
import {
  createPluginFrontendReconcileState,
  orderPluginFrontendCandidates,
  reconcilePluginFrontends,
  type PluginFrontendCandidate,
  type PluginFrontendReconcileDeps,
} from "./plugin-frontend";

function candidate(pluginId: string, jsBytes: number): PluginFrontendCandidate {
  return {
    pluginId,
    bundle: {
      jsUrl: `/api/v1/plugins/${pluginId}/assets/app.js?h=h`,
      cssUrl: `/api/v1/plugins/${pluginId}/assets/app.css?h=h`,
      jsBytes,
      hash: "h",
      sdkMajor: 0,
      sdkVersion: "0.1.0",
      compatible: true,
      runtimeSlots: [],
    },
  };
}

function pluginModule(): Record<string, unknown> {
  return {
    default: definePluginApp((app) => {
      app.slots.homepageSection({
        id: "section",
        title: "Section",
        component: () => null,
      });
    }),
  };
}

function makeDeferredImports() {
  const started: string[] = [];
  const resolvers = new Map<string, () => void>();
  const importModule = vi.fn((url: string): Promise<unknown> => {
    started.push(url);
    return new Promise((resolve) => {
      resolvers.set(url, () => resolve(pluginModule()));
    });
  });
  return {
    importModule,
    started,
    pending: () => resolvers.size,
    resolveNext: async () => {
      const [url, resolve] = [...resolvers][0]!;
      resolvers.delete(url);
      resolve();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    },
  };
}

function makeDeps(
  candidates: PluginFrontendCandidate[],
  overrides: Partial<PluginFrontendReconcileDeps> = {},
): PluginFrontendReconcileDeps {
  return {
    fetchCandidates: async () => candidates,
    importModule: async () => pluginModule(),
    importRetryDelaysMs: [],
    applyCss: vi.fn(),
    prefetchCss: vi.fn(),
    prefetchModule: vi.fn(),
    retainCss: vi.fn(() => vi.fn()),
    resetCrashedSlots: vi.fn(),
    setRegistrations: vi.fn(),
    removeRegistrations: vi.fn(),
    warn: vi.fn(),
    priorityPluginIds: () => [],
    beginSlotBatch: () => () => {},
    flushSlotBatch: () => {},
    ...overrides,
  };
}

describe("orderPluginFrontendCandidates", () => {
  it("puts priority plugins first in priority order, then ascending bundle size", () => {
    const ordered = orderPluginFrontendCandidates(
      [
        candidate("automations", 1_060_000),
        candidate("secrets", 644_000),
        candidate("keep-awake", 309_000),
        candidate("side-chat", 242_000),
      ],
      ["secrets", "uninstalled", "automations"],
    );
    expect(ordered.map((c) => c.pluginId)).toEqual([
      "secrets",
      "automations",
      "side-chat",
      "keep-awake",
    ]);
  });

  it("keeps inventory order for equal sizes and does not mutate the input", () => {
    const input = [candidate("b", 10), candidate("a", 10), candidate("c", 5)];
    const ordered = orderPluginFrontendCandidates(input, []);
    expect(ordered.map((c) => c.pluginId)).toEqual(["c", "b", "a"]);
    expect(input.map((c) => c.pluginId)).toEqual(["b", "a", "c"]);
  });
});

describe("reconcilePluginFrontends load scheduling", () => {
  it("does not start an unused deferred wait when only home plugins are installed", async () => {
    const waitForDeferredLoad = vi.fn(() => new Promise<void>(() => {}));
    const importModule = vi.fn(async () => pluginModule());
    await reconcilePluginFrontends(
      createPluginFrontendReconcileState(),
      makeDeps([candidate("thread-list", 263_000)], {
        priorityPluginIds: () => ["thread-list"],
        waitForDeferredLoad,
        importModule,
      }),
    );
    expect(importModule).toHaveBeenCalledOnce();
    expect(waitForDeferredLoad).not.toHaveBeenCalled();
  });

  it("paints the home input before importing its rich renderer while loading the sidebar in parallel", async () => {
    const imports: string[] = [];
    let paint = () => {};
    const painted = new Promise<void>((resolve) => {
      paint = resolve;
    });
    const prefetchModule = vi.fn();
    const done = reconcilePluginFrontends(
      createPluginFrontendReconcileState(),
      makeDeps(
        [candidate("bb--composer", 424_000), candidate("thread-list", 263_000)],
        {
          priorityPluginIds: () => ["bb--composer", "thread-list"],
          waitForComposerPaint: () => painted,
          prefetchModule,
          importModule: async (url) => {
            imports.push(url);
            return pluginModule();
          },
        },
      ),
    );
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(imports).toEqual([expect.stringContaining("thread-list")]);
    expect(prefetchModule.mock.calls.flat()).not.toContainEqual(
      expect.stringContaining("bb--composer"),
    );
    paint();
    await done;
    expect(imports).toHaveLength(2);
    expect(imports[1]).toContain("bb--composer");
  });

  it("yields before each deferred bundle and never overlaps their evaluations", async () => {
    const imports = makeDeferredImports();
    const idle: (() => void)[] = [];
    const done = reconcilePluginFrontends(
      createPluginFrontendReconcileState(),
      makeDeps([candidate("a", 1), candidate("b", 2), candidate("c", 3)], {
        importModule: imports.importModule,
        yieldBetweenDeferredLoads: () =>
          new Promise<void>((resolve) => idle.push(resolve)),
      }),
    );
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(imports.started).toHaveLength(0);
    expect(idle).toHaveLength(1);
    for (let count = 1; count <= 3; count += 1) {
      idle.shift()!();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      expect(imports.started).toHaveLength(count);
      expect(imports.pending()).toBe(1);
      expect(idle).toHaveLength(0);
      await imports.resolveNext();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      expect(idle).toHaveLength(1);
      idle.shift()!();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      expect(idle).toHaveLength(count < 3 ? 1 : 0);
    }
    await done;
  });

  it("defers invisible bundles until paint and idle, then publishes their slots", async () => {
    let resume = () => {};
    const idle = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const imports = makeDeferredImports();
    resetPluginSlotStoreForTest();
    const registrations = vi.fn(setPluginSlotRegistrations);
    const waitForDeferredLoad = vi.fn(() => idle);
    const done = reconcilePluginFrontends(
      createPluginFrontendReconcileState(),
      makeDeps([candidate("panel", 100), candidate("composer", 900)], {
        importModule: imports.importModule,
        priorityPluginIds: () => ["composer"],
        waitForDeferredLoad,
        setRegistrations: registrations,
      }),
    );
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(imports.started).toEqual([
      "/api/v1/plugins/composer/assets/app.js?h=h",
    ]);
    expect(waitForDeferredLoad).not.toHaveBeenCalled();
    await imports.resolveNext();
    expect(waitForDeferredLoad).toHaveBeenCalledOnce();
    expect(registrations.mock.calls.map(([id]) => id)).toEqual(["composer"]);
    expect(imports.started).toHaveLength(1);
    expect(
      getPluginSlotSnapshot().homepageSections.map((slot) => slot.pluginId),
    ).toEqual(["composer"]);
    resume();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    await imports.resolveNext();
    await done;
    expect(registrations.mock.calls.map(([id]) => id)).toEqual([
      "composer",
      "panel",
    ]);
    expect(
      getPluginSlotSnapshot()
        .homepageSections.map((slot) => slot.pluginId)
        .sort(),
    ).toEqual(["composer", "panel"]);
    resetPluginSlotStoreForTest();
  });
  it("imports at most PLUGIN_FRONTEND_LOAD_CONCURRENCY bundles at once, in priority order", async () => {
    const imports = makeDeferredImports();
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps(
      [
        candidate("big", 900),
        candidate("mid", 500),
        candidate("small", 100),
        candidate("tiny", 10),
        candidate("panel", 700),
      ],
      {
        importModule: imports.importModule,
        priorityPluginIds: () => ["panel"],
      },
    );
    const done = reconcilePluginFrontends(state, deps);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(imports.started).toEqual([
      "/api/v1/plugins/panel/assets/app.js?h=h",
      "/api/v1/plugins/tiny/assets/app.js?h=h",
      "/api/v1/plugins/small/assets/app.js?h=h",
    ]);

    await imports.resolveNext();
    expect(imports.started).toHaveLength(4);
    expect(imports.started[3]).toBe("/api/v1/plugins/mid/assets/app.js?h=h");

    await imports.resolveNext();
    expect(imports.started).toHaveLength(5);
    expect(imports.started[4]).toBe("/api/v1/plugins/big/assets/app.js?h=h");

    await imports.resolveNext();
    await imports.resolveNext();
    await imports.resolveNext();
    await done;
    expect([...state.records.keys()].sort()).toEqual([
      "big",
      "mid",
      "panel",
      "small",
      "tiny",
    ]);
    expect(deps.setRegistrations).toHaveBeenCalledTimes(5);
  });

  it("publishes priority plugins while the remaining imports are still pending", async () => {
    const imports = makeDeferredImports();
    const events: string[] = [];
    const done = reconcilePluginFrontends(
      createPluginFrontendReconcileState(),
      makeDeps(
        [
          candidate("small", 10),
          candidate("thread-list", 900),
          candidate("big", 800),
        ],
        {
          importModule: imports.importModule,
          priorityPluginIds: () => ["thread-list", "not-installed"],
          setRegistrations: (pluginId) => events.push(`register ${pluginId}`),
          beginSlotBatch: () => {
            events.push("open batch");
            return () => events.push("close batch");
          },
        },
      ),
    );
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(events).toEqual(["open batch"]);

    await imports.resolveNext();
    expect(events).toEqual([
      "open batch",
      "register thread-list",
      "close batch",
      "open batch",
    ]);
    expect(imports.started).toHaveLength(3);

    await imports.resolveNext();
    await imports.resolveNext();
    await done;
    expect(events.slice(4)).toEqual([
      "register small",
      "register big",
      "close batch",
    ]);
  });

  it("downloads the next bundles ahead of the import lanes once priority plugins load", async () => {
    const imports = makeDeferredImports();
    const prefetchModule = vi.fn();
    const done = reconcilePluginFrontends(
      createPluginFrontendReconcileState(),
      makeDeps(
        [
          candidate("thread-list", 900),
          candidate("a", 10),
          candidate("b", 20),
          candidate("c", 30),
          candidate("d", 40),
          candidate("e", 50),
          candidate("f", 60),
        ],
        {
          importModule: imports.importModule,
          priorityPluginIds: () => ["thread-list"],
          prefetchModule,
        },
      ),
    );
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(prefetchModule).not.toHaveBeenCalled();

    await imports.resolveNext();
    const prefetchedIds = () =>
      prefetchModule.mock.calls.map(([url]) => String(url).split("/")[4]);
    expect(prefetchedIds()).toEqual(["d", "e", "f"]);

    while (imports.started.length < 7 || imports.pending() > 0) {
      await imports.resolveNext();
    }
    await done;
    expect(prefetchedIds()).toEqual(["d", "e", "f"]);
  });

  it("a rejected import in one lane does not stall the remaining candidates", async () => {
    const state = createPluginFrontendReconcileState();
    const deps = makeDeps(
      [candidate("broken", 1), candidate("fine", 2), candidate("also", 3)],
      {
        importModule: async (url) => {
          if (url.includes("/broken/")) throw new Error("boom");
          return pluginModule();
        },
      },
    );
    await reconcilePluginFrontends(state, deps);
    expect(state.records.get("broken")?.status).toBe("failed");
    expect(state.records.get("fine")?.status).toBe("loaded");
    expect(state.records.get("also")?.status).toBe("loaded");
  });
});

it("loads the sidebar first on a cold thread route without waiting for its module before starting the composer", async () => {
  const imports = makeDeferredImports();
  const done = reconcilePluginFrontends(
    createPluginFrontendReconcileState(),
    makeDeps(
      [
        candidate("bb--composer", 424000),
        candidate("thread-list", 263000),
        candidate("navigation", 500),
        candidate("optional", 10),
      ],
      {
        priorityPluginIds: () =>
          frontendPriorityPluginIds("/projects/project-a/threads/thread-a"),
        importModule: imports.importModule,
      },
    ),
  );
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(imports.started[0]).toContain("/thread-list/");
  expect(imports.started.some((url) => url.includes("/bb--composer/"))).toBe(
    true,
  );
  while (imports.pending()) await imports.resolveNext();
  await done;
});
