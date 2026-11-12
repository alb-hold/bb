// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getThreadRoutePath } from "@/lib/route-paths";
import {
  markPluginFrontendSettleFloorReached,
  resetPluginFrontendBootStateForTest,
} from "@/lib/plugin-frontend-boot-state";
import { pluginSdkAppImplementation } from "@/lib/plugin-sdk-app-impl";
import { SidebarProvider } from "@/components/ui/sidebar";
import { SidebarNavigationModelProvider } from "./SidebarNavigationModel";

const HOME_PATH = "/";
const THREAD_PATH = getThreadRoutePath({
  projectId: "proj_one",
  threadId: "thr_one",
});

const useNavigation =
  pluginSdkAppImplementation.experimental_useSidebarNavigation;

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandRunner: () => ({
    dispatch: () => {},
    isCommandAvailable: () => true,
  }),
  useAppCommandShortcut: () => null,
  useIsAppCommandModifierHeld: () => false,
}));

vi.mock("@/lib/plugin-nav-panel-chrome", () => ({
  usePluginNavPanelChrome: () => [
    {
      chrome: {
        pluginId: "garden",
        id: "docs",
        path: "docs",
        title: "Docs",
        icon: "MessageCircle",
      },
      panel: null,
    },
  ],
}));

function VisibleRailKeys() {
  const { items } = useNavigation();
  const keys = items
    .filter((item) => item.isVisible)
    .map((item) => item.id)
  return <output data-testid="visible-keys">{keys.join(",")}</output>;
}

function renderAt(path: string) {
  return render(
    <Provider store={createStore()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="*"
            element={
              <SidebarProvider>
                <SidebarNavigationModelProvider splitEnabled={false}>
                  <VisibleRailKeys />
                </SidebarNavigationModelProvider>
              </SidebarProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

afterEach(() => {
  cleanup();
  resetPluginFrontendBootStateForTest();
  window.localStorage.clear();
});

describe("sidebar navigation route chrome", () => {
  it("keeps the same visible rail keys on home and thread before frontend boot completes", () => {
    act(() => markPluginFrontendSettleFloorReached());

    renderAt(HOME_PATH);
    const homeKeys = screen.getByTestId("visible-keys").textContent;
    cleanup();

    renderAt(THREAD_PATH);
    const threadKeys = screen.getByTestId("visible-keys").textContent;

    expect(homeKeys).toBe(threadKeys);
    expect(homeKeys).toContain("garden/docs");
  });
});
