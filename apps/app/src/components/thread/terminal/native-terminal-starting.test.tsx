// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import type {
  NativeTerminalThread,
  ThreadExecutionProfileResponse,
} from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeThreadTerminalMain } from "./NativeThreadTerminalMain";

const hooks = vi.hoisted(() => ({
  profile: vi.fn<() => { data: ThreadExecutionProfileResponse | null }>(() => ({
    data: null,
  })),
  listTerminals: vi.fn(),
  refetchNative: vi.fn(),
  openNative: vi.fn(),
  openNativePending: false,
  panelStarting: undefined as boolean | undefined,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: hooks.profile,
}));

vi.mock("./NativeTerminalPanel", () => ({
  NativeTerminalPanel: Object.assign(
    ({ starting }: { starting?: boolean }) => {
      hooks.panelStarting = starting;
      return (
        <div
          data-testid="terminal-panel"
          data-starting={starting ? "true" : "false"}
        />
      );
    },
    { preload: vi.fn() },
  ),
}));

vi.mock("@/hooks/queries/thread-terminal-queries", () => ({
  useThreadTerminals: hooks.listTerminals,
}));

vi.mock("@/hooks/queries/native-terminal-queries", () => ({
  useNativeTerminalThread: () => ({
    dataUpdatedAt: 1,
    refetch: hooks.refetchNative,
  }),
  useOpenNativeTerminal: () => ({
    isPending: hooks.openNativePending,
    mutate: hooks.openNative,
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
  NativeTerminalPromptBar: () => <div data-testid="prompt-bar" />,
}));

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: [] }),
}));

const baseView: NativeTerminalThread = {
  threadId: "thr_starting",
  providerId: "claude-code",
  displayName: "Claude Code",
  nativeSessionId: "session-starting",
  model: null,
  canReturnToChat: false,
  terminal: null,
};

afterEach(() => {
  cleanup();
  hooks.openNativePending = false;
  hooks.panelStarting = undefined;
  vi.clearAllMocks();
});

describe("V3 UI: new native thread shows starting state before its terminal exists", () => {
  it("shows Starting terminal and never ended or resume UI while provisioning and across query settle", async () => {
    let finishRefetch!: () => void;
    hooks.refetchNative.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRefetch = resolve;
        }),
    );
    hooks.listTerminals.mockReturnValue({
      data: { sessions: [] },
      dataUpdatedAt: 1,
      isLoading: false,
    });

    const { rerender } = render(
      <NativeThreadTerminalMain
        projectId="proj_starting"
        runtime={{ displayStatus: "starting" }}
        threadId="thr_starting"
        threadIsProvisioning
        view={baseView}
      />,
    );

    expect(screen.getByText("Starting terminal…")).toBeTruthy();
    expect(screen.queryByText(/session ended/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /resume session/i })).toBeNull();
    expect(screen.queryByText(/Restoring session/i)).toBeNull();

    rerender(
      <NativeThreadTerminalMain
        projectId="proj_starting"
        runtime={{ displayStatus: "idle" }}
        threadId="thr_starting"
        threadIsProvisioning={false}
        view={baseView}
      />,
    );

    expect(screen.getByText("Starting terminal…")).toBeTruthy();
    expect(screen.queryByText(/session ended/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /resume session/i })).toBeNull();

    const liveTerminal = {
      id: "term_starting",
      threadId: "thr_starting",
      environmentId: "env_starting",
      hostId: "host_starting",
      title: "Claude Code",
      initialCwd: "/workspace",
      cols: 120,
      rows: 36,
      status: "running" as const,
      exitCode: null,
      closeReason: null,
      createdAt: 1000,
      updatedAt: 1000,
      lastUserInputAt: null,
      attention: null,
    };
    hooks.listTerminals.mockReturnValue({
      data: { sessions: [liveTerminal] },
      dataUpdatedAt: 2,
      isLoading: false,
    });

    await act(async () => {
      finishRefetch();
    });

    rerender(
      <NativeThreadTerminalMain
        projectId="proj_starting"
        runtime={{ displayStatus: "idle" }}
        threadId="thr_starting"
        threadIsProvisioning={false}
        view={{ ...baseView, terminal: liveTerminal, hasOutput: false }}
      />,
    );

    expect(screen.getByText("Starting terminal…")).toBeTruthy();
    expect(screen.queryByText(/Restoring session/i)).toBeNull();
    expect(hooks.panelStarting).toBe(true);
  });
});
