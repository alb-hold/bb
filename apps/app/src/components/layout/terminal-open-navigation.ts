import type { NavigateFunction } from "react-router-dom";
import type { ThreadOpenSignal } from "@bb/server-contract";

export function navigateThreadWithTerminalAction(
  navigate: NavigateFunction,
  route: string,
  alreadyOpen: boolean,
  terminalAction: NonNullable<ThreadOpenSignal["terminalAction"]>,
): void {
  void navigate(route, {
    ...(alreadyOpen ? { replace: true } : {}),
    state: { terminalAction },
  });
}
