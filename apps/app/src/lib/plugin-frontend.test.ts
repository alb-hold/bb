import { afterEach, describe, expect, it, vi } from "vitest";

import * as react from "react";

import * as jsxRuntime from "react/jsx-runtime";

import clsx from "clsx";

import { Icon } from "@bb/shared-ui/icon";

import { RUNTIME_SLOT_BY_SPECIFIER } from "@bb/plugin-build/runtime-shims";

import {
  createPluginFrontendPageLifecycle,
  installPluginRuntime,
  loadPluginFrontend,
  type PluginFrontendCandidate,
} from "./plugin-frontend";

import { pluginSdkAppImplementation } from "./plugin-sdk-app-impl";

import { useSidebarThreadPullRequest } from "./plugin-sidebar-hooks";

function candidate(
  pluginId: string,
  overrides: Partial<PluginFrontendCandidate["bundle"]> = {},
): PluginFrontendCandidate {
  return {
    pluginId,
    bundle: {
      jsUrl: `/api/v1/plugins/${pluginId}/assets/app.js?h=abc123`,
      cssUrl: `/api/v1/plugins/${pluginId}/assets/app.css?h=abc123`,
      jsBytes: 1_000,
      hash: "abc123",
      sdkMajor: 0,
      sdkVersion: "0.1.0",
      compatible: true,
      runtimeSlots: [],
      ...overrides,
    },
  };
}

describe("loadPluginFrontend", () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & { __bbPluginRuntime?: unknown })
      .__bbPluginRuntime;
  });

  it("contains a Zod facade load failure before evaluating either plugin", async () => {
    vi.resetModules();
    vi.doMock(
      "../../../../packages/plugin-build/src/generated/zod-runtime.generated",
      () => ({
        get zodRuntimeSlots() {
          throw new Error("facade chunk unavailable");
        },
      }),
    );
    const importModule = vi.fn();
    try {
      const results = await Promise.all(
        ["first", "second"].map((id) =>
          loadPluginFrontend(candidate(id, { runtimeSlots: ["zod"] }), {
            importModule,
            prefetchModule: vi.fn(),
            warn: vi.fn(),
          }),
        ),
      );
      for (const result of results)
        expect(result).toMatchObject({
          status: "failed",
          error:
            'Cannot load "zod": shared runtime chunk failed: facade chunk unavailable',
        });
      expect(importModule).not.toHaveBeenCalled();
      expect(installPluginRuntime().zod).toBeUndefined();
    } finally {
      vi.doUnmock(
        "../../../../packages/plugin-build/src/generated/zod-runtime.generated",
      );
      vi.resetModules();
    }
  });

  it("awaits one generated Zod subset for concurrent plugins and preserves host schema and error identity", async () => {
    const hostZod = await import("zod");
    const runtime = installPluginRuntime();
    expect(runtime.zod).toBeUndefined();
    const importModule = vi.fn(async () => {
      const subset = runtime.zod as { z: { string: typeof hostZod.z.string } };
      const schema = subset.z.string();
      expect(schema.constructor).toBe(hostZod.ZodString);
      expect(() => schema.parse(42)).toThrow(hostZod.ZodError);
      expect(schema.parse("value")).toBe("value");
      return { default: {} };
    });
    const results = await Promise.all(
      ["first", "second"].map((id) =>
        loadPluginFrontend(candidate(id, { runtimeSlots: ["zod"] }), {
          importModule,
          prefetchModule: vi.fn(),
          warn: vi.fn(),
        }),
      ),
    );
    expect(results.map((result) => result.status)).toEqual([
      "loaded",
      "loaded",
    ]);
    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it("contains an import failure to its own plugin", async () => {
    const good = { default: {} };
    const importModule = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/plugins/broken/")) {
        throw new Error("SyntaxError: unexpected token");
      }
      return good;
    });
    const warn = vi.fn();

    const deps = { importModule, prefetchModule: vi.fn(), warn };

    expect(await loadPluginFrontend(candidate("broken"), deps)).toEqual({
      pluginId: "broken",
      status: "failed",
      error: "SyntaxError: unexpected token",
    });
    expect(
      await loadPluginFrontend(candidate("fine", { cssUrl: null }), deps),
    ).toEqual({
      pluginId: "fine",
      status: "loaded",
      module: good,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[plugin:broken] frontend bundle failed to load"),
    );
  });

  it("records a bundle that evaluates to a non-module as failed", async () => {
    const record = await loadPluginFrontend(
      candidate("odd", { cssUrl: null }),
      {
        importModule: async () => undefined,
        prefetchModule: vi.fn(),
        warn: vi.fn(),
      },
    );
    expect(record).toMatchObject({
      status: "failed",
      error: expect.stringContaining("module namespace"),
    });
  });

  it("skips incompatible bundles with a needs-update record and a warning", async () => {
    const importModule = vi.fn();
    const warn = vi.fn();

    const record = await loadPluginFrontend(
      candidate("stale", {
        compatible: false,
        sdkMajor: 9,
        sdkVersion: "9.2.0",
      }),
      { importModule, prefetchModule: vi.fn(), warn },
    );

    expect(record).toEqual({
      pluginId: "stale",
      status: "needs-update",
      sdkMajor: 9,
      sdkVersion: "9.2.0",
    });
    expect(importModule).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[plugin:stale]"),
    );
  });
});

