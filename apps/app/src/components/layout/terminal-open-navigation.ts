import type { NavigateFunction } from "react-router-dom";
import type { ThreadOpenSignal } from "@bb/server-contract";

export function navigateThreadWithTerminalAction(
  navigate: NavigateFunction,
  route: string,
  alreadyOpen: boolean,
  terminalAction: NonNullable<ThreadOpenSignal["terminalAction"]>,
  terminalLayoutAction?: ThreadOpenSignal["terminalLayoutAction"],
): void {
  const state = {
    terminalAction,
    ...(terminalLayoutAction === undefined ? {} : { terminalLayoutAction }),
  };
  void navigate(route, {
    ...(alreadyOpen ? { replace: true } : {}),
    state,
  });
}
