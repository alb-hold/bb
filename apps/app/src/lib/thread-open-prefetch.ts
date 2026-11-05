import { appQueryClient } from "./app-query-client";
import { threadDetailBootstrapQueryOptions } from "@/hooks/queries/thread-queries";
import { nativeTerminalThreadQueryKey } from "@/hooks/queries/query-keys";
import { sdk } from "./sdk";

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
        const terminalId =
          view.terminal?.status === "running" ? view.terminal.id : null;
        if (terminalId)
          void import("@/components/thread/terminal/terminal-screen-prefetch")
            .then(({ prefetchTerminalScreen }) =>
              prefetchTerminalScreen(terminalId, threadId),
            )
            .catch(() => undefined);
        void import("@/components/thread/terminal/native-terminal-panel-preload")
          .then(({ preloadNativeTerminalPanel }) =>
            preloadNativeTerminalPanel(),
          )
          .catch(() => undefined);
        void import("@/components/thread/terminal/terminal-modules")
          .then(({ preloadTerminalModules }) => preloadTerminalModules())
          .catch(() => undefined);
      }
      return view;
    },
  });
}
