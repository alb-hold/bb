// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appQueryClient } from "@/lib/app-query-client";
import { pluginListQueryOptions } from "@/hooks/queries/plugin-settings-queries";
import { makeInstalledPlugin } from "@/test/fixtures/plugins";
import {
  markPluginFrontendBootStarted,
  markPluginFrontendsSettled,
  resetPluginFrontendBootStateForTest,
  usePluginFrontendsSettled,
} from "@/lib/plugin-frontend-boot-state";
import {
  markRouteContentPainted,
  resetRouteContentPaintForTest,
} from "@/lib/route-content-paint";

const mocks = vi.hoisted(() => ({
  bootPluginFrontends: vi.fn(async () => {}),
  preloadPluginFrontend: vi.fn(),
  prefetchPluginRuntimeSlots: vi.fn(),
  releaseSplitPreloads: vi.fn(),
  systemConfigData: undefined as unknown,
}));

vi.mock("@/lib/split-prefetch", () => ({
  holdSplitPreloads: () => mocks.releaseSplitPreloads,
}));

vi.mock("@/lib/plugin-lazy-runtime-groups", () => ({
  prefetchPluginRuntimeSlots: mocks.prefetchPluginRuntimeSlots,
}));

vi.mock("@/lib/plugin-frontend-lazy", () => ({
  bootPluginFrontends: mocks.bootPluginFrontends,
  preloadPluginFrontend: mocks.preloadPluginFrontend,
  whenPriorityPluginFrontendsLoaded: () => new Promise(() => {}),
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({ data: mocks.systemConfigData }),
}));

import {
  PLUGIN_FRONTEND_SETTLE_FLOOR_MS,
  usePluginFrontendBoot,
} from "./usePluginFrontendBoot";

const flushMicrotasks = () => act(async () => {});

beforeEach(() => {
  vi.spyOn(DOMTokenList.prototype, "supports").mockReturnValue(true);
  appQueryClient.setQueryData(
    pluginListQueryOptions({ enabled: true }).queryKey,
    [],
  );
  vi.useFakeTimers();
  mocks.systemConfigData = { generalSettings: {} };
  resetRouteContentPaintForTest();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  document.body.replaceChildren();
  appQueryClient.clear();
  document.head
    .querySelectorAll(
      'link[rel="modulepreload"], link[data-bb-plugin-css-prefetch]',
    )
    .forEach((link) => link.remove());
  vi.useRealTimers();
  mocks.bootPluginFrontends.mockReset();
  mocks.bootPluginFrontends.mockImplementation(async () => {});
  mocks.releaseSplitPreloads.mockClear();
  mocks.preloadPluginFrontend.mockClear();
  mocks.prefetchPluginRuntimeSlots.mockReset();
  resetPluginFrontendBootStateForTest();
});

