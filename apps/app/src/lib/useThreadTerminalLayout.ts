import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalSession } from "@bb/server-contract";
import { resolveThreadTerminalLayout } from "./terminal-session-visibility";
import type { CompactTerminalLayoutRequest } from "./useCompactTerminalLayoutRequest";

export type ThreadTerminalLayoutAction = Omit<
  CompactTerminalLayoutRequest,
  "requestId"
>;

interface ThreadBoundRequest {
  request: CompactTerminalLayoutRequest;
  threadId: string;
}

interface ThreadTerminalList {
  isFetching: boolean;
  isPending: boolean;
  refetch: () => unknown;
  sessions: readonly TerminalSession[] | undefined;
}

export function useThreadTerminalLayoutRequest(threadId: string) {
  const [stored, setStored] = useState<ThreadBoundRequest | null>(null);
  const requestIdRef = useRef(0);
  const request = stored?.threadId === threadId ? stored.request : null;

  useEffect(() => {
    setStored((current) => (current?.threadId === threadId ? current : null));
  }, [threadId]);

  const issue = useCallback(
    (action: ThreadTerminalLayoutAction) => {
      requestIdRef.current += 1;
      setStored({
        request: { ...action, requestId: requestIdRef.current },
        threadId,
      });
    },
    [threadId],
  );

  const clear = useCallback((requestId: number) => {
    setStored((current) =>
      current?.request.requestId === requestId ? null : current,
    );
  }, []);

  return { clear, issue, request };
}

interface UseEnsureThreadTerminalTabsArgs {
  onTabsReady: (sessions: readonly TerminalSession[]) => void;
  request: CompactTerminalLayoutRequest | null;
  terminals: ThreadTerminalList;
  threadId: string;
}

export function useEnsureThreadTerminalTabs({
  onTabsReady,
  request,
  terminals,
  threadId,
}: UseEnsureThreadTerminalTabsArgs) {
  const refreshedRequestIdRef = useRef<number | null>(null);
  const { isFetching, isPending, refetch, sessions } = terminals;

  return useCallback(
    (terminalIds: readonly string[]): boolean | null => {
      const resolution = resolveThreadTerminalLayout({
        isPending: isPending || isFetching,
        sessions,
        terminalIds,
        threadId,
      });
      if (resolution.status === "pending") return null;
      if (resolution.status === "missing") {
        if (
          request !== null &&
          refreshedRequestIdRef.current !== request.requestId
        ) {
          refreshedRequestIdRef.current = request.requestId;
          void refetch();
          return null;
        }
        return false;
      }
      onTabsReady(resolution.sessions);
      return true;
    },
    [isFetching, isPending, onTabsReady, refetch, request, sessions, threadId],
  );
}
