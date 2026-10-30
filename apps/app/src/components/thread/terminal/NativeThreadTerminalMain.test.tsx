// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { NativeTerminalThread } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeThreadTerminalMain } from "./NativeThreadTerminalMain";

const hooks = vi.hoisted(() => ({
  listTerminals: vi.fn(),
  preloadTerminalPanel: vi.fn(),
  refetchNative: vi.fn(),
  openNative: vi.fn(),
}));

vi.mock("@/components/secondary-panel/lazySecondaryPanelComponents", () => ({
  LazyThreadTerminalPanel: Object.assign(
    ({
      onRetryStart,
      onCloseStart,
    }: {
      onRetryStart: () => void;
      onCloseStart: () => void;
    }) => (
      <div data-testid="terminal-panel">
        <button onClick={onRetryStart}>Panel retry</button>
        <button onClick={onCloseStart}>Panel close</button>
      </div>
    ),
    {
      preload: hooks.preloadTerminalPanel,
    },
  ),
}));

vi.mock("@/hooks/queries/thread-terminal-queries", () => ({
  useThreadTerminals: hooks.listTerminals,
}));

vi.mock("@/hooks/queries/native-terminal-queries", () => ({
  useNativeTerminalThread: () => ({
    dataUpdatedAt: 0,
    refetch: hooks.refetchNative,
  }),
  useOpenNativeTerminal: () => ({ isPending: false, mutate: hooks.openNative }),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThreadPendingInteractions: () => ({ data: [] }),
}));

vi.mock("@/hooks/useNativeActivityUnconfirmed", () => ({
  useNativeActivityUnconfirmed: () => false,
  useNativeActivityNotice: () => ({
    evidenceKind: "unknown",
    lastToolCallAt: null,
    now: 0,
    unconfirmed: false,
  }),
}));

vi.mock("@bb/shared-ui/hooks/use-media-query", () => ({
  useMediaQuery: () => false,
}));

vi.mock("@/views/thread-detail/PaneContext", () => ({
  useOptionalPaneContext: () => null,
}));

const nativeView: NativeTerminalThread = {
  threadId: "thr_native",
  providerId: "claude-code",
  displayName: "Claude Code",
  nativeSessionId: "session-native",
  canReturnToChat: true,
  terminal: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NativeThreadTerminalMain", () => {
  it("shows the exited terminal panel with an ended bar and Resume", () => {
    hooks.listTerminals.mockReturnValue({
      data: {
        sessions: [
          {
            id: "term-exited",
            status: "exited",
            exitCode: 2,
            closeReason: "process-exit",
          },
        ],
      },
      dataUpdatedAt: 1,
      isLoading: false,
    });
    render(
      <NativeThreadTerminalMain
        projectId="proj_native"
        runtime={{ displayStatus: "idle" }}
        threadId="thr_native"
        threadIsProvisioning={false}
        view={{
          ...nativeView,
          terminal: {
            id: "term-exited",
            status: "exited",
            exitCode: 2,
            closeReason: "process-exit",
          } as NativeTerminalThread["terminal"],
        }}
      />,
    );
    expect(screen.getByText("Claude Code session ended (exit 2)")).toBeTruthy();
    expect(screen.getByText("Session session-native")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume session" })).toBeTruthy();
    expect(screen.getByTestId("terminal-panel")).toBeTruthy();
  });

  it("resumes by opening the native session", async () => {
    hooks.listTerminals.mockReturnValue({
      data: {
        sessions: [
          {
            id: "term-exited",
            status: "exited",
            exitCode: 0,
            closeReason: "process-exit",
          },
        ],
      },
      dataUpdatedAt: 1,
      isLoading: false,
    });
    render(
      <NativeThreadTerminalMain
        projectId="proj_native"
        runtime={{ displayStatus: "idle" }}
        threadId="thr_native"
        threadIsProvisioning={false}
        view={{
          ...nativeView,
          terminal: {
            id: "term-exited",
            status: "exited",
            exitCode: 0,
            closeReason: "process-exit",
          } as NativeTerminalThread["terminal"],
        }}
      />,
    );
    screen.getByRole("button", { name: "Resume session" }).click();
    expect(hooks.openNative).toHaveBeenCalledWith({ threadId: "thr_native" });
  });

  it("retries by reopening the native session", () => {
    hooks.listTerminals.mockReturnValue({
      data: {
        sessions: [
          {
            id: "term-exited",
            status: "exited",
            exitCode: 0,
            closeReason: "process-exit",
          },
        ],
      },
      dataUpdatedAt: 1,
      isLoading: false,
    });
    render(
      <NativeThreadTerminalMain
        projectId="proj_native"
        runtime={{ displayStatus: "idle" }}
        threadId="thr_native"
        threadIsProvisioning={false}
        view={{
          ...nativeView,
          terminal: {
            id: "term-exited",
            status: "exited",
            exitCode: 0,
            closeReason: "process-exit",
          } as NativeTerminalThread["terminal"],
        }}
      />,
    );
    screen.getByRole("button", { name: "Panel retry" }).click();
    expect(hooks.openNative).toHaveBeenCalledWith({ threadId: "thr_native" });
  });

  it("does not reopen the native session when closing the panel", () => {
    hooks.listTerminals.mockReturnValue({
      data: {
        sessions: [
          {
            id: "term-exited",
            status: "exited",
            exitCode: 0,
            closeReason: "process-exit",
          },
        ],
      },
      dataUpdatedAt: 1,
      isLoading: false,
    });
    render(
      <NativeThreadTerminalMain
        projectId="proj_native"
        runtime={{ displayStatus: "idle" }}
        threadId="thr_native"
        threadIsProvisioning={false}
        view={{
          ...nativeView,
          terminal: {
            id: "term-exited",
            status: "exited",
            exitCode: 0,
            closeReason: "process-exit",
          } as NativeTerminalThread["terminal"],
        }}
      />,
    );
    screen.getByRole("button", { name: "Panel close" }).click();
    expect(hooks.openNative).not.toHaveBeenCalled();
  });

  it("shows loading while its terminal list is pending and no session is known", () => {
    hooks.listTerminals.mockReturnValue({
      data: undefined,
      dataUpdatedAt: 0,
      isLoading: true,
    });
    hooks.refetchNative.mockResolvedValue(undefined);

    render(
      <NativeThreadTerminalMain
        projectId="proj_native"
        runtime={{ displayStatus: "idle" }}
        threadId="thr_native"
        threadIsProvisioning={false}
        view={nativeView}
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("Loading terminals...");
    expect(screen.queryByText("Claude Code session ended")).toBeNull();
    expect(hooks.preloadTerminalPanel).toHaveBeenCalledOnce();
  });

  it("shows the ended state only after the empty terminal list is known", () => {
    hooks.listTerminals.mockReturnValue({
      data: { sessions: [] },
      dataUpdatedAt: 1,
      isLoading: false,
    });
    hooks.refetchNative.mockResolvedValue(undefined);

    render(
      <NativeThreadTerminalMain
        projectId="proj_native"
        runtime={{ displayStatus: "idle" }}
        threadId="thr_native"
        threadIsProvisioning={false}
        view={nativeView}
      />,
    );

    expect(screen.getByText("Claude Code session ended")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