describe("usePluginFrontendBoot", () => {
  it.each(["/", "/threads/thr_one"])(
    "downloads shell bundles after the route surface paints on %s",
    async (pathname) => {
      window.history.replaceState(null, "", pathname);
      const deferredComposer = pathname === "/";
      if (!deferredComposer)
        document.body.innerHTML = '<div class="xterm-screen"></div>';
      const bundleSuffix = deferredComposer ? "home" : "thread";
      const runtimeRequests: { slots: string[]; precedingBundles: string[] }[] =
        [];
      mocks.prefetchPluginRuntimeSlots.mockImplementation((slots: string[]) => {
        runtimeRequests.push({
          slots,
          precedingBundles: [
            ...document.head.querySelectorAll('link[rel="modulepreload"]'),
          ].map((link) => link.getAttribute("href")!),
        });
      });
      const plugins = [
        "bb--composer",
        "thread-list",
        "navigation",
        "other",
      ].map((id) =>
        makeInstalledPlugin({
          id,
          enabled: true,
          status: "running",
          app: {
            bundle: {
              jsUrl: `/plugins/${id}-${bundleSuffix}.js`,
              cssUrl: `/plugins/${id}-${bundleSuffix}.css`,
              jsBytes: 100,
              hash: id,
              sdkMajor: 0,
              sdkVersion: "0.0.0",
              compatible: true,
              runtimeSlots:
                id === "bb--composer"
                  ? ["zod"]
                  : id === "thread-list"
                    ? ["zod", "radixCheckbox"]
                    : ["react"],
            },
          },
        }),
      );
      appQueryClient.setQueryData(
        pluginListQueryOptions({ enabled: true }).queryKey,
        plugins,
      );
      renderHook(() => usePluginFrontendBoot());
      await flushMicrotasks();
      if (deferredComposer) {
        expect(mocks.preloadPluginFrontend).not.toHaveBeenCalled();
        expect(mocks.bootPluginFrontends).not.toHaveBeenCalled();
        expect(runtimeRequests).toEqual([]);
        expect(
          document.head.querySelectorAll('link[rel="modulepreload"]'),
        ).toHaveLength(0);
        document.body.innerHTML =
          '<textarea></textarea><div data-sidebar-thread-id="recent"></div>';
        await flushMicrotasks();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(40);
        });
      }
      if (!deferredComposer) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(40);
        });
      }
      expect(
        [...document.head.querySelectorAll('link[rel="modulepreload"]')].map(
          (link) => link.getAttribute("href"),
        ),
      ).toEqual([
        ...(deferredComposer
          ? []
          : [`/plugins/bb--composer-${bundleSuffix}.js`]),
        `/plugins/thread-list-${bundleSuffix}.js`,
        `/plugins/navigation-${bundleSuffix}.js`,
      ]);
      expect(
        document.head.querySelectorAll("link[data-bb-plugin-css-prefetch]"),
      ).toHaveLength(deferredComposer ? 2 : 3);
      expect(mocks.bootPluginFrontends).toHaveBeenCalledTimes(1);
      expect(runtimeRequests).toEqual([
        ...(deferredComposer ? [] : [{ slots: ["zod"], precedingBundles: [] }]),
        {
          slots: ["zod", "radixCheckbox"],
          precedingBundles: deferredComposer
            ? []
            : [`/plugins/bb--composer-${bundleSuffix}.js`],
        },
        {
          slots: ["react"],
          precedingBundles: [
            ...(deferredComposer
              ? []
              : [`/plugins/bb--composer-${bundleSuffix}.js`]),
            `/plugins/thread-list-${bundleSuffix}.js`,
          ],
        },
      ]);
    },
  );

  it("boots home plugins on the composer alone, without waiting for sidebar rows only a plugin renders", async () => {
    document.body.innerHTML = "<textarea></textarea>";
    renderHook(() => usePluginFrontendBoot());
    await flushMicrotasks();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(document.querySelector("[data-sidebar-thread-id]")).toBeNull();
    expect(mocks.preloadPluginFrontend).toHaveBeenCalledTimes(1);
    expect(mocks.bootPluginFrontends).toHaveBeenCalledTimes(1);
  });

  it("releases home plugin loading if the composer cannot mount", async () => {
    renderHook(() => usePluginFrontendBoot());
    await flushMicrotasks();
    expect(mocks.preloadPluginFrontend).not.toHaveBeenCalled();
    expect(mocks.bootPluginFrontends).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_550);
    });
    expect(mocks.preloadPluginFrontend).toHaveBeenCalledTimes(1);
    expect(mocks.bootPluginFrontends).toHaveBeenCalledTimes(1);
  });

  it("cancels home plugin loading when unmounted before composer paint", async () => {
    const { unmount } = renderHook(() => usePluginFrontendBoot());
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(mocks.preloadPluginFrontend).not.toHaveBeenCalled();
    expect(mocks.bootPluginFrontends).not.toHaveBeenCalled();
  });

  it("boots immediately on a plugin panel route: the plugin is the page", async () => {
    window.history.replaceState(null, "", "/plugins/tasks/board");
    renderHook(() => usePluginFrontendBoot());
    await flushMicrotasks();
    expect(mocks.bootPluginFrontends).toHaveBeenCalledTimes(1);
  });

  it("downloads runtime and plugin list before config, but gates activation", async () => {
    window.history.replaceState(null, "", "/threads/thr_one");
    document.body.innerHTML = '<div class="xterm-screen"></div>';
    mocks.systemConfigData = undefined;
    const fetchList = vi.spyOn(appQueryClient, "fetchQuery");
    const { rerender } = renderHook(() => usePluginFrontendBoot());
    await act(async () => {
      markRouteContentPainted();
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.bootPluginFrontends).not.toHaveBeenCalled();
    expect(mocks.preloadPluginFrontend).toHaveBeenCalledTimes(1);
    expect(fetchList).toHaveBeenCalledTimes(1);
    mocks.systemConfigData = {};
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    expect(mocks.bootPluginFrontends).toHaveBeenCalledTimes(1);
    expect(fetchList).toHaveBeenCalledTimes(1);
    fetchList.mockRestore();
  });

  it("settles after the floor even when system config never resolves", () => {
    mocks.systemConfigData = undefined;
    const { result } = renderHook(() => {
      usePluginFrontendBoot();
      return usePluginFrontendsSettled();
    });
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(PLUGIN_FRONTEND_SETTLE_FLOOR_MS - 1));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("never settles a boot that is still in flight when the floor elapses", async () => {
    let finishBoot: () => void = () => {};
    mocks.bootPluginFrontends.mockImplementation(() => {
      markPluginFrontendBootStarted();
      return new Promise<void>((resolve) => {
        finishBoot = () => {
          markPluginFrontendsSettled();
          resolve();
        };
      });
    });
    window.history.replaceState(null, "", "/plugins/tasks/board");
    const { result } = renderHook(() => {
      usePluginFrontendBoot();
      return usePluginFrontendsSettled();
    });
    await flushMicrotasks();
    expect(mocks.bootPluginFrontends).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLUGIN_FRONTEND_SETTLE_FLOOR_MS * 2);
    });
    expect(result.current).toBe(false);

    await act(async () => {
      finishBoot();
    });
    expect(result.current).toBe(true);
  });

  it("holds split preloads until every plugin frontend has loaded", async () => {
    let finishBoot: () => void = () => {};
    mocks.bootPluginFrontends.mockImplementation(
      () => new Promise<void>((resolve) => (finishBoot = resolve)),
    );
    window.history.replaceState(null, "", "/plugins/tasks/board");
    renderHook(() => usePluginFrontendBoot());
    await flushMicrotasks();
    expect(mocks.bootPluginFrontends).toHaveBeenCalledTimes(1);
    expect(mocks.releaseSplitPreloads).not.toHaveBeenCalled();

    await act(async () => finishBoot());
    expect(mocks.releaseSplitPreloads).toHaveBeenCalled();
  });
});

