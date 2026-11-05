// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { resetCrashedPluginSlots } from "@/components/plugin/PluginSlotMount";
import { definePluginApp } from "./plugin-app-definition";
import {
  createPluginFrontendReconcileState,
  disposePluginFrontends,
  reconcilePluginFrontends,
  type PluginFrontendReconcileDeps,
  type PluginFrontendCandidate,
} from "./plugin-frontend";
import {
  getPluginSlotSnapshot,
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
  removePluginSlotRegistrations,
} from "./plugin-slots";
import {
  PluginSettingsSections,
  PluginMobileSettingsSections,
} from "@/components/plugin/PluginSettingsSections";

afterEach(() => {
  cleanup();
  resetCrashedPluginSlots("settings-only");
  resetPluginSlotStoreForTest();
});

function fixture() {
  const candidate: PluginFrontendCandidate = {
    pluginId: "settings-only",
    bundle: {
      jsUrl: "/settings.js",
      cssUrl: "/settings.css",
      jsBytes: 100,
      hash: "a",
      sdkMajor: 0,
      sdkVersion: "0.6.110",
      compatible: true,
      runtimeSlots: [],
      frontendInventory: {
        version: 1,
        settingsSections: [{ id: "advertised", title: "Advertised heading" }],
      },
    },
  };
  const deps: PluginFrontendReconcileDeps = {
    fetchCandidates: async () => [candidate],
    importModule: vi.fn(async () => ({
      default: definePluginApp((app) => {
        app.slots.settingsSection({
          id: "actual",
          title: "Actual heading",
          component: () => <div>Real settings content</div>,
        });
      }),
    })),
    importRetryDelaysMs: [],
    applyCss: vi.fn(),
    prefetchCss: vi.fn(),
    prefetchModule: vi.fn(),
    retainCss: () => () => {},
    resetCrashedSlots: () => {},
    setRegistrations: setPluginSlotRegistrations,
    removeRegistrations: removePluginSlotRegistrations,
    beginSlotBatch: () => () => {},
    flushSlotBatch: () => {},
    warn: () => {},
    priorityPluginIds: () => [],
  };
  return { state: createPluginFrontendReconcileState(), deps, candidate };
}

describe("settings frontend demand loading", () => {
  it("publishes navigation metadata without fetching JS or CSS at boot", async () => {
    const { state, deps } = fixture();
    await reconcilePluginFrontends(state, deps);
    expect(deps.importModule).not.toHaveBeenCalled();
    expect(deps.prefetchModule).not.toHaveBeenCalled();
    expect(deps.prefetchCss).not.toHaveBeenCalled();
    expect(deps.applyCss).not.toHaveBeenCalled();
    expect(getPluginSlotSnapshot().settingsSections[0]?.title).toBe(
      "Advertised heading",
    );
  });

  it("loads on opening settings, injects CSS and replaces stale inventory with real registrations", async () => {
    const { state, deps } = fixture();
    await reconcilePluginFrontends(state, deps);
    render(
      <MemoryRouter>
        <PluginSettingsSections pluginId="settings-only" />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Real settings content")).toBeTruthy();
    expect(screen.getByText("Actual heading")).toBeTruthy();
    expect(screen.queryByText("Advertised heading")).toBeNull();
    expect(deps.importModule).toHaveBeenCalledTimes(1);
    expect(deps.applyCss).toHaveBeenCalledWith(
      "settings-only",
      "/settings.css",
    );
    await reconcilePluginFrontends(state, deps);
    expect(deps.importModule).toHaveBeenCalledTimes(1);
  });

  it("keeps older plugins eager and removes deferred sections when disabled", async () => {
    const { state, deps, candidate } = fixture();
    delete candidate.bundle.frontendInventory;
    await reconcilePluginFrontends(state, deps);
    expect(deps.importModule).toHaveBeenCalledTimes(1);
    const deferred = fixture();
    await reconcilePluginFrontends(deferred.state, deferred.deps);
    deferred.deps.fetchCandidates = async () => [];
    await reconcilePluginFrontends(deferred.state, deferred.deps);
    expect(getPluginSlotSnapshot().settingsSections).toHaveLength(0);
  });
  it("loads a Mobile-only section and shares a single import across mounted sections", async () => {
    const { state, deps, candidate } = fixture();
    candidate.bundle.frontendInventory = {
      version: 1,
      settingsSections: [
        { id: "pairing", experimental_page: "mobile" },
        { id: "other-pairing", experimental_page: "mobile" },
      ],
    };
    deps.importModule = vi.fn(async () => ({
      default: definePluginApp((app) => {
        app.slots.settingsSection({
          id: "pairing",
          experimental_page: "mobile",
          component: () => <div>Pair this device</div>,
        });
      }),
    }));
    await reconcilePluginFrontends(state, deps);
    render(
      <MemoryRouter>
        <PluginMobileSettingsSections pluginId="settings-only" />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Pair this device")).toBeTruthy();
    expect(deps.importModule).toHaveBeenCalledTimes(1);
  });

  it("uses the existing plugin error boundary when demand import fails", async () => {
    const { state, deps } = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      deps.importModule = vi.fn(async () => {
        throw new Error("Network unavailable");
      });
      await reconcilePluginFrontends(state, deps);
      render(
        <MemoryRouter>
          <PluginSettingsSections pluginId="settings-only" />
        </MemoryRouter>,
      );
      expect(
        await screen.findByText("plugin settings-only crashed"),
      ).toBeTruthy();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
  it("does not restore a failed placeholder after the host has been disposed", async () => {
    const { state, deps } = fixture();
    let reject: (error: Error) => void = () => {};
    deps.importModule = vi.fn(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    await reconcilePluginFrontends(state, deps);
    render(
      <MemoryRouter>
        <PluginSettingsSections pluginId="settings-only" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(deps.importModule).toHaveBeenCalledOnce());
    await act(async () => {
      await disposePluginFrontends(state, deps);
      reject(new Error("Late failure"));
    });
    expect(getPluginSlotSnapshot().settingsSections).toHaveLength(0);
  });
});
