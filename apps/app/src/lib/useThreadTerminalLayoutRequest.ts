import { useCallback, useEffect, useRef, useState } from "react";
import type { CompactTerminalLayoutRequest } from "./useCompactTerminalLayoutRequest";

export type ThreadTerminalLayoutAction = Omit<
  CompactTerminalLayoutRequest,
  "requestId"
>;

interface ThreadBoundRequest {
  request: CompactTerminalLayoutRequest;
  threadId: string;
}

export function useThreadTerminalLayoutRequest(threadId: string) {
  const [stored, setStored] = useState<ThreadBoundRequest | null>(null);
  const requestIdRef = useRef(0);
  const refreshedRequestIdRef = useRef<number | null>(null);
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

  const claimRefresh = useCallback((requestId: number) => {
    if (refreshedRequestIdRef.current === requestId) return false;
    refreshedRequestIdRef.current = requestId;
    return true;
  }, []);

  return { claimRefresh, clear, issue, request };
}
