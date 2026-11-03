// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalSession } from "@bb/server-contract";
import { useCompactTerminalLayoutRequest } from "./useCompactTerminalLayoutRequest";
import {
  useEnsureThreadTerminalTabs,
  useThreadTerminalLayoutRequest,
} from "./useThreadTerminalLayout";
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

interface TerminalList {
  isFetching: boolean;
  isPending: boolean;
  sessions: readonly TerminalSession[] | undefined;
}

const LOADED = (sessions: readonly TerminalSession[]): TerminalList => ({
  isFetching: false,
  isPending: false,
  sessions,
});

function useThreadView(
  threadId: string,
  list: TerminalList,
  compactEnabled: boolean,
  refetch: () => unknown,
  onTabsReady: (sessions: readonly TerminalSession[]) => void,
) {
  const layout = useThreadTerminalLayoutRequest(threadId);
  const ensureTerminalTabs = useEnsureThreadTerminalTabs({
    onTabsReady,
    request: layout.request,
    terminals: { ...list, refetch },
    threadId,
  });
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

interface ViewProps {
  compactEnabled: boolean;
  list: TerminalList;
  threadId: string;
}

function renderThreadView(initial: ViewProps) {
  const refetch = vi.fn();
  const onTabsReady = vi.fn();
  const view = renderHook(
    ({ compactEnabled, list, threadId }: ViewProps) =>
      useThreadView(threadId, list, compactEnabled, refetch, onTabsReady),
    { initialProps: initial },
  );
  return { ...view, onTabsReady, refetch };
}

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
});

describe("opening a thread after an unresolved terminal layout request", () => {
  const liveA = makeTerminalSession({ id: "term-a", threadId: "thread-a" });
  const exitedA = makeTerminalSession({
    id: "term-a",
    threadId: "thread-a",
    status: "exited",
    exitCode: 0,
  });

  it("does not toast on the next thread when the request was left unresolved on the previous one", async () => {
    const { result, rerender } = renderThreadView({
      compactEnabled: false,
      list: LOADED([exitedA]),
      threadId: "thread-a",
    });

    act(() => result.current.issue(SPLIT_ACTION));
    expect(result.current.request).not.toBeNull();

    rerender({ compactEnabled: true, list: LOADED([]), threadId: "thread-b" });

    await waitFor(() => expect(result.current.request).toBeNull());
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("does not toast while the opened thread's terminal list has not loaded", async () => {
    const { result, rerender, onTabsReady } = renderThreadView({
      compactEnabled: true,
      list: { isFetching: true, isPending: true, sessions: undefined },
      threadId: "thread-a",
    });

    act(() => result.current.issue(SPLIT_ACTION));
    rerender({
      compactEnabled: true,
      list: { isFetching: false, isPending: false, sessions: undefined },
      threadId: "thread-a",
    });

    expect(toastWarning).not.toHaveBeenCalled();
    expect(result.current.request).not.toBeNull();

    rerender({ compactEnabled: true, list: LOADED([liveA]), threadId: "thread-a" });
    await waitFor(() => expect(result.current.request).toBeNull());
    expect(onTabsReady).toHaveBeenCalledWith([liveA]);
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("selects a live terminal without a toast", async () => {
    const { result, onTabsReady } = renderThreadView({
      compactEnabled: true,
      list: LOADED([liveA]),
      threadId: "thread-a",
    });

    act(() => result.current.issue(SPLIT_ACTION));

    await waitFor(() => expect(result.current.request).toBeNull());
    expect(onTabsReady).toHaveBeenCalledWith([liveA]);
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("tells the user once, on its own thread, when the terminal they acted on has exited", async () => {
    const list = LOADED([exitedA]);
    const { result, rerender, refetch } = renderThreadView({
      compactEnabled: true,
      list,
      threadId: "thread-a",
    });

    act(() => result.current.issue(SPLIT_ACTION));

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(toastWarning).not.toHaveBeenCalled();

    rerender({
      compactEnabled: true,
      list: { ...list, isFetching: true },
      threadId: "thread-a",
    });
    expect(toastWarning).not.toHaveBeenCalled();

    rerender({ compactEnabled: true, list: { ...list }, threadId: "thread-a" });

    await waitFor(() =>
      expect(toastWarning).toHaveBeenCalledWith(
        "The terminal is no longer available in this thread.",
      ),
    );
    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(result.current.request).toBeNull();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
