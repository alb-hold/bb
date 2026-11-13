// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  markPluginFrontendBootStarted,
  markPluginFrontendsSettled,
  resetPluginFrontendBootStateForTest,
} from "./plugin-frontend-boot-state";
import {
  expectedSurfaceProviderId,
  expectedSurfaceProviderIds,
  useRememberSurfaceProvider,
  type PluginSurface,
} from "./plugin-surface-providers";

function renderProvider(surface: PluginSurface, pluginId: string | null) {
  return renderHook(
    ({ pluginId }) => useRememberSurfaceProvider(surface, pluginId),
    { initialProps: { pluginId } },
  );
}

afterEach(() => {
  cleanup();
  resetPluginFrontendBootStateForTest();
  window.localStorage.clear();
});

describe("expectedSurfaceProviderIds", () => {
  it("expects bb's own composer, thread list and navigation before anything is remembered", () => {
    expect(expectedSurfaceProviderIds()).toEqual([
      "bb--composer",
      "thread-list",
      "navigation",
    ]);
  });

  it("lists each remembered provider once in place of the default", () => {
    renderProvider("composer", "lists");
    renderProvider("thread-list", "lists");
    renderProvider("sidebar-navigation", "lists");

    expect(expectedSurfaceProviderIds()).toEqual(["lists"]);
  });

  it("keeps the provider while plugins are still loading, and falls back to bb's own once boot completes without one", () => {
    renderProvider("thread-list", "my-thread-list").unmount();
    markPluginFrontendBootStarted();

    renderProvider("thread-list", null);
    expect(expectedSurfaceProviderIds()).toEqual([
      "bb--composer",
      "my-thread-list",
      "navigation",
    ]);

    act(() => markPluginFrontendsSettled());
    expect(expectedSurfaceProviderIds()).toEqual([
      "bb--composer",
      "thread-list",
      "navigation",
    ]);
  });

  it("never expects no provider for the composer, thread list or navigation", () => {
    markPluginFrontendBootStarted();
    act(() => markPluginFrontendsSettled());
    renderProvider("composer", null);
    renderProvider("thread-list", null);
    renderProvider("sidebar-navigation", null);

    expect(expectedSurfaceProviderIds()).toEqual([
      "bb--composer",
      "thread-list",
      "navigation",
    ]);
  });

  it("ignores an empty provider remembered by an earlier build", () => {
    for (const surface of ["composer", "thread-list", "sidebar-navigation"]) {
      window.localStorage.setItem(
        `bb.plugin-surface-provider.2.${surface}`,
        JSON.stringify({ pluginId: null }),
      );
    }

    expect(expectedSurfaceProviderId("thread-list")).toBe("thread-list");
    expect(expectedSurfaceProviderIds()).toEqual([
      "bb--composer",
      "thread-list",
      "navigation",
    ]);
  });

  it("rewrites an empty provider remembered by an earlier build once boot settles", () => {
    const surfaces = ["composer", "thread-list", "sidebar-navigation"] as const;
    for (const surface of surfaces) {
      window.localStorage.setItem(
        `bb.plugin-surface-provider.2.${surface}`,
        JSON.stringify({ pluginId: null }),
      );
    }
    markPluginFrontendBootStarted();
    act(() => markPluginFrontendsSettled());
    for (const surface of surfaces) renderProvider(surface, null);

    expect(
      surfaces.map((surface) =>
        JSON.parse(
          window.localStorage.getItem(
            `bb.plugin-surface-provider.2.${surface}`,
          ) ?? "null",
        ),
      ),
    ).toEqual([
      { pluginId: "bb--composer" },
      { pluginId: "thread-list" },
      { pluginId: "navigation" },
    ]);
  });
});
