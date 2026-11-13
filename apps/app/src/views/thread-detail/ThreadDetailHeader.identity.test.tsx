// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThreadDetailHeader } from "./ThreadDetailHeader";

vi.mock("@/components/thread/ThreadUsageSummary", () => ({
  ThreadUsageAndAgents: () => null,
}));

vi.mock("@/lib/thread-actions/thread-action-registry", () => ({
  useThreadHeaderActionEntries: () => [],
}));

vi.mock("@/components/sidebar/SidebarInlineRename", () => ({
  useSidebarRename: () => ({
    editor: null,
    isEditing: false,
    startEditing: vi.fn(),
    startEditingFromDoubleClick: vi.fn(),
    startEditingFromMenu: vi.fn(),
    onCloseAutoFocus: vi.fn(),
  }),
}));

vi.mock("@/components/thread/ThreadActionsProvider", () => ({
  useThreadActions: () => ({ renameThreadAsync: vi.fn() }),
}));

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandRunner: () => ({
    dispatch: vi.fn(),
    isCommandAvailable: () => true,
  }),
  useAppCommandHandler: vi.fn(),
  useAppCommandShortcut: () => null,
  useIsAppCommandModifierHeld: () => false,
}));

vi.mock("@/lib/bb-desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bb-desktop")>()),
  DEFAULT_DESKTOP_WINDOW_STATE: { isFullScreen: false },
  getBbDesktopInfo: () => null,
  shouldUseMacosDesktopChrome: () => false,
}));

vi.mock("@/components/ui/sidebar.js", () => ({
  useIsSidebarShowing: () => false,
  useOptionalIsSidebarShowing: () => false,
  useSidebarKeepsCollapsedRail: () => false,
  useIsSidebarFramed: () => false,
}));

vi.mock("./PaneContext", () => ({
  usePaneContext: () => ({
    beginPaneDrag: undefined,
    isFocused: true,
    isTopRow: true,
    ownsWindowTopLeft: false,
    reservesWindowPanelToggle: false,
    secondaryPanelHost: null,
  }),
}));

vi.mock("@/lib/split-layout/atoms", () => ({
  dimInactiveSplitsAtom: {},
}));

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return { ...actual, useAtomValue: () => false };
});

vi.mock("@/lib/provider-icon", () => ({
  getProviderIconInfo: () => ({
    icon: ({ className }: { className?: string }) => (
      <span data-testid="provider-mark" className={className} />
    ),
  }),
}));

describe("ThreadDetailHeader identity", () => {
  it("shows the provider leading mark with native-terminal accessible name", () => {
    render(
      <ThreadDetailHeader
        actionsMenu={null}
        environmentId={null}
        isSecondaryPanelOpen={false}
        onToggleSecondaryPanel={vi.fn()}
        thread={{
          id: "thr_one",
          projectId: "prj_one",
          parentThreadId: null,
          parentNotifications: "auto",
          archivedAt: null,
          pinnedAt: null,
          sectionId: null,
          isUnread: false,
          status: "idle",
          environment: null,
        }}
        threadTitle="Terminal session"
        hasNativeTerminal
        providerId="codex"
        provider={{ displayName: "Codex", id: "codex" } as never}
        nativeTerminal
        environmentIsWorktree={false}
      />,
    );
    expect(screen.getByTestId("provider-mark")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Codex, native terminal" })).toBeTruthy();
  });
});
