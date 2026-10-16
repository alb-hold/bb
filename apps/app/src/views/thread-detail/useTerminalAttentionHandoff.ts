import { useEffect } from "react";
import type { Location } from "react-router-dom";

export function useTerminalAttentionHandoff({
  location,
  navigate,
  openCompactDrawer,
  setActiveTerminal,
  threadId,
}: {
  location: Location;
  navigate: (
    path: string,
    options: { replace: true; state: null },
  ) => void | Promise<void>;
  openCompactDrawer: () => void;
  setActiveTerminal: (
    terminalId: string,
    target: { kind: "thread"; threadId: string },
  ) => void;
  threadId: string;
}) {
  const terminalAttentionId =
    location.state !== null &&
    typeof location.state === "object" &&
    "terminalAttentionId" in location.state &&
    typeof location.state.terminalAttentionId === "string"
      ? location.state.terminalAttentionId
      : null;

  useEffect(() => {
    if (terminalAttentionId === null) return;
    setActiveTerminal(terminalAttentionId, { kind: "thread", threadId });
    openCompactDrawer();
    void navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: null,
    });
  }, [
    location.hash,
    location.pathname,
    location.search,
    navigate,
    openCompactDrawer,
    setActiveTerminal,
    terminalAttentionId,
    threadId,
  ]);
}
