// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useThreadSecondaryPanelDrawerVisibility,
  useThreadSecondaryPanelVisibility,
} from "./useThreadSecondaryPanelVisibility";
import { useTerminalAttentionHandoff } from "./useTerminalAttentionHandoff";

const setActiveTerminal = vi.fn();

function HandoffHarness() {
  const location = useLocation();
  const navigate = useNavigate();
  const drawerVisibility = useThreadSecondaryPanelDrawerVisibility({
    isCompactViewport: true,
    threadId: "thr_attention",
  });
  const visibility = useThreadSecondaryPanelVisibility({
    closePersistedPanel: vi.fn(),
    drawerVisibility,
    isCompactViewport: true,
    isPersistedOpen: true,
    openPersistedHostFile: vi.fn(),
    openPersistedPanel: vi.fn(),
    openPersistedStorageFile: vi.fn(),
    openPersistedWorkspaceFile: vi.fn(),
    togglePersistedPanel: vi.fn(),
  });
  const openCompactDrawer = visibility.openCompactDrawer;
  useTerminalAttentionHandoff({
    location,
    navigate,
    openCompactDrawer,
    setActiveTerminal,
    threadId: "thr_attention",
  });

  return <output data-testid="drawer-open">{String(visibility.isOpen)}</output>;
}

afterEach(() => {
  cleanup();
  setActiveTerminal.mockClear();
});

describe("useTerminalAttentionHandoff", () => {
  it("opens the compact drawer and activates the terminal from navigation state", async () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/threads/thr_attention",
            state: { terminalAttentionId: "term_attention" },
          },
        ]}
      >
        <HandoffHarness />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(setActiveTerminal).toHaveBeenCalledWith("term_attention", {
        kind: "thread",
        threadId: "thr_attention",
      });
      expect(screen.getByTestId("drawer-open").textContent).toBe("true");
    });
  });
});
