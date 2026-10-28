// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalSession } from "@bb/server-contract";
import { resolveThreadTerminalLayout } from "./terminal-session-visibility";
import { useCompactTerminalLayoutRequest } from "./useCompactTerminalLayoutRequest";
import { useThreadTerminalLayoutRequest } from "./useThreadTerminalLayoutRequest";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";

const toastWarning = vi.hoisted(() => vi.fn());

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { warning: toastWarning },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const SPLIT_ACTION = {
  action: "split",
  side: "right",
  terminalId: "term-a",
} as const;

describe("useThreadTerminalLayoutRequest", () => {
  it("does not carry a request issued on one thread to another thread or back", () => {
    const { result, rerender } = renderHook(
      ({ threadId }) => useThreadTerminalLayoutRequest(threadId),
      { initialProps: { threadId: "thread-a" } },
    );

    act(() => result.current.issue(SPLIT_ACTION));
    expect(result.current.request).toMatchObject({ terminalId: "term-a" });

    rerender({ threadId: "thread-b" });
    expect(result.current.request).toBeNull();

    rerender({ threadId: "thread-a" });
    expect(result.current.request).toBeNull();
  });

  it("clears only the request it was asked to clear", () => {
    const { result } = renderHook(() => useThreadTerminalLayoutRequest("thread-a"));

    act(() => result.current.issue(SPLIT_ACTION));
    const requestId = result.current.request!.requestId;

    act(() => result.current.clear(requestId + 1));
    expect(result.current.request).not.toBeNull();

    act(() => result.current.clear(requestId));
    expect(result.current.request).toBeNull();
  });

  it("allows one list refresh per request", () => {
    const { result } = renderHook(() => useThreadTerminalLayoutRequest("thread-a"));

    expect(result.current.claimRefresh(1)).toBe(true);
    expect(result.current.claimRefresh(1)).toBe(false);
    expect(result.current.claimRefresh(2)).toBe(true);
  });
});

interface TerminalList {
  isPending: boolean;
  sessions: readonly TerminalSession[] | undefined;
}

function useOpenedThreadToasts(threadId: string, list: TerminalList, compactEnabled: boolean) {
  const layout = useThreadTerminalLayoutRequest(threadId);
  const ensureTerminalTabs = useCallback(
    (terminalIds: readonly string[]) => {
      const resolution = resolveThreadTerminalLayout({
        isPending: list.isPending,
        sessions: list.sessions,
        terminalIds,
        threadId,
      });
      if (resolution.status === "pending") return null;
      return resolution.status === "ready";
    },
    [list, threadId],
  );
  useCompactTerminalLayoutRequest({
    enabled: compactEnabled,
    ensureTerminalTabs,
    onHandled: layout.clear,
    onResolved: (terminalAvailable) => {
      if (!terminalAvailable) {
        toastWarning("The terminal is no longer available in this thread.");
      }
    },
    request: layout.request,
  });
  return layout;
}

describe("opening a thread", () => {
  const liveA = makeTerminalSession({ id: "term-a", threadId: "thread-a" });

  it("does not toast for a layout request left over from the previous thread", async () => {
    const { result, rerender } = renderHook(
      ({ threadId, list, compactEnabled }) =>
        useOpenedThreadToasts(threadId, list, compactEnabled),
      {
        initialProps: {
          threadId: "thread-a",
          list: { isPending: false, sessions: [liveA] } as TerminalList,
          compactEnabled: false,
        },
      },
    );

    act(() => result.current.issue(SPLIT_ACTION));

    rerender({
      threadId: "thread-b",
      list: { isPending: false, sessions: [] },
      compactEnabled: true,
    });

    await waitFor(() => expect(result.current.request).toBeNull());
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("does not toast while the opened thread's terminal list has not loaded", async () => {
    const { result, rerender } = renderHook(
      ({ list }) => useOpenedThreadToasts("thread-a", list, true),
      { initialProps: { list: { isPending: true, sessions: undefined } as TerminalList } },
    );

    act(() => result.current.issue(SPLIT_ACTION));
    rerender({ list: { isPending: false, sessions: undefined } });

    expect(toastWarning).not.toHaveBeenCalled();
    expect(result.current.request).not.toBeNull();

    rerender({ list: { isPending: false, sessions: [liveA] } });
    await waitFor(() => expect(result.current.request).toBeNull());
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("still toasts when the user's split targets a terminal the loaded list shows is gone", async () => {
    const exited = makeTerminalSession({
      id: "term-a",
      threadId: "thread-a",
      status: "exited",
      exitCode: 0,
    });
    const { result } = renderHook(() =>
      useOpenedThreadToasts("thread-a", { isPending: false, sessions: [exited] }, true),
    );

    act(() => result.current.issue(SPLIT_ACTION));

    await waitFor(() =>
      expect(toastWarning).toHaveBeenCalledWith(
        "The terminal is no longer available in this thread.",
      ),
    );
    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(result.current.request).toBeNull();
  });
});
