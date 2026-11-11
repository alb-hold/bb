// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { pluginSdkAppImplementation } from "@/lib/plugin-sdk-app-impl";
import { getThreadRoutePath } from "@/lib/route-paths";
import { SidebarProvider } from "@/components/ui/sidebar";
import { SidebarNavigationModelProvider } from "./SidebarNavigationModel";

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
  usePluginNavPanelChrome: () => [],
}));

function HomeActiveProbe() {
  const { isHomeActive } = useNavigation();
  return (
    <output data-testid="home-active">{isHomeActive ? "yes" : "no"}</output>
  );
}

describe("SidebarNavigationModel home marker", () => {
  it("does not mark home active on thread routes", () => {
    render(
      <Provider store={createStore()}>
        <MemoryRouter initialEntries={[THREAD_PATH]}>
          <SidebarProvider>
            <SidebarNavigationModelProvider splitEnabled={false}>
              <HomeActiveProbe />
            </SidebarNavigationModelProvider>
          </SidebarProvider>
        </MemoryRouter>
      </Provider>,
    );
    expect(screen.getByTestId("home-active").textContent).toBe("no");
  });
});
