import { useEffect, useRef } from "react";

export interface CompactTerminalLayoutRequest {
  action: "split" | "move";
  requestId: number;
  side?: "right" | "left" | "up" | "down";
  targetTerminalId?: string;
  terminalId: string;
}

interface UseCompactTerminalLayoutRequestArgs {
  enabled: boolean;
  ensureTerminalTabs: (terminalIds: readonly string[]) => boolean | null;
  onHandled?: (requestId: number) => void;
  onResolved: (terminalAvailable: boolean) => void;
  request: CompactTerminalLayoutRequest | null | undefined;
}

export function useCompactTerminalLayoutRequest({
  enabled,
  ensureTerminalTabs,
  onHandled,
  onResolved,
  request,
}: UseCompactTerminalLayoutRequestArgs) {
  const handledRequestId = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || request == null || handledRequestId.current === request.requestId) return;
    const terminalIds = [
      ...(request.targetTerminalId === undefined ? [] : [request.targetTerminalId]),
      request.terminalId,
    ];
    const result = ensureTerminalTabs(terminalIds);
    if (result === null) return;
    handledRequestId.current = request.requestId;
    onHandled?.(request.requestId);
    onResolved(result);
  }, [enabled, ensureTerminalTabs, onHandled, onResolved, request]);
}