describe("installPluginRuntime", () => {
  const LAZY_RUNTIME_SLOTS = new Set([
    "pierreDiffs",
    "pierreDiffsReact",
    "zod",
    "radixCheckbox",
    "radixSlot",
    "radixComposeRefs",
    "radixAlertDialog",
    "radixHoverCard",
    "radixMenubar",
    "radixNavigationMenu",
    "radixSelect",
    "vaul",
  ]);

  type RuntimeHost = typeof globalThis & { __bbPluginRuntime?: unknown };

  afterEach(() => {
    delete (globalThis as RuntimeHost).__bbPluginRuntime;
  });

  it("exposes the app's eager runtime modules, exactly once", () => {
    installPluginRuntime();
    const runtime = (globalThis as RuntimeHost).__bbPluginRuntime as Record<
      string,
      unknown
    >;
    expect(Object.keys(runtime).sort()).toEqual(
      [...new Set(Object.values(RUNTIME_SLOT_BY_SPECIFIER))]
        .filter((slot) => !LAZY_RUNTIME_SLOTS.has(slot))
        .sort(),
    );
    expect((runtime.clsx as { default: unknown }).default).toBe(clsx);
    expect((runtime.sharedUiIcon as { Icon: unknown }).Icon).toBe(Icon);
    expect((runtime.react as { useState: unknown }).useState).toBe(
      react.useState,
    );
    expect((runtime.jsxRuntime as { jsx: unknown }).jsx).toBe(jsxRuntime.jsx);
    expect(
      (runtime.pluginSdkApp as Record<string, unknown>)
        .experimental_useSidebarThreadPullRequest,
    ).toBe(useSidebarThreadPullRequest);
    expect(runtime.pluginSdkApp).toEqual({
      ...pluginSdkAppImplementation,
      experimental_useSidebarThreadPullRequest: useSidebarThreadPullRequest,
    });

    installPluginRuntime();
    expect((globalThis as RuntimeHost).__bbPluginRuntime).toBe(runtime);
  });

  it("awaits lazy Radix runtimes before evaluating a requesting plugin", async () => {
    const runtime = installPluginRuntime();
    expect(runtime.radixSlot).toBeUndefined();
    const importModule = vi.fn(async () => {
      expect(runtime.radixSlot).toBeDefined();
      expect(runtime.radixCheckbox).toBeDefined();
      return { default: {} };
    });
    const result = await loadPluginFrontend(
      candidate("shared", { runtimeSlots: ["radixSlot"] }),
      { importModule, prefetchModule: vi.fn(), warn: vi.fn() },
    );
    expect(result.status).toBe("loaded");
    expect(importModule).toHaveBeenCalledOnce();
  });

  it("provides optional UI runtimes only for a bundle that requests them", async () => {
    installPluginRuntime();
    const runtime = (globalThis as RuntimeHost).__bbPluginRuntime as Record<
      string,
      unknown
    >;
    const importModule = vi.fn(async () => {
      expect(runtime.radixMenubar).toBeDefined();
      expect(runtime.radixSelect).toBeUndefined();
      expect(runtime.vaul).toBeUndefined();
      return { default: {} };
    });
    const prefetchModule = vi.fn();
    expect(runtime.radixMenubar).toBeUndefined();
    await loadPluginFrontend(
      candidate("menubar", { runtimeSlots: ["radixMenubar"] }),
      { importModule, prefetchModule, warn: vi.fn() },
    );
    expect(prefetchModule).toHaveBeenCalledOnce();
    expect(importModule).toHaveBeenCalledOnce();
  });

  it("provides @pierre/diffs only to bundles that import it, downloading the bundle meanwhile", async () => {
    const pierreSlots = () =>
      Object.keys(
        (globalThis as RuntimeHost).__bbPluginRuntime as Record<
          string,
          unknown
        >,
      ).filter((slot) => slot.startsWith("pierre"));
    const slotsAtImport: string[][] = [];
    const importModule = vi.fn(async () => {
      slotsAtImport.push(pierreSlots());
      return { default: {} };
    });
    installPluginRuntime();

    const prefetchModule = vi.fn((url: string) =>
      slotsAtImport.push([`prefetch ${url.split("/")[4]}`, ...pierreSlots()]),
    );
    await loadPluginFrontend(candidate("plain", { runtimeSlots: ["react"] }), {
      importModule,
      prefetchModule,
      warn: vi.fn(),
    });
    await loadPluginFrontend(
      candidate("differ", { runtimeSlots: ["pierreDiffsReact", "react"] }),
      { importModule, prefetchModule, warn: vi.fn() },
    );

    expect(slotsAtImport).toEqual([
      [],
      ["prefetch differ"],
      ["pierreDiffs", "pierreDiffsReact"],
    ]);
    const runtime = (globalThis as RuntimeHost).__bbPluginRuntime as Record<
      string,
      unknown
    >;
    const pierreDiffs = await import("@pierre/diffs");
    const pierreDiffsReact = await import("@pierre/diffs/react");
    expect(runtime.pierreDiffs).toBe(pierreDiffs);
    const slot = runtime.pierreDiffsReact as Record<string, unknown>;
    expect(Object.keys(slot).sort()).toEqual(
      Object.keys(pierreDiffsReact).sort(),
    );
    expect(slot.useVirtualizer).toBe(pierreDiffsReact.useVirtualizer);
    expect(slot.WorkerPoolContext).toBe(pierreDiffsReact.WorkerPoolContext);
    expect(slot.FileDiff).not.toBe(pierreDiffsReact.FileDiff);
    expect(slot.File).not.toBe(pierreDiffsReact.File);
  });
});

