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

installTestPluginRuntime();
const { ProjectThreadTree } = await import("./ProjectRow.js");

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
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
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
});
