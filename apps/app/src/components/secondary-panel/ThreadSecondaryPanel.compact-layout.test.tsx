// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { PanelGroup } from "react-resizable-panels";
import { useState } from "react";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalFixedPanelTab,
  createThreadInfoFixedPanelTab,
  type SecondaryFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ThreadSecondaryPanel, type SecondaryPanelRenderableTab } from "./ThreadSecondaryPanel";
import { sidebarSplitStorageKey } from "./sidebarSplitLayout";

const { toastWarning } = vi.hoisted(() => ({ toastWarning: vi.fn() }));
vi.mock("@/components/ui/app-toast", () => ({
  appToast: { warning: toastWarning },
}));

const noop = () => {};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  toastWarning.mockClear();
});

describe("compact terminal layout requests", () => {
  it("selects the requested terminal on a non-drawer host without split state", async () => {
    const terminalId = "term-no-split-state";
    const terminalTab = createTerminalFixedPanelTab({ terminalId });
    const terminalDescriptor: SecondaryPanelRenderableTab = {
      label: "Requested terminal",
      leadingVisual: null,
      onClose: noop,
      onSelect: noop,
      renderContent: () => <div>Requested terminal content</div>,
      statusLabel: null,
      tab: terminalTab,
    };
    function Harness() {
      const [activeTab, setActiveTab] = useState<SecondaryFixedPanelTab>(
        createThreadInfoFixedPanelTab(),
      );
      return (
        <PanelGroup direction="horizontal">
          <ThreadSecondaryPanel
            activeTab={activeTab}
            canUseGitUi={false}
            fixedTabs={[]}
            tabs={[terminalDescriptor]}
            isConversationCollapsed={false}
            isOpen
            metadataContent={null}
            onClose={noop}
            onCollapse={noop}
            onEnsureTerminalTabs={(terminalIds) => {
              expect(terminalIds).toEqual([terminalId]);
              setActiveTab(terminalTab);
              return true;
            }}
            onTabReorder={noop}
            onOpenNewTab={noop}
            onPanelFocus={noop}
            onToggleConversationCollapse={noop}
            renderAsDrawer={false}
            terminalLayoutRequest={{
              action: "split",
              requestId: 54,
              terminalId,
              side: "right",
            }}
          />
        </PanelGroup>
      );
    }

    const { wrapper: Wrapper } = createQueryClientTestHarness();
    render(<Wrapper><TooltipProvider><Harness /></TooltipProvider></Wrapper>);

    await waitFor(() => expect(screen.getByText("Requested terminal content")).toBeTruthy());
    expect(toastWarning).toHaveBeenCalledWith("Split panes aren't available at this window size.");
  });

  it.each(["split", "move"] as const)(
    "%s selects the requested terminal, shows a notice, and preserves persisted split state",
    async (action) => {
      const terminalId = `term-compact-${action}`;
      const terminalTab = createTerminalFixedPanelTab({ terminalId });
      const terminalDescriptor: SecondaryPanelRenderableTab = {
        label: "Requested terminal",
        leadingVisual: null,
        onClose: noop,
        onSelect: noop,
        renderContent: () => <div>Requested terminal content</div>,
        statusLabel: null,
        tab: terminalTab,
      };
      const panelStateId = `compact-layout-${action}`;
      const storageKey = sidebarSplitStorageKey(panelStateId);
      window.localStorage.setItem(storageKey, "unchanged-layout");
      const request = {
        action,
        requestId: action === "split" ? 51 : 52,
        terminalId,
        ...(action === "split"
          ? { side: "right" as const }
          : { targetTerminalId: "term-target" }),
      };
      function Harness() {
        const [activeTab, setActiveTab] = useState<SecondaryFixedPanelTab>(
          createThreadInfoFixedPanelTab(),
        );
        const ensureTerminalTabs = (terminalIds: readonly string[]) => {
          expect(terminalIds).toContain(terminalId);
          if (action === "move") expect(terminalIds).toContain("term-target");
          setActiveTab(terminalTab);
          return true;
        };
        return (
          <PanelGroup direction="horizontal">
            <ThreadSecondaryPanel
              activeTab={activeTab}
              canUseGitUi={false}
              fixedTabs={[]}
              tabs={[terminalDescriptor]}
              isConversationCollapsed={false}
              isOpen
              metadataContent={null}
              onClose={noop}
              onCollapse={noop}
              onEnsureTerminalTabs={ensureTerminalTabs}
              onTabReorder={noop}
              onOpenNewTab={noop}
              onPanelFocus={noop}
              onToggleConversationCollapse={noop}
              renderAsDrawer
              splitPanelStateId={panelStateId}
              terminalLayoutRequest={request}
            />
          </PanelGroup>
        );
      }

      const { wrapper: Wrapper } = createQueryClientTestHarness();
      render(<Wrapper><TooltipProvider><Harness /></TooltipProvider></Wrapper>);

      await waitFor(() => expect(screen.getByText("Requested terminal content")).toBeTruthy());
      expect(toastWarning).toHaveBeenCalledWith("Split panes aren't available at this window size.");
      expect(window.localStorage.getItem(storageKey)).toBe("unchanged-layout");
    },
  );

  it("shows the unavailable notice without changing the selected tab or layout", async () => {
    const panelStateId = "compact-layout-unavailable";
    const storageKey = sidebarSplitStorageKey(panelStateId);
    window.localStorage.setItem(storageKey, "unchanged-layout");
    const onEnsureTerminalTabs = vi.fn(() => false);
    const { wrapper: Wrapper } = createQueryClientTestHarness();
    render(
      <Wrapper>
        <TooltipProvider>
          <PanelGroup direction="horizontal">
            <ThreadSecondaryPanel
              activeTab={createThreadInfoFixedPanelTab()}
              canUseGitUi={false}
              fixedTabs={[]}
              tabs={[]}
              isConversationCollapsed={false}
              isOpen
              metadataContent={null}
              onClose={noop}
              onCollapse={noop}
              onEnsureTerminalTabs={onEnsureTerminalTabs}
              onTabReorder={noop}
              onOpenNewTab={noop}
              onPanelFocus={noop}
              onToggleConversationCollapse={noop}
              renderAsDrawer
              splitPanelStateId={panelStateId}
              terminalLayoutRequest={{
                action: "move",
                requestId: 53,
                terminalId: "term-unavailable",
                targetTerminalId: "term-target",
              }}
            />
          </PanelGroup>
        </TooltipProvider>
      </Wrapper>,
    );

    await waitFor(() =>
      expect(toastWarning).toHaveBeenCalledWith(
        "The terminal is no longer available in this thread.",
      ),
    );
    expect(onEnsureTerminalTabs).toHaveBeenCalledWith([
      "term-target",
      "term-unavailable",
    ]);
    expect(screen.queryByText("Requested terminal content")).toBeNull();
    expect(window.localStorage.getItem(storageKey)).toBe("unchanged-layout");
  });
});
