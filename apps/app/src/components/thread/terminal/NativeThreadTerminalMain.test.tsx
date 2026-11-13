// @vitest-environment jsdom

import { useState } from "react";
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
  waiting: false,
  approval: false,
  unconfirmed: false,
  listTerminals: vi.fn(),
  preloadTerminalPanel: vi.fn(),
  refetchNative: vi.fn(),
  openNative: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({ useQuery: hooks.profile }));

vi.mock("./NativeTerminalPanel", () => ({
  NativeTerminalPanel: Object.assign(
    ({
      attentionShownAsBanner,
      onRetryStart,
      onCloseStart,
    }: {
      attentionShownAsBanner?: boolean;
      onRetryStart: () => void;
      onCloseStart: () => void;
    }) => (
      <div
        data-testid="terminal-panel"
        data-attention-banner={attentionShownAsBanner ? "true" : "false"}
      >
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
  useThreadPendingInteractions: () => ({
    data: hooks.waiting
      ? [
          {
            id: "interaction",
            threadId: "thr_native",
            turnId: "turn",
            status: "pending",
            statusReason: null,
            createdAt: 1,
            resolvedAt: null,
            resolution: null,
            providerId: "codex",
            providerThreadId: "session",
            providerRequestId: "request",
            payload: hooks.approval
              ? {
                  kind: "approval",
                  subject: {
                    kind: "command",
                    itemId: "command",
                    command: "pwd",
                    cwd: null,
                    actions: [],
                    sessionGrant: null,
                  },
                  reason: null,
                  availableDecisions: ["allow_once", "deny"],
                }
              : {
                  kind: "user_question",
                  questions: [
                    {
                      id: "q",
                      prompt: "Continue?",
                      multiSelect: false,
                      allowFreeText: true,
                      required: true,
                    },
                  ],
                },
          },
        ]
      : [],
  }),
}));

vi.mock("@/hooks/useNativeActivityUnconfirmed", () => ({
  useNativeActivityUnconfirmed: () => false,
  useNativeActivityNotice: () => ({
    evidenceKind: "unknown",
    lastToolCallAt: null,
    now: 0,
    unconfirmed: hooks.unconfirmed,
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
    modelLabel,
  }: {
    executionLabel?: string;
    modelLabel?: string;
  }) => (
    <>
      <div data-testid="execution-defaults">{executionLabel}</div>
      {modelLabel ? (
        <span aria-label="Terminal model">{modelLabel}</span>
      ) : null}
    </>
  ),
}));

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: [] }),
}));

const nativeView: NativeTerminalThread = {
  threadId: "thr_native",
  providerId: "claude-code",
  displayName: "Claude Code",
  nativeSessionId: "session-native",
  model: null,
  canReturnToChat: true,
  terminal: null,
};

