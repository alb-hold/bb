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
  void appQueryClient.prefetchQuery({
    queryKey: nativeTerminalThreadQueryKey(threadId),
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const view = await sdk.nativeTerminals.get({ threadId, signal });
      if (view !== null) {
        if (view.terminal?.status === "running")
          prefetchTerminalScreen(view.terminal.id, threadId);
        void LazyThreadTerminalPanel.preload();
        preloadTerminalModules();
      }
      return view;
    },
  });
}