it("keeps priority plugin work behind the fitted native terminal's visible frame", async () => {
  window.history.replaceState(null, "", "/threads/thr_native");
  const container = document.createElement("div");
  container.style.opacity = "0";
  const terminal = document.createElement("div");
  terminal.className = "xterm-screen";
  terminal.checkVisibility = (options) =>
    !options?.checkOpacity || container.style.opacity !== "0";
  container.append(terminal);
  document.body.append(container);
  renderHook(() => usePluginFrontendBoot());
  await flushMicrotasks();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(mocks.preloadPluginFrontend).not.toHaveBeenCalled();
  expect(mocks.bootPluginFrontends).not.toHaveBeenCalled();
  container.style.opacity = "1";
  await flushMicrotasks();
  expect(mocks.bootPluginFrontends).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(40);
  });
  expect(mocks.preloadPluginFrontend).toHaveBeenCalledOnce();
  expect(mocks.bootPluginFrontends).toHaveBeenCalledOnce();
});

it("releases priority plugins when a thread never presents content", async () => {
  window.history.replaceState(null, "", "/threads/thr_missing");
  renderHook(() => usePluginFrontendBoot());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(mocks.bootPluginFrontends).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9_050);
  });
  expect(mocks.bootPluginFrontends).toHaveBeenCalledOnce();
});

it("cancels priority thread plugin work when unmounted while terminal fitting is pending", async () => {
  window.history.replaceState(null, "", "/threads/thr_unmounted");
  const { unmount } = renderHook(() => usePluginFrontendBoot());
  unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_050);
  });
  expect(mocks.preloadPluginFrontend).not.toHaveBeenCalled();
  expect(mocks.bootPluginFrontends).not.toHaveBeenCalled();
});
