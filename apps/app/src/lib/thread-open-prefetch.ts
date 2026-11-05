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
        void import("@/components/thread/terminal/native-terminal-warmup")
          .then(({ warmNativeTerminal }) =>
            warmNativeTerminal(terminalId, threadId),
          )
          .catch(() => undefined);
      }
      return view;
    },
  });
}
