import type { NativeTerminalThread } from "@bb/server-contract";
import { QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { nativeTerminalThreadQueryKey } from "../queries/query-keys";
import {
  applyNativeTerminalModeSwitch,
  applyNativeTerminalThreadView,
  applyTerminalSessionClose,
  applyTerminalSessionUpsert,
} from "./terminal-cache-owner";

function watchNativeView(threadId: string) {
  const queryClient = createAppQueryClient();
  const fetchView = vi.fn(
    async (): Promise<NativeTerminalThread | null> => null,
  );
  queryClient.setQueryData(nativeTerminalThreadQueryKey(threadId), null);
  const observer = new QueryObserver(queryClient, {
    queryKey: nativeTerminalThreadQueryKey(threadId),
    queryFn: fetchView,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  return { fetchView, queryClient, unsubscribe };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("native terminal view cache", () => {
  it("rereads a thread's native view when one of its terminals opens or closes", async () => {
    const { fetchView, queryClient, unsubscribe } = watchNativeView("thr_a");
    const session = makeTerminalSession({ id: "term_a", threadId: "thr_a" });

    applyTerminalSessionUpsert({ queryClient, session });
    await settle();
    expect(fetchView).toHaveBeenCalledTimes(1);

    applyTerminalSessionClose({
      queryClient,
      session: { ...session, status: "exited", exitCode: 0 },
      terminalId: session.id,
    });
    await settle();
    expect(fetchView).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("leaves other threads' native views alone", async () => {
    const { fetchView, queryClient, unsubscribe } = watchNativeView("thr_a");
    applyTerminalSessionUpsert({
      queryClient,
      session: makeTerminalSession({ threadId: "thr_b" }),
    });
    applyTerminalSessionUpsert({
      queryClient,
      session: makeTerminalSession({ threadId: null }),
    });
    await settle();
    expect(fetchView).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("keeps a native view the server just returned without rereading it", async () => {
    const { fetchView, queryClient, unsubscribe } = watchNativeView("thr_a");
    const view: NativeTerminalThread = {
      threadId: "thr_a",
      providerId: "claude-code",
      displayName: "Claude Code",
      nativeSessionId: "session-a",
      terminal: makeTerminalSession({ id: "term_a", threadId: "thr_a" }),
    };
    applyNativeTerminalThreadView({ queryClient, view });
    await settle();
    expect(fetchView).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryData(nativeTerminalThreadQueryKey("thr_a")),
    ).toBe(view);
    unsubscribe();
  });

  it("drops a reread already in flight when the thread returns to chat", async () => {
    const queryClient = createAppQueryClient();
    const key = nativeTerminalThreadQueryKey("thr_a");
    const stale: NativeTerminalThread = {
      threadId: "thr_a",
      providerId: "claude-code",
      displayName: "Claude Code",
      nativeSessionId: "session-a",
      terminal: null,
    };
    queryClient.setQueryData(key, stale);
    let answer: (view: NativeTerminalThread) => void = () => undefined;
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: ({ signal }) =>
        new Promise<NativeTerminalThread | null>((resolve, reject) => {
          answer = resolve;
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    void queryClient.invalidateQueries({ queryKey: key, exact: true });
    await settle();

    await applyNativeTerminalModeSwitch({
      queryClient,
      threadId: "thr_a",
      view: null,
    });
    answer(stale);
    await settle();
    expect(queryClient.getQueryData(key)).toBeNull();
    unsubscribe();
  });
});