afterEach(() => {
  cleanup();
  hooks.waiting = false;
  hooks.approval = false;
  hooks.unconfirmed = false;
  vi.clearAllMocks();
  vi.restoreAllMocks();
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

function TerminalWithHeader(
  props: Parameters<typeof NativeThreadTerminalMain>[0],
) {
  const [activityTarget, setActivityTarget] = useState<HTMLDivElement | null>(
    null,
  );
  return (
    <>
      <header>
        <div ref={setActivityTarget} />
      </header>
      <NativeThreadTerminalMain {...props} activityTarget={activityTarget} />
    </>
  );
}

describe("NativeThreadTerminalMain", () => {
  it.each(
    [false, true].flatMap(
      (compact) =>
        [
          ["active", "Working", false, false, false, compact],
          ["idle", "Idle", false, false, false, compact],
          ["active", "Check terminal", true, false, false, compact],
          ["active", "Needs input", true, true, false, compact],
          ["active", "Needs input", true, true, true, compact],
          ["idle", "Needs input", false, true, false, compact],
        ] as const,
    ),
  )(
    "places %s activity (%s), attention=%s, pending=%s, approval=%s inside the header on compact=%s",
    (displayStatus, label, attention, pending, approval, compact) => {
      vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
        matches: compact,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: () => false,
      }));
      hooks.waiting = pending;
      hooks.approval = approval;
      const terminal = {
        id: "term-live",
        status: "running",
        createdAt: Date.now(),
        lastUserInputAt: null,
        attention: attention ? { at: 10, kind: "bell", seq: 1 } : null,
      } as NonNullable<NativeTerminalThread["terminal"]>;
      hooks.listTerminals.mockReturnValue({
        data: { sessions: [terminal] },
        dataUpdatedAt: 1,
      });
      render(
        <TerminalWithHeader
          projectId="proj_native"
          runtime={{ displayStatus }}
          threadId="thr_native"
          threadIsProvisioning={false}
          view={{ ...nativeView, terminal }}
        />,
      );
      const status = screen.getByRole("status", { name: "Terminal activity" });
      expect(status.textContent).toBe(label);
      expect(status.closest("header")).not.toBeNull();
      expect(status.querySelector("svg, [aria-hidden]")).not.toBeNull();
      expect(
        document.querySelector(
          "[data-native-terminal-thread] [aria-label='Terminal activity']",
        ),
      ).toBeNull();
    },
  );

  it("keeps the terminal layout unchanged when attention clears", () => {
    const terminal = {
      id: "term-live",
      status: "running",
      createdAt: Date.now(),
      lastUserInputAt: null,
      attention: { at: 10, kind: "bell", seq: 1 },
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
      view: { ...nativeView, terminal },
    };
    const { container, rerender } = render(<TerminalWithHeader {...props} />);
    const layout = () =>
      Array.from(
        container.querySelector("[data-native-terminal-thread]")!.children,
      ).map((element) => [element.tagName, element.className]);
    const layoutWithAttention = layout();
    expect(
      screen.getByRole("status", { name: "Terminal activity" }).textContent,
    ).toBe("Check terminal");
    expect(container.querySelector(".ring-attention")).toBeNull();
    expect(
      screen
        .getByTestId("terminal-panel")
        .getAttribute("data-attention-banner"),
    ).toBe("true");
    terminal.attention = null;
    rerender(<TerminalWithHeader {...props} />);
    expect(screen.queryByText("Check terminal")).toBeNull();
    expect(layout()).toEqual(layoutWithAttention);
  });
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
    expect(screen.queryByText(/hasn't started a session yet/)).toBeNull();
    act(() => void vi.advanceTimersByTime(12000));
    expect(
      screen.getByText("Claude Code hasn't started a session yet"),
    ).toBeTruthy();
    expect(screen.getByTestId("execution-defaults").textContent).toMatch(
      /^Default:/,
    );
    terminal.lastUserInputAt = Date.now();
    rerender(<NativeThreadTerminalMain {...props} />);
    expect(screen.queryByText(/hasn't started a session yet/)).toBeNull();
    act(() => void vi.advanceTimersByTime(11999));
    expect(screen.queryByText(/hasn't started a session yet/)).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.queryByText(/hasn't started a session yet/)).toBeTruthy();
    rerender(
      <NativeThreadTerminalMain
        {...props}
        view={{ ...props.view, nativeSessionId: "bound" }}
      />,
    );
    act(() => void vi.advanceTimersByTime(12000));
    expect(screen.queryByText(/hasn't started a session yet/)).toBeNull();
  });

  it.each(["waiting", "activity notice"])(
    "does not stack setup guidance over %s",
    (signal) => {
      hooks.waiting = signal === "waiting";
      hooks.unconfirmed = signal === "activity notice";
      const terminal = {
        id: "term-live",
        status: "running",
        createdAt: Date.now() - 13_000,
        lastUserInputAt: null,
      } as NonNullable<NativeTerminalThread["terminal"]>;
      hooks.listTerminals.mockReturnValue({
        data: { sessions: [terminal] },
        dataUpdatedAt: 1,
      });
      render(
        <NativeThreadTerminalMain
          projectId="proj_native"
          runtime={{ displayStatus: "active" }}
          threadId="thr_native"
          threadIsProvisioning={false}
          view={{ ...nativeView, nativeSessionId: null, terminal }}
        />,
      );
      expect(screen.queryByText(/hasn't started a session yet/)).toBeNull();
      if (signal === "waiting") {
        expect(
          screen.getByText(/waiting for your answer in the terminal/),
        ).toBeTruthy();
      } else {
        expect(screen.getByText(/Activity not reported/)).toBeTruthy();
      }
    },
  );

  it.each([
    ["gpt-6-sol", "gpt-6-sol", "session-native", "Last reported:"],
    ["gpt-6-sol", "different-model", "session-native", "Last reported:"],
    ["gpt-6-sol", "gpt-6-sol", null, "Last reported:"],
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
      if (label === "Last reported:")
        expect(screen.getByTestId("execution-defaults").textContent).toContain(
          "GPT-6-Sol",
        );
      expect(screen.getByTestId("execution-defaults").textContent).toContain(
        "Default: GPT-5",
      );
      expect(screen.queryByText(/^Live:/)).toBeNull();
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

it.each(["gpt-6.1-sol", null])(
  "uses only the native record model (%s) when the execution profile is empty",
  (model) => {
    hooks.profile.mockReturnValue({
      data: {
        executed: null,
        nextTurn: null,
        lastRequested: null,
        overrides: { model: null, reasoningLevel: null },
      },
    });
    const terminal: NonNullable<NativeTerminalThread["terminal"]> = {
      id: "term-live",
      threadId: "thr_native",
      environmentId: "env_native",
      hostId: "host_native",
      title: "Codex",
      initialCwd: "/workspace",
      cols: 80,
      rows: 24,
      status: "running",
      exitCode: null,
      closeReason: null,
      createdAt: 1000,
      updatedAt: 1000,
      lastUserInputAt: null,
    };
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
        view={{
          ...nativeView,
          providerId: "codex",
          displayName: "Codex",
          model,
          terminal,
        }}
      />,
    );
    expect(screen.getByTestId("terminal-panel")).toBeTruthy();
    if (model) {
      expect(screen.getByLabelText("Terminal model").textContent).toBe(
        "GPT-6.1-Sol",
      );
    } else {
      expect(screen.queryByLabelText("Terminal model")).toBeNull();
    }
    expect(
      screen.queryByLabelText("Terminal model and permissions"),
    ).toBeNull();
  },
);
