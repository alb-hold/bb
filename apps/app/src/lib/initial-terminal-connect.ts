import { markTerminalPerformance } from "./terminal-performance";
import { prefetchTerminalSocket } from "@/components/thread/terminal/terminal-socket-prefetch";
import { buildTerminalWebSocketUrl } from "@/components/thread/terminal/terminal-websocket-url";
import { ensureDeviceHandoffId } from "./device-handoff-identity";
import "./initial-native-terminal-request";
import { loadNativeTerminalPanel } from "@/components/thread/terminal/native-terminal-panel-loader";
import { preloadTerminalModules } from "@/components/thread/terminal/terminal-modules";

markTerminalPerformance("terminal-initial-connector-ready");
const initial = globalThis.__bbInitialNativeTerminalRequest;
if (initial) {
  void initial.response
    .then(async (response) => {
      if (!response.ok) return;
      const view: unknown = await response.clone().json();
      const match = /^(?:\/projects\/[^/]+)?\/threads\/([^/]+)\/?$/.exec(
        location.pathname,
      );
      if (
        typeof view !== "object" ||
        view === null ||
        !("threadId" in view) ||
        typeof view.threadId !== "string" ||
        !match ||
        decodeURIComponent(match[1]!) !== view.threadId ||
        !("terminal" in view)
      )
        return;
      const terminal = view.terminal;
      if (
        typeof terminal !== "object" ||
        terminal === null ||
        !("status" in terminal) ||
        terminal.status !== "running" ||
        !("id" in terminal) ||
        typeof terminal.id !== "string" ||
        terminal.id.length === 0 ||
        terminal.id.length > 256
      )
        return;
      preloadTerminalModules();
      prefetchTerminalSocket(
        buildTerminalWebSocketUrl({
          terminalId: terminal.id,
          handoffOwnerToken: ensureDeviceHandoffId(),
        }),
      );
      void loadNativeTerminalPanel().catch(() => undefined);
      void import("@/views/thread-detail/LazyThreadDetailView")
        .then(({ LazyThreadDetailView }) => LazyThreadDetailView.preload())
        .catch(() => undefined);
    })
    .catch(() => undefined);
}
