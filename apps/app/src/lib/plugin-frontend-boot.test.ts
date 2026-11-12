// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePluginFrontendLoadFailed } from "./plugin-frontend-boot-state";
import {
  bootPluginFrontends,
  schedulePluginFrontendReconcile,
} from "./plugin-frontend-lazy";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("reports a failed plugin frontend boot as failed until a retry succeeds", async () => {
  const fetchMock = vi.fn(async () =>
    fetchMock.mock.calls.length === 1
      ? new Response(JSON.stringify({ error: "bad request" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      : new Response(JSON.stringify({ plugins: [] }), {
          headers: { "content-type": "application/json" },
        }),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const loadFailed = renderHook(() => usePluginFrontendLoadFailed());

  await bootPluginFrontends();
  loadFailed.rerender();
  expect(loadFailed.result.current).toBe(true);

  schedulePluginFrontendReconcile();
  await vi.waitFor(() => {
    loadFailed.rerender();
    expect(loadFailed.result.current).toBe(false);
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

function plugin(status: "starting" | "running") {
  return {
    id: "keep-awake",
    source: "builtin:keep-awake",
    rootDir: "/builtin-plugins/keep-awake",
    version: "0.1.0",
    provenance: "builtin",
    publisherLabel: "BB Official",
    isOrphanedBuiltin: false,
    sourceDisplay: "builtin · keep-awake",
    updateState: { outcome: "pinned", lastCheckAt: 1 },
    enabled: true,
    description: "Keeps hosts awake.",
    name: "Keep Awake",
    screenshots: [],
    collections: [],
    icon: "Coffee",
    iconUrl: null,
    status,
    statusDetail: null,
    handlerStats: { count: 0, totalMs: 0, maxMs: 0, errorCount: 0 },
    services: [],
    schedules: [],
    cliCommand: null,
    capabilities: [],
    hasSettings: false,
    app: { hasApp: false, bundle: null },
    logoUrl: null,
    logoDarkUrl: null,
    providerIds: [],
    icons: {},
  };
}

it("re-checks the plugin list on its own while the server reports plugins starting", async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          plugins: [
            plugin(fetchMock.mock.calls.length === 1 ? "starting" : "running"),
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.resetModules();
  const { usePluginFrontendsSettled } =
    await import("./plugin-frontend-boot-state");
  const lazy = await import("./plugin-frontend-lazy");
  const settled = renderHook(() => usePluginFrontendsSettled());

  await lazy.bootPluginFrontends();
  settled.rerender();
  expect(settled.result.current).toBe(false);

  await vi.waitFor(
    () => {
      settled.rerender();
      expect(settled.result.current).toBe(true);
    },
    { timeout: 5_000, interval: 50 },
  );
  expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
}, 30_000);
