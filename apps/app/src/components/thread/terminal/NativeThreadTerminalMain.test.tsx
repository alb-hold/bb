// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import type {
  ThreadExecutionProfileResponse,
  NativeTerminalThread,
} from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeThreadTerminalMain } from "./NativeThreadTerminalMain";

const hooks = vi.hoisted(() => ({
  profile: vi.fn<() => { data: ThreadExecutionProfileResponse | null }>(() => ({
    data: {
      executed: null,
      lastRequested: null,
      nextTurn: {
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "full",
        serviceTier: "default",
        source: "client/turn/start",
      },
      overrides: { model: null, reasoningLevel: null },
    },
  })),
  listTerminals: vi.fn(),
  preloadTerminalPanel: vi.fn(),
  refetchNative: vi.fn(),
  openNative: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({ useQuery: hooks.profile }));

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

vi.mock("@/hooks/queries/thread-default-execution-options-query", () => ({
  useThreadDefaultExecutionOptions: () => ({
    data: { model: "gpt-5", permissionMode: "full" },
  }),
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

vi.mock("./NativeTerminalPromptBar", () => ({
  NativeTerminalPromptBar: ({
    executionLabel,
  }: {
    executionLabel?: string;
  }) => <div data-testid="execution-defaults">{executionLabel}</div>,
}));

vi.mock("./NativeActivityNotice", () => ({ NativeActivityNotice: () => null }));

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
  hooks.profile.mockReturnValue({
    data: {
      executed: null,
      lastRequested: null,
      nextTurn: {
        model: "gpt-5",
        reasoningLevel: "high" as const,
        permissionMode: "full" as const,
        serviceTier: "default" as const,
        source: "client/turn/start" as const,
      },
      overrides: { model: null, reasoningLevel: null },
    },
  });
  vi.useRealTimers();
});

describe("NativeThreadTerminalMain", () => {
  it("does not guess execution labels while its profile is unresolved", () => {
    hooks.profile.mockReturnValue({ data: null });
    hooks.listTerminals.mockReturnValue({
      data: {
        sessions: [
          {
            id: "term-live",
            status: "running",
            createdAt: 1000,
            lastUserInputAt: null,
          },
        ],
      },
      dataUpdatedAt: 1,
    });
    render(
      <NativeThreadTerminalMain
        projectId="proj_native"
        runtime={{ displayStatus: "idle" }}
        threadId="thr_native"
        threadIsProvisioning={false}
        view={nativeView}
      />,
    );
    expect(screen.queryByText(/GPT|Full Access/)).toBeNull();
  });

  it("cues silent setup after twelve seconds, clearing on first input and binding", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const terminal = {
      id: "term-live",
      status: "running",
      createdAt: 1000,
      lastUserInputAt: null,
    } as NonNullable<NativeTerminalThread["terminal"]>;
    hooks.listTerminals.mockReturnValue({
      data: { sessions: [terminal] },
      dataUpdatedAt: 1,
    });
    const props = {
      projectId: "proj_native",
      runtime: { displayStatus: "idle" as const },
      threadId: "thr_native",
      threadIsProvisioning: false,
      view: { ...nativeView, nativeSessionId: null, terminal },
    };
    const { rerender } = render(<NativeThreadTerminalMain {...props} />);
    expect(screen.queryByText(/may be waiting for setup/)).toBeNull();
    act(() => vi.advanceTimersByTime(12000));
    expect(
      screen.getByText(
        "Check the terminal: Claude Code may be waiting for setup",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("execution-defaults").textContent).toMatch(
      /^Default:/,
    );
    terminal.lastUserInputAt = Date.now();
    rerender(<NativeThreadTerminalMain {...props} />);
    expect(screen.queryByText(/may be waiting for setup/)).toBeNull();
    act(() => vi.advanceTimersByTime(11999));
    expect(screen.queryByText(/may be waiting for setup/)).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText(/may be waiting for setup/)).toBeTruthy();
    rerender(
      <NativeThreadTerminalMain
        {...props}
        view={{ ...props.view, nativeSessionId: "bound" }}
      />,
    );
    act(() => vi.advanceTimersByTime(12000));
    expect(screen.queryByText(/may be waiting for setup/)).toBeNull();
  });

  it.each([
    ["gpt-6-sol", "gpt-6-sol", "session-native", "Live:"],
    ["gpt-6-sol", "different-model", "session-native", "Default:"],
    ["gpt-6-sol", "gpt-6-sol", null, "Default:"],
  ])(
    "labels provider reports without presenting stale or unbound reports as live (%s/%s/%s)",
    (model, requested, nativeSessionId, label) => {
      hooks.profile.mockReturnValue({
        data: {
          executed: {
            model,
            reasoningLevel: null,
            permissionMode: null,
            serviceTier: null,
          },
          lastRequested: {
            model: requested,
            reasoningLevel: "high",
            permissionMode: "full",
            serviceTier: "default",
            source: "client/turn/start",
          },
          nextTurn: {
            model: "gpt-5",
            reasoningLevel: "high" as const,
            permissionMode: "full" as const,
            serviceTier: "default" as const,
            source: "client/turn/start" as const,
          },
          overrides: { model: null, reasoningLevel: null },
        },
      });
      const terminal = {
        id: "term-live",
        status: "running",
        createdAt: Date.now(),
        lastUserInputAt: null,
      } as NonNullable<NativeTerminalThread["terminal"]>;
      hooks.listTerminals.mockReturnValue({
        data: { sessions: [terminal] },
        dataUpdatedAt: 1,
      });
      render(
        <NativeThreadTerminalMain
          projectId="proj_native"
          runtime={{ displayStatus: "idle" }}
          threadId="thr_native"
          threadIsProvisioning={false}
          view={{ ...nativeView, nativeSessionId, terminal }}
        />,
      );
      expect(screen.getByTestId("execution-defaults").textContent).toMatch(
        new RegExp(`^${label}`),
      );
      if (label === "Live:")
        expect(screen.getByTestId("execution-defaults").textContent).toContain(
          "GPT-6-Sol",
        );
    },
  );

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
    expect(
      screen
        .getByText("Claude Code session ended (exit 2)")
        .closest("[data-native-terminal-thread]")
        ?.hasAttribute("data-no-sidebar-swipe"),
    ).toBe(true);
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

it("offers Resume with expired history instead of a terminal panel", () => {
  hooks.listTerminals.mockReturnValue({
    data: { sessions: [] },
    dataUpdatedAt: 2,
    isLoading: false,
  });
  render(
    <NativeThreadTerminalMain
      projectId="proj_test"
      threadId="thr_native"
      runtime={{ displayStatus: "error" }}
      threadIsProvisioning={false}
      view={{
        ...nativeView,
        terminal: {
          id: "expired",
          status: "exited",
          exitCode: 0,
          closeReason: "process-exit",
        } as NativeTerminalThread["terminal"],
      }}
    />,
  );
  expect(screen.getByText(/history expired/i)).toBeTruthy();
  expect(screen.queryByTestId("terminal-panel")).toBeNull();
  screen.getByRole("button", { name: "Resume session" }).click();
  expect(hooks.openNative).toHaveBeenCalledWith({ threadId: "thr_native" });
});

it("labels a proven clean exit as resumable", () => {
  hooks.listTerminals.mockReturnValue({
    data: { sessions: [] },
    dataUpdatedAt: 1,
    isLoading: false,
  });
  render(
    <NativeThreadTerminalMain
      projectId="proj_test"
      threadId="thr_native"
      runtime={{ displayStatus: "error", nativeSessionExit: "clean" }}
      threadIsProvisioning={false}
      view={nativeView}
    />,
  );
  expect(screen.getByText("Exited, resume to continue")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Resume session" })).toBeTruthy();
});

it("keeps retained output while an omitted cached session is being refetched", () => {
  const terminal = {
    id: "retained",
    status: "exited",
    exitCode: 0,
    closeReason: "process-exit",
  } as NativeTerminalThread["terminal"];
  hooks.listTerminals.mockReturnValue({
    data: { sessions: [] },
    dataUpdatedAt: 1,
    isLoading: false,
    isFetching: true,
    isError: false,
  });
  const props = {
    projectId: "proj_test",
    threadId: "thr_native",
    runtime: { displayStatus: "error" as const },
    threadIsProvisioning: false,
    view: { ...nativeView, terminal },
  };
  const rendered = render(<NativeThreadTerminalMain {...props} />);
  expect(screen.queryByText(/history expired/i)).toBeNull();
  expect(screen.getByTestId("terminal-panel")).toBeTruthy();
  hooks.listTerminals.mockReturnValue({
    data: { sessions: [terminal] },
    dataUpdatedAt: 2,
    isLoading: false,
    isFetching: false,
    isError: false,
  });
  rendered.rerender(<NativeThreadTerminalMain {...props} />);
  expect(screen.queryByText(/history expired/i)).toBeNull();
  expect(screen.getByTestId("terminal-panel")).toBeTruthy();
});
