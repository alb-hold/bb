// @vitest-environment jsdom

import { useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { NATIVE_TERMINAL_SETUP_DELAY_MS } from "@bb/domain";
import type {
  NativeTerminalThread,
  ThreadExecutionProfileResponse,
} from "@bb/server-contract";
import { NATIVE_STATUS_CONTRACT_CASES } from "@bb/test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeThreadTerminalMain } from "./NativeThreadTerminalMain";

const hooks = vi.hoisted(() => ({
  profile: vi.fn<() => { data: ThreadExecutionProfileResponse | null }>(() => ({
    data: null,
  })),
  listTerminals: vi.fn(),
  refetchNative: vi.fn(),
  openNative: vi.fn(),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: hooks.profile,
}));

vi.mock("./NativeTerminalPanel", () => ({
  NativeTerminalPanel: Object.assign(
    () => <div data-testid="terminal-panel" />,
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

vi.mock("./NativeTerminalPromptBar", () => ({
  NativeTerminalPromptBar: () => <div data-testid="prompt-bar" />,
}));

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: [] }),
}));

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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("V5 header: shared native terminal status contract", () => {
  it.each(NATIVE_STATUS_CONTRACT_CASES)(
    "renders $expectedHeaderLabel in the header from server runtime for $name without a client timer",
    (contractCase) => {
      const now = Date.now();
      const terminal: NonNullable<NativeTerminalThread["terminal"]> = {
        id: `term_${contractCase.name}`,
        threadId: `thr_${contractCase.name}`,
        environmentId: "env_contract",
        hostId: "host_contract",
        title: contractCase.displayName,
        initialCwd: "/workspace",
        cols: 120,
        rows: 36,
        status: contractCase.terminalStatus,
        exitCode: contractCase.terminalExitCode,
        closeReason: contractCase.terminalCloseReason,
        createdAt: now,
        updatedAt: now,
        lastUserInputAt: null,
        attention: null,
      };
      hooks.listTerminals.mockReturnValue({
        data: { sessions: [terminal] },
        dataUpdatedAt: 1,
        isLoading: false,
      });
      const view: NativeTerminalThread = {
        threadId: `thr_${contractCase.name}`,
        providerId: contractCase.providerId,
        displayName: contractCase.displayName,
        nativeSessionId: contractCase.nativeSessionId,
        model: null,
        canReturnToChat: false,
        terminal,
      };

      render(
        <TerminalWithHeader
          projectId="proj_contract"
          runtime={contractCase.expectedRuntime}
          threadId={`thr_${contractCase.name}`}
          threadIsProvisioning={false}
          view={view}
        />,
      );

      const status = screen.getByRole("status", { name: "Terminal activity" });
      expect(status.closest("header")).not.toBeNull();
      expect(status.textContent).toBe(contractCase.expectedHeaderLabel);
    },
  );

  it("follows server runtime.nativeSetupWaiting instead of a client-side timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const terminal: NonNullable<NativeTerminalThread["terminal"]> = {
      id: "term_no_client_timer",
      threadId: "thr_no_client_timer",
      environmentId: "env_contract",
      hostId: "host_contract",
      title: "Codex",
      initialCwd: "/workspace",
      cols: 120,
      rows: 36,
      status: "running",
      exitCode: null,
      closeReason: null,
      createdAt: 1_000,
      updatedAt: 1_000,
      lastUserInputAt: null,
      attention: null,
    };
    hooks.listTerminals.mockReturnValue({
      data: { sessions: [terminal] },
      dataUpdatedAt: 1,
      isLoading: false,
    });
    const view: NativeTerminalThread = {
      threadId: "thr_no_client_timer",
      providerId: "codex",
      displayName: "Codex",
      nativeSessionId: null,
      model: null,
      canReturnToChat: false,
      terminal,
    };

    const { rerender } = render(
      <TerminalWithHeader
        projectId="proj_contract"
        runtime={{ displayStatus: "idle" }}
        threadId="thr_no_client_timer"
        threadIsProvisioning={false}
        view={view}
      />,
    );

    const status = () =>
      screen.getByRole("status", { name: "Terminal activity" }).textContent;
    expect(status()).toBe("Idle");

    act(() => vi.advanceTimersByTime(NATIVE_TERMINAL_SETUP_DELAY_MS + 1_000));
    expect(status()).toBe("Idle");

    rerender(
      <TerminalWithHeader
        projectId="proj_contract"
        runtime={{ displayStatus: "idle", nativeSetupWaiting: true }}
        threadId="thr_no_client_timer"
        threadIsProvisioning={false}
        view={view}
      />,
    );
    expect(status()).toBe("Needs input");

    rerender(
      <TerminalWithHeader
        projectId="proj_contract"
        runtime={{ displayStatus: "idle" }}
        threadId="thr_no_client_timer"
        threadIsProvisioning={false}
        view={{ ...view, nativeSessionId: "bound-session" }}
      />,
    );
    expect(status()).toBe("Idle");
  });
});
