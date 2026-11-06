import type { NativeTerminalThread } from "@bb/server-contract";
import { prefetchTerminalSocket } from "@/components/thread/terminal/terminal-socket-prefetch";
import { buildTerminalWebSocketUrl } from "@/components/thread/terminal/terminal-websocket-url";
import { wsManager } from "./ws";
import { prefetchTerminalScreen } from "@/components/thread/terminal/terminal-screen-prefetch";
import { appQueryClient } from "./app-query-client";
import { threadDetailBootstrapQueryOptions } from "@/hooks/queries/thread-queries";
import { nativeTerminalThreadQueryKey } from "@/hooks/queries/query-keys";
import { sdk } from "./sdk";
import { LazyThreadTerminalPanel } from "@/components/secondary-panel/lazySecondaryPanelComponents";
import { preloadTerminalModules } from "@/components/thread/terminal/terminal-modules";

export function prefetchThreadOpen(threadId: string): void {
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
        performance.mark?.("terminal-native-metadata-requested");
        const view = await sdk.nativeTerminals.get({ threadId, signal });
        performance.mark?.("terminal-native-metadata-received");
        if (view !== null) {
          if (view.terminal?.status === "running")
            prefetchTerminalScreen(view.terminal.id, threadId);
          void LazyThreadTerminalPanel.preload();
          preloadTerminalModules();
        }
        return view;
      },
    })
    .then(() => {
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
      if (view?.terminal?.status !== "running") return;
      prefetchTerminalSocket(
        buildTerminalWebSocketUrl({
          terminalId: view.terminal.id,
          handoffOwnerToken: wsManager.getDeviceHandoffClientToken(),
        }),
      );
    });
}
