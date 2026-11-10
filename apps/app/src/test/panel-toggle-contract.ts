import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createEmptyFixedPanelTabsState,
  createTerminalFixedPanelTab,
  type FixedPanelTabsState,
} from "@/lib/fixed-panel-tabs-state";
import type { PanelContractSurface } from "./panel-controller-contract";

export interface PanelToggleMountOptions {
  compact: boolean;
  state: FixedPanelTabsState;
}

export function describePanelToggleContract(
  name: string,
  mount: (options: PanelToggleMountOptions) => Promise<PanelContractSurface>,
) {
  describe.each([true, false])(
    `${name}: compact=%s panel toggle`,
    (compact) => {
      it("reopens the persisted terminal without selecting or adding New tab", async () => {
        const terminal = createTerminalFixedPanelTab({
          terminalId: "term_saved",
          target: { kind: "host_path", hostId: "host_saved", cwd: null },
        });
        const state = createEmptyFixedPanelTabsState({
          lastUsedAt: Date.now(),
        });
        state.secondary = {
          tabs: [terminal],
          activeTabId: terminal.id,
          isOpen: compact,
        };
        const surface = await mount({ compact, state });
        expect(surface.tabs().open).toBe(false);
        expect(surface.tabs().tabs.map((tab) => tab.key)).toContain(
          terminal.id,
        );
        for (let cycle = 0; cycle < 2; cycle++) {
          act(() => {
            surface.command("panel.toggle");
          });
          expect(surface.tabs()).toMatchObject({
            open: true,
            selectedKey: terminal.id,
          });
          expect(surface.snapshot().activeTabId).toBe(terminal.id);
          expect(
            surface.tabs().tabs.filter((tab) => tab.detail.kind === "new-tab"),
          ).toEqual([]);
          act(() => {
            surface.command("panel.toggle");
          });
          expect(surface.tabs().open).toBe(false);
        }
        act(() => {
          surface.command("panel.newTab");
        });
        expect(surface.tabs().open).toBe(true);
        const selected = surface.tabs().selectedKey;
        expect(
          surface.tabs().tabs.find((tab) => tab.key === selected)?.detail.kind,
        ).toBe("new-tab");
        expect(surface.tabs().tabs.map((tab) => tab.key)).toContain(
          terminal.id,
        );
      });

      it("opens and selects New tab when the panel has no active tab", async () => {
        const surface = await mount({
          compact,
          state: createEmptyFixedPanelTabsState({ lastUsedAt: Date.now() }),
        });
        act(() => {
          surface.command("panel.toggle");
        });
        const tabs = surface.tabs();
        expect(tabs.open).toBe(true);
        expect(tabs.selectedKey).not.toBeNull();
        expect(
          tabs.tabs.find((entry) => entry.key === tabs.selectedKey)?.detail
            .kind,
        ).toBe("new-tab");
      });
    },
  );
}
