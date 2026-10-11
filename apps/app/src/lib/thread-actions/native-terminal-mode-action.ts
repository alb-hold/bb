import { useMemo } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import type {
  NativeTerminalMode,
  NativeTerminalThread,
} from "@bb/server-contract";
import type {
  PluginThreadAction,
  PluginThreadActionDataInput,
  PluginThreadActionItemInput,
} from "@get-bb/plugin-sdk";
import { appToast } from "@/components/ui/app-toast";
import { applyNativeTerminalModeSwitch } from "@/hooks/cache-owners/terminal-cache-owner";
import { nativeTerminalThreadQueryKey } from "@/hooks/queries/query-keys";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { showMutationErrorToast } from "@/lib/mutation-errors";
import {
  lookupCachedThread,
  useThreadEntryMap,
} from "@/lib/plugin-sidebar-hooks";
import { sdk } from "@/lib/sdk";

export interface NativeTerminalModeData {
  providerIdOf: (threadId: string) => string | null;
  isNativeProvider: (providerId: string) => boolean;
  isInTerminal: (threadId: string) => boolean;
  switchMode: (threadId: string, mode: NativeTerminalMode) => Promise<void>;
}

export function useNativeTerminalModeData({
  threadIds,
}: PluginThreadActionDataInput): NativeTerminalModeData {
  const queryClient = useQueryClient();
  const entries = useThreadEntryMap();
  const providers = useSystemProviders().data;
  const views = useQueries({
    queries: threadIds.map((threadId) => ({
      queryKey: nativeTerminalThreadQueryKey(threadId),
      queryFn: () => sdk.nativeTerminals.get({ threadId }),
      enabled: false,
    })),
    combine: (results) =>
      results.map(
        (result) => result.data as NativeTerminalThread | null | undefined,
      ),
  });
  const terminalThreadIdsKey = threadIds
    .filter((_, index) => (views[index] ?? null) !== null)
    .join("\n");
  const nativeProvidersKey = (providers ?? [])
    .filter((provider) => provider.capabilities.supportsNativeTerminal === true)
    .map((provider) => provider.id)
    .join("\n");
  return useMemo(() => {
    const terminalThreadIds = new Set(
      terminalThreadIdsKey === "" ? [] : terminalThreadIdsKey.split("\n"),
    );
    const nativeProviders = new Set(
      nativeProvidersKey === "" ? [] : nativeProvidersKey.split("\n"),
    );
    return {
      providerIdOf: (threadId) =>
        (entries.get(threadId) ?? lookupCachedThread(queryClient, threadId))
          ?.providerId ?? null,
      isNativeProvider: (providerId) => nativeProviders.has(providerId),
      isInTerminal: (threadId) => terminalThreadIds.has(threadId),
      switchMode: async (threadId, mode) => {
        const view = await sdk.nativeTerminals.switchMode({ threadId, mode });
        await applyNativeTerminalModeSwitch({ queryClient, threadId, view });
      },
    };
  }, [entries, nativeProvidersKey, queryClient, terminalThreadIdsKey]);
}

export function nativeTerminalModeItem({
  thread,
  data,
  navigate,
}: PluginThreadActionItemInput<NativeTerminalModeData>): PluginThreadAction | null {
  if (thread.archivedAt !== null) return null;
  if (data.isInTerminal(thread.id)) {
    return {
      label: "Back to chat",
      icon: "MessageSquare",
      run: async () => {
        try {
          await data.switchMode(thread.id, "chat");
          appToast.success("Thread is back in chat");
        } catch (error) {
          showMutationErrorToast({
            error,
            fallbackMessage: "Thread could not return to chat.",
          });
        }
      },
    };
  }
  const providerId = data.providerIdOf(thread.id);
  if (
    providerId === null ||
    !data.isNativeProvider(providerId) ||
    thread.environment === null ||
    thread.status === "pending"
  ) {
    return null;
  }
  const running = thread.status === "starting" || thread.status === "active";
  return {
    label: "Open in terminal",
    icon: "Terminal",
    ...(running ? { detail: "Stops the running turn first" } : {}),
    run: async () => {
      try {
        await data.switchMode(thread.id, "terminal");
        navigate.toThread(thread.id);
      } catch (error) {
        showMutationErrorToast({
          error,
          fallbackMessage: "Thread could not open in its terminal.",
        });
      }
    },
  };
}
