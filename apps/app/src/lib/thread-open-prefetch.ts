import { markTerminalPerformance } from "@/lib/terminal-performance";
import type { NativeTerminalThread } from "@bb/server-contract";
import { prefetchTerminalSocket } from "@/components/thread/terminal/terminal-socket-prefetch";
import { buildTerminalWebSocketUrl } from "@/components/thread/terminal/terminal-websocket-url";
import { wsManager } from "./ws";
import { prefetchTerminalScreen } from "@/components/thread/terminal/terminal-screen-prefetch";
import { appQueryClient } from "./app-query-client";
import {
  threadDetailBootstrapQueryOptions,
  threadQueryOptions,
} from "@/hooks/queries/thread-queries";
import { nativeTerminalThreadQueryKey } from "@/hooks/queries/query-keys";
import { sdk } from "./sdk";
import { LazyThreadTerminalPanel } from "@/components/secondary-panel/lazySecondaryPanelComponents";
import { loadNativeTerminalPanel } from "@/components/thread/terminal/native-terminal-panel-loader";
import { preloadTerminalModules } from "@/components/thread/terminal/terminal-modules";

function prefetchCurrentNativeTerminalSocket(threadId: string): void {
  if (
    typeof window === "undefined" ||
    window.location.pathname.match(
      /^\/(?:projects\/[^/]+\/)?threads\/([^/]+)\/?$/,
    )?.[1] !== threadId
  )
    return;
  const view = appQueryClient.getQueryData<NativeTerminalThread | null>(
    nativeTerminalThreadQueryKey(threadId),
  );
  if (view === undefined || view === null) return;
  void loadNativeTerminalPanel().catch(() => undefined);
  preloadTerminalModules();
  if (view.terminal?.status !== "running") return;
  void appQueryClient.prefetchQuery(
    threadQueryOptions(appQueryClient, threadId),
  );
  prefetchTerminalSocket(
    buildTerminalWebSocketUrl({
      terminalId: view.terminal.id,
      handoffOwnerToken: wsManager.getDeviceHandoffClientToken(),
    }),
  );
}

export function prefetchThreadOpen(threadId: string): void {
  prefetchCurrentNativeTerminalSocket(threadId);
  void appQueryClient.prefetchQuery(
    threadDetailBootstrapQueryOptions(appQueryClient, threadId, {
      timelinePrefetch: true,
    }),
  );
  void appQueryClient
    .prefetchQuery({
      queryKey: nativeTerminalThreadQueryKey(threadId),
      staleTime: Infinity,
      queryFn: async ({ signal }) => {
        markTerminalPerformance("terminal-native-metadata-requested");
        const view = await sdk.nativeTerminals.get({ threadId, signal });
        markTerminalPerformance("terminal-native-metadata-received");
        if (view !== null) {
          if (view.terminal?.status === "running")
            prefetchTerminalScreen(view.terminal.id, threadId);
          void loadNativeTerminalPanel().catch(() => undefined);
          void LazyThreadTerminalPanel.preload();
          preloadTerminalModules();
        }
        return view;
      },
    })
    .then(() => {
      prefetchCurrentNativeTerminalSocket(threadId);
    });
}
