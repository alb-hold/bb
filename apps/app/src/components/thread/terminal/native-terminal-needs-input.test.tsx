// @vitest-environment jsdom

import { useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { NATIVE_TERMINAL_SETUP_DELAY_MS } from "@bb/domain";
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

describe("V5: native header reports Needs input when waiting on user setup/trust prompt", () => {
  it("shows Needs input instead of Idle in the header while waiting for setup and clears on input or binding", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const terminal = {
      id: "term_trust",
      threadId: "thr_trust",
      environmentId: "env_trust",
      hostId: "host_trust",
      title: "Codex",
      initialCwd: "/workspace",
      cols: 120,
      rows: 36,
      status: "running" as const,
      exitCode: null,
      closeReason: null,
      createdAt: 1_000,
      updatedAt: 1_000,
      lastUserInputAt: null as number | null,
      attention: null,
    };
    hooks.listTerminals.mockReturnValue({
      data: { sessions: [terminal] },
      dataUpdatedAt: 1,
    });
    const view: NativeTerminalThread = {
      threadId: "thr_trust",
      providerId: "codex",
      displayName: "Codex",
      nativeSessionId: null,
      model: null,
      canReturnToChat: false,
      terminal,
    };

    const { rerender } = render(
      <TerminalWithHeader
        projectId="proj_trust"
        runtime={{ displayStatus: "idle" }}
        threadId="thr_trust"
        threadIsProvisioning={false}
        view={view}
      />,
    );

    const status = () =>
      screen.getByRole("status", { name: "Terminal activity" }).textContent;
    expect(status()).toBe("Idle");

    act(() => vi.advanceTimersByTime(NATIVE_TERMINAL_SETUP_DELAY_MS));
    expect(status()).toBe("Needs input");

    terminal.lastUserInputAt = Date.now();
    rerender(
      <TerminalWithHeader
        projectId="proj_trust"
        runtime={{ displayStatus: "idle" }}
        threadId="thr_trust"
        threadIsProvisioning={false}
        view={view}
      />,
    );
    expect(status()).toBe("Idle");

    act(() => vi.advanceTimersByTime(NATIVE_TERMINAL_SETUP_DELAY_MS));
    expect(status()).toBe("Needs input");

    rerender(
      <TerminalWithHeader
        projectId="proj_trust"
        runtime={{ displayStatus: "idle" }}
        threadId="thr_trust"
        threadIsProvisioning={false}
        view={{ ...view, nativeSessionId: "bound-session" }}
      />,
    );
    expect(status()).toBe("Idle");
  });
});
