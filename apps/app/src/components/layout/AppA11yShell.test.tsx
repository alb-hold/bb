// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactNode } from "react";
import { cleanup, render as renderReact, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings } from "@bb/domain";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { CHROME_SECTION_LABEL_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { SectionSidebarLabel } from "@/components/sidebar/SectionSidebar";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { RootComposeHome } from "@/views/RootComposeHome";
import { AppLayout } from "./AppLayout";

vi.mock("./AppLayoutSidebar", async () => {
  const { Sidebar } = await vi.importActual<
    typeof import("@/components/ui/sidebar")
  >("@/components/ui/sidebar");
  return {
    AppLayoutSidebar: () => (
      <Sidebar>
        <div data-testid="sidebar-body">Sidebar navigation</div>
      </Sidebar>
    ),
  };
});

vi.mock("@/hooks/queries/system-queries", () => {
  const systemConfigData = {
    experiments: {},
    generalSettings: defaultAppSettings,
    keybindings: [],
  };
  return {
    useSystemConfig: () => ({
      data: systemConfigData,
    }),
  };
});

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ hasDaemon: false }),
  useLocalHostDaemonAccess: () => ({ accessState: "unavailable" }),
}));

vi.mock("@/hooks/usePluginSafeModeCommands", () => ({
  usePluginSafeModeCommands: () => undefined,
}));

