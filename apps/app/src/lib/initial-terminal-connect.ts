import { markTerminalPerformance } from "./terminal-performance";
import { prefetchTerminalSocket } from "@/components/thread/terminal/terminal-socket-prefetch";
import { buildTerminalWebSocketUrl } from "@/components/thread/terminal/terminal-websocket-url";
import { ensureDeviceHandoffId } from "./device-handoff-identity";
import "./initial-native-terminal-request";
import { loadNativeTerminalPanel } from "@/components/thread/terminal/native-terminal-panel-loader";

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
        !("terminal" in view) ||
        typeof view.terminal !== "object" ||
        view.terminal === null ||
        !("status" in view.terminal) ||
        view.terminal.status !== "running" ||
        !("id" in view.terminal) ||
        typeof view.terminal.id !== "string" ||
        view.terminal.id.length === 0 ||
        view.terminal.id.length > 256
      )
        return;
      prefetchTerminalSocket(
        buildTerminalWebSocketUrl({
          terminalId: view.terminal.id,
          handoffOwnerToken: ensureDeviceHandoffId(),
        }),
      );
      const warmPanel = () =>
        void loadNativeTerminalPanel().catch(() => undefined);
      if (document.readyState === "loading")
        document.addEventListener("DOMContentLoaded", warmPanel, {
          once: true,
        });
      else warmPanel();
      void import("@/components/thread/terminal/terminal-modules")
        .then(({ preloadTerminalModules }) => preloadTerminalModules())
        .catch(() => undefined);
      void import("@/views/thread-detail/LazyThreadDetailView")
        .then(({ LazyThreadDetailView }) => LazyThreadDetailView.preload())
        .catch(() => undefined);
    })
    .catch(() => undefined);
}
