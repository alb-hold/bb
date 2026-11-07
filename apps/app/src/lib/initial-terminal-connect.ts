import { markTerminalPerformance } from "./terminal-performance";
import { nativeTerminalThreadSchema } from "@bb/server-contract";
import { prefetchTerminalSocket } from "@/components/thread/terminal/terminal-socket-prefetch";
import { buildTerminalWebSocketUrl } from "@/components/thread/terminal/terminal-websocket-url";
import { ensureDeviceHandoffId } from "./device-handoff-identity";
import "./initial-native-terminal-request";

markTerminalPerformance("terminal-initial-connector-ready");
const initial = globalThis.__bbInitialNativeTerminalRequest;
if (initial) {
  void initial.response
    .then(async (response) => {
      if (!response.ok) return;
      const view = nativeTerminalThreadSchema
        .nullable()
        .parse(await response.clone().json());
      const match = /^(?:\/projects\/[^/]+)?\/threads\/([^/]+)\/?$/.exec(
        location.pathname,
      );
      if (
        !view ||
        !match ||
        decodeURIComponent(match[1]!) !== view.threadId ||
        view.terminal?.status !== "running"
      )
        return;
      prefetchTerminalSocket(
        buildTerminalWebSocketUrl({
          terminalId: view.terminal.id,
          handoffOwnerToken: ensureDeviceHandoffId(),
        }),
      );
    })
    .catch(() => undefined);
}
