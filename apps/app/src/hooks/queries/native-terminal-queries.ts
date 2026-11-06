import { markTerminalPerformance } from "@/lib/terminal-performance";
import { useEffect } from "react";
import {
  prefetchTerminalSocket,
  discardPrefetchedTerminalSocket,
} from "@/components/thread/terminal/terminal-socket-prefetch";
import { buildTerminalWebSocketUrl } from "@/components/thread/terminal/terminal-websocket-url";
import { wsManager } from "@/lib/ws";
import { prefetchTerminalScreen } from "@/components/thread/terminal/terminal-screen-prefetch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PromptInput } from "@bb/domain";
import type { NativeTerminalThread } from "@bb/server-contract";
import { LazyThreadTerminalPanel } from "@/components/secondary-panel/lazySecondaryPanelComponents";
import { preloadTerminalModules } from "@/components/thread/terminal/terminal-modules";
import { sdk } from "@/lib/sdk";
import { applyNativeTerminalThreadView } from "../cache-owners/terminal-cache-owner";
import { REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY } from "./query-policies";
import { nativeTerminalThreadQueryKey } from "./query-keys";

export function useNativeTerminalThread(threadId: string) {
  const query = useQuery<NativeTerminalThread | null>({
    queryKey: nativeTerminalThreadQueryKey(threadId),
    queryFn: async ({ signal }) => {
      markTerminalPerformance("terminal-native-metadata-requested");
      const view = await sdk.nativeTerminals.get({ threadId, signal });
      markTerminalPerformance("terminal-native-metadata-received");
      if (view !== null) {
        if (view.terminal?.status === "running")
          prefetchTerminalScreen(view.terminal.id, threadId);
        void LazyThreadTerminalPanel.preload();
        preloadTerminalModules();
      }
      return view;
    },
    enabled: threadId.length > 0,
    ...REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY,
  });
  const terminalId =
    query.data?.terminal?.status === "running" ? query.data.terminal.id : null;
  useEffect(() => {
    if (terminalId === null) return;
    const url = buildTerminalWebSocketUrl({
      terminalId,
      handoffOwnerToken: wsManager.getDeviceHandoffClientToken(),
    });
    prefetchTerminalSocket(url);
    return () => discardPrefetchedTerminalSocket(url);
  }, [terminalId]);
  return query;
}

interface OpenNativeTerminalArgs {
  cols?: number;
  rows?: number;
  threadId: string;
}

interface SendNativeTerminalMessageArgs {
  input: PromptInput[];
  threadId: string;
}

export function useSendNativeTerminalMessage() {
  return useMutation({
    meta: {
      errorMessage: "Failed to send to the native session.",
      lifecycleOperation: "send_message",
    },
    mutationFn: ({ input, threadId }: SendNativeTerminalMessageArgs) =>
      sdk.threads.send({ threadId, input, mode: "auto" }),
  });
}

export function useOpenNativeTerminal() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: {
      errorMessage: "Failed to open the native session.",
      lifecycleOperation: "open_terminal",
    },
    mutationFn: (args: OpenNativeTerminalArgs) =>
      sdk.nativeTerminals.open(args),
    onSuccess: (view: NativeTerminalThread) => {
      applyNativeTerminalThreadView({ queryClient, view });
    },
  });
}