vi.mock("@/components/project/ProjectActionsProvider", () => ({
  ProjectActionsProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/hooks/mutations/thread-state-mutations", () => ({}));

vi.mock("@/components/thread/ThreadActionsProvider", () => ({
  ThreadActionsProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/plugin/PluginAppOverlays", () => ({
  PluginAppOverlays: () => null,
}));

vi.mock("@/components/plugin/ThreadRowMetadataCollectors", () => ({
  ThreadRowMetadataCollectors: () => null,
}));

vi.mock("@/components/dialogs/ProjectPathDialog", () => ({
  ProjectPathDialog: () => null,
}));

vi.mock("@/lib/bb-desktop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bb-desktop")>();
  return {
    ...actual,
    getBbDesktopInfo: () => null,
    shouldReserveMacosTrafficLights: () => false,
    shouldUseMacosDesktopChrome: () => false,
  };
});

vi.mock("@/lib/favicon-color-preference", () => ({
  useFaviconBadge: vi.fn(),
}));

vi.mock("@/hooks/useQuickCreateProject", () => ({
  useQuickCreateProjectController: () => ({
    hostId: null,
    hostName: null,
    isCreating: false,
    platform: "darwin",
    projectPathDialog: { onOpenChange: vi.fn(), target: null },
    submitProjectPath: vi.fn(),
  }),
}));

vi.mock("@/hooks/queries/sidebar-navigation-query", () => {
  const sidebarNavigationData = {
    sections: [],
    personalProject: {
      id: "proj_personal",
      kind: "personal",
      name: "Personal",
      sources: [],
      threads: [],
      defaultExecutionOptions: null,
      createdAt: 1,
      updatedAt: 1,
    },
    projects: [],
  };
  return {
    useSidebarNavigationPreview: () => undefined,
    useSidebarNavigationPaging: () => ({
      hasNextPage: false,
      isFetchingNextPage: false,
      isFetchNextPageError: false,
      fetchNextPage: async () => undefined,
    }),
    useSidebarNavigation: () => ({
      data: sidebarNavigationData,
      isError: false,
      isSuccess: true,
    }),
  };
});

vi.mock("@/hooks/queries/thread-queries", () => ({
  useArchivedThreads: () => ({ data: undefined }),
  didThreadDetailBootstrapRefreshAfterMount: () => true,
  useThread: () => ({ data: undefined }),
  useThreadDetailBootstrap: () => ({ isError: false, isSuccess: true }),
  useThreadPendingInteractions: () => ({ data: undefined }),
}));

function renderAppRoute({
  path,
  isCompactViewport = false,
  children = null,
}: {
  path: string;
  isCompactViewport?: boolean;
  children?: ReactNode;
}) {
  return renderReact(
    <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
      <MemoryRouter initialEntries={[path]}>
        <AppCommandProvider>
          <AppLayout>{children}</AppLayout>
        </AppCommandProvider>
      </MemoryRouter>
    </CompactViewportOverrideProvider>,
    { wrapper: createQueryClientTestHarness().wrapper },
  );
}

function assertSingleTopLevelMain(container: HTMLElement) {
  const mains = container.querySelectorAll('main, [role="main"]');
  expect(mains).toHaveLength(1);
  const main = mains[0]!;
  expect(
    main.parentElement?.closest(
      'main, [role="main"], aside, nav, header, footer, [role="complementary"], [role="navigation"], [role="banner"]',
    ),
  ).toBeNull();
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("app shell landmarks and headings", () => {
  it("renders exactly one top-level main, one aside sidebar, and one h1 on desktop home", () => {
    const view = renderAppRoute({
      path: "/",
      children: (
        <RootComposeHome
          isCompact={false}
          composer={<div>Composer</div>}
          compactScrollContent={null}
          homepageSections={null}
        />
      ),
    });

    assertSingleTopLevelMain(view.container);
    const panel = view.container.querySelector('[data-sidebar="panel"]');
    expect(panel?.tagName).toBe("ASIDE");
    expect(panel?.getAttribute("aria-label")).toBe("Sidebar");
    const headings = view.container.querySelectorAll("h1");
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe("bb");
    expect(headings[0]?.closest("main")).not.toBeNull();
    expect(headings[0]?.classList.contains("sr-only")).toBe(true);
    expect(screen.getByText("Start a new thread").tagName).toBe("P");
  });

  it("renders no h1 from the home compose view itself, so the shell owns the only heading", () => {
    const view = renderReact(
      <RootComposeHome
        isCompact={false}
        composer={<div>Composer</div>}
        compactScrollContent={null}
        homepageSections={null}
      />,
    );
    expect(view.container.querySelectorAll("h1")).toHaveLength(0);
  });

  it("renders exactly one top-level main and one h1 on compact home", async () => {
    const view = renderAppRoute({
      path: "/",
      isCompactViewport: true,
      children: (
        <RootComposeHome
          isCompact
          composer={<div>Composer</div>}
          compactScrollContent={null}
          homepageSections={null}
        />
      ),
    });

    assertSingleTopLevelMain(view.container);
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Home");
    expect(view.container.querySelectorAll("h1")).toHaveLength(1);
    expect(heading.closest("main")).not.toBeNull();
    const outsideLandmarks = Array.from(
      view.container.querySelectorAll("h1, button"),
    ).filter(
      (node) =>
        node.textContent !== "Toggle Sidebar" &&
        node.closest(
          'main, [role="main"], aside, nav, header, footer, [role="complementary"], [role="navigation"], [role="banner"]',
        ) === null,
    );
    expect(outsideLandmarks.map((node) => node.textContent)).toEqual([]);
  });

  it("renders exactly one top-level main and one h1 on settings", () => {
    const view = renderAppRoute({
      path: "/settings",
      children: <div>Settings body</div>,
    });

    assertSingleTopLevelMain(view.container);
    const headings = view.container.querySelectorAll("h1");
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe("Settings");
  });

  it("does not duplicate h1 on settings detail routes that render their own h1", () => {
    const view = renderAppRoute({
      path: "/settings/projects/proj_alpha",
      children: <h1>Alpha</h1>,
    });

    assertSingleTopLevelMain(view.container);
    const headings = view.container.querySelectorAll("h1");
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe("Alpha");
  });

  it("renders exactly one top-level main and one h1 on thread routes", () => {
    const view = renderAppRoute({
      path: "/projects/proj_one/threads/thr_one",
      children: <div>Thread body</div>,
    });

    assertSingleTopLevelMain(view.container);
    const headings = view.container.querySelectorAll("h1");
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent?.trim().length).toBeGreaterThan(0);
  });
});

describe("settings meta and sidebar section label contrast", () => {
  it("renders SectionSidebarLabel without diluted subtle-foreground alpha", () => {
    const view = renderReact(<SectionSidebarLabel>Plugins</SectionSidebarLabel>);
    const label = view.getByText("Plugins");
    expect(CHROME_SECTION_LABEL_CLASS).toContain("text-subtle-foreground");
    expect(CHROME_SECTION_LABEL_CLASS).not.toMatch(/text-subtle-foreground\/\d+/);
    expect(label.className).not.toMatch(/text-subtle-foreground\/\d+/);
  });

  it("does not use diluted text-subtle-foreground/75 in settings meta views", () => {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const settingsFiles = [
      "../settings/KeyboardSettingsSection.tsx",
      "../settings/ProvidersSettingsSection.tsx",
      "../settings/ProjectsSettingsSection.tsx",
      "../settings/MachinesSettingsSection.tsx",
      "../settings/BrowserSettingsSection.tsx",
      "../settings/MachineAccessSettings.tsx",
      "../plugin/PluginSettingsSections.tsx",
      "../../views/ProjectDetailSettingsView.tsx",
      "../../views/MachineSettingsView.tsx",
    ];
    for (const relPath of settingsFiles) {
      const contents = readFileSync(join(currentDir, relPath), "utf8");
      expect(contents, relPath).not.toMatch(/text-subtle-foreground\/75/);
    }
  });
});
