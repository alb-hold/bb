import { preloadNativeTerminalPanel } from "./native-terminal-panel-preload";
import { preloadTerminalModules } from "./terminal-modules";
import { prefetchTerminalScreen } from "./terminal-screen-prefetch";

export function warmNativeTerminal(
  terminalId: string | null,
  threadId: string,
) {
  if (terminalId) prefetchTerminalScreen(terminalId, threadId);
  void preloadNativeTerminalPanel().catch(() => undefined);
  preloadTerminalModules();
}