describe("createPluginFrontendPageLifecycle", () => {
  function createDeps() {
    return {
      restore: vi.fn(),
      teardown: vi.fn(),
    };
  }

  it("keeps frontends mounted when the page enters the back/forward cache", () => {
    const deps = createDeps();
    const lifecycle = createPluginFrontendPageLifecycle(deps);
    lifecycle.onPageHide({ persisted: true });
    expect(deps.teardown).not.toHaveBeenCalled();

    lifecycle.onPageShow({ persisted: true });
    expect(deps.restore).toHaveBeenCalledTimes(1);
  });

  it("tears down on a real unload and delegates a later persisted restore", () => {
    const deps = createDeps();
    const lifecycle = createPluginFrontendPageLifecycle(deps);
    lifecycle.onPageHide({ persisted: false });
    expect(deps.teardown).toHaveBeenCalledTimes(1);

    lifecycle.onPageShow({ persisted: true });
    expect(deps.restore).toHaveBeenCalledTimes(1);
  });

  it("ignores the initial (non-persisted) pageshow", () => {
    const deps = createDeps();
    createPluginFrontendPageLifecycle(deps).onPageShow({ persisted: false });
    expect(deps.restore).not.toHaveBeenCalled();
  });
});

it.each([
  ["bb--composer", "internal_DO_NOT_USE_dropdown_menu"],
  ["bb--composer", "internal_DO_NOT_USE_responsive_overlay"],
  ["thread-list", "internal_DO_NOT_USE_context_menu"],
  ["thread-list", "internal_DO_NOT_USE_dialog"],
  ["thread-list", "internal_DO_NOT_USE_dropdown_menu"],
])("contains missing %s slot %s before evaluation", async (pluginId, slot) => {
  Reflect.deleteProperty(installPluginRuntime(), slot);
  const importModule = vi.fn();
  const result = await loadPluginFrontend(
    candidate(pluginId, { runtimeSlots: [slot] }),
    {
      importModule,
      prefetchModule: vi.fn(),
      warn: vi.fn(),
    },
  );
  expect(result).toMatchObject({
    status: "failed",
    error: expect.stringContaining("Update the BB host"),
  });
  expect(importModule).not.toHaveBeenCalled();
  delete (globalThis as typeof globalThis & { __bbPluginRuntime?: unknown })
    .__bbPluginRuntime;
});
