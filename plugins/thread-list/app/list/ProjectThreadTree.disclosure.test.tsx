// @vitest-environment jsdom

import { ThreadRowNavigationProvider } from "../rows/threadRowNavigation.js";
import { makeSidebarThread } from "../model/fixtures.js";
import { cleanup, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { SidebarRenameProvider } from "../rows/SidebarInlineRename.js";
import type { SidebarActivePagesOverview } from "./ProjectRow.js";

installTestPluginRuntime();
const { ProjectThreadTree, SidebarActivePagesOverviewContext } = await import(
  "./ProjectRow.js"
);

function Slot({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <ThreadRowNavigationProvider>
        <SidebarRenameProvider>{children}</SidebarRenameProvider>
      </ThreadRowNavigationProvider>
    </TooltipProvider>
  );
}

describe("ProjectThreadTree", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps thread siblings on the same zero-gap pitch as pinned rows", () => {
    const view = renderSlot({ component: Slot }, {
      children: (
        <ProjectThreadTree
          threadListState={{
            status: "ready",
            threads: [
              makeSidebarThread({ id: "thr_pitch_a" }),
              makeSidebarThread({ id: "thr_pitch_b" }),
            ],
          }}
          compareThreads={() => 0}
          collapsedThreadIds={new Set()}
          collapsedEnvironmentIds={new Set()}
          onToggleThreadCollapsed={vi.fn()}
          onToggleEnvironmentCollapsed={vi.fn()}
        />
      ),
    });
    expect(view.container.querySelector("[data-sidebar-sticky-section]")?.classList.contains("space-y-0")).toBe(true);
  });

  it("shows the unavailable state instead of rows when threads cannot load", () => {
    renderSlot(
      { component: Slot },
      {
        children: (
          <ProjectThreadTree
            threadListState={{ status: "unavailable" }}
            compareThreads={() => 0}
            collapsedThreadIds={new Set()}
            collapsedEnvironmentIds={new Set()}
            onToggleThreadCollapsed={vi.fn()}
            onToggleEnvironmentCollapsed={vi.fn()}
          />
        ),
      },
    );

    expect(screen.getByText("Threads unavailable")).not.toBeNull();
  });

  it("keeps the collapsed parent done indicator after expanding loads children and collapsing clears overview", () => {
    const parent = makeSidebarThread({
      id: "thr_parent",
      displayTitle: "Parent thread",
      isUnread: false,
      lastReadAt: 20,
      latestAttentionAt: 10,
      status: "idle",
      parentThreadId: null,
    });
    const unreadChild = makeSidebarThread({
      id: "thr_child",
      displayTitle: "Unread child",
      isUnread: true,
      lastReadAt: 10,
      latestAttentionAt: 30,
      status: "idle",
      parentThreadId: "thr_parent",
    });
    const overview: SidebarActivePagesOverview = {
      childCounts: { thr_parent: 1 },
      unreadTree: [
        {
          id: "thr_parent",
          parentThreadId: null,
          projectId: parent.projectId,
          sectionId: null,
          status: "idle",
          lastReadAt: 20,
          latestAttentionAt: 10,
        },
        {
          id: "thr_child",
          parentThreadId: "thr_parent",
          projectId: unreadChild.projectId,
          sectionId: null,
          status: "idle",
          lastReadAt: 10,
          latestAttentionAt: 30,
        },
      ],
    };

    const renderTree = (
      threads: ReturnType<typeof makeSidebarThread>[],
      collapsed: boolean,
      activeOverview: SidebarActivePagesOverview | null,
    ) => (
      <SidebarActivePagesOverviewContext.Provider value={activeOverview}>
        <ProjectThreadTree
          threadListState={{ status: "ready", threads }}
          compareThreads={() => 0}
          collapsedThreadIds={collapsed ? new Set(["thr_parent"]) : new Set()}
          collapsedEnvironmentIds={new Set()}
          onToggleThreadCollapsed={vi.fn()}
          onToggleEnvironmentCollapsed={vi.fn()}
        />
      </SidebarActivePagesOverviewContext.Provider>
    );

    const view = renderSlot(
      { component: Slot },
      { children: renderTree([parent], true, overview) },
    );

    expect(screen.getByRole("img", { name: "Done" })).not.toBeNull();

    view.rerender(
      <Slot>{renderTree([parent, unreadChild], false, null)}</Slot>,
    );

    expect(screen.queryByRole("img", { name: "Done" })).toBeNull();
    expect(screen.getByText("Unread child")).not.toBeNull();

    view.rerender(
      <Slot>{renderTree([parent, unreadChild], true, null)}</Slot>,
    );

    expect(screen.getByRole("img", { name: "Done" })).not.toBeNull();

    view.rerender(
      <Slot>{renderTree([parent, unreadChild], false, null)}</Slot>,
    );
    expect(screen.queryByRole("img", { name: "Done" })).toBeNull();

    view.rerender(
      <Slot>{renderTree([parent, unreadChild], true, null)}</Slot>,
    );
    expect(screen.getByRole("img", { name: "Done" })).not.toBeNull();
  });
});
