// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SidebarBootstrapResponse } from "@bb/server-contract";
import { sidebarNavigationQueryKey } from "@/hooks/queries/query-keys";
import { useNativeTerminalModeData } from "./native-terminal-mode-action";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupCachedThread as bootLookup } from "@/lib/cached-thread";
import {
  lookupCachedThread as pluginLookup,
  useThreadEntryMap,
} from "@/lib/plugin-sidebar-hooks";
import { useSidebarThreadEntries } from "@/lib/sidebar-thread-entries";
import { SidebarThreadEntriesTestProvider } from "@/test/sidebarThreadEntriesTestProvider";

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigationPreview: () => undefined,
  useSidebarNavigationPaging: () => ({
    hasNextPage: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    fetchNextPage: async () => undefined,
  }),
  useSidebarNavigation: () => ({ data: undefined, isError: false }),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useArchivedThreads: () => ({
    data: undefined,
    isLoadingError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    fetchNextPage: vi.fn(async () => undefined),
  }),
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemProviders: () => ({
    data: [{ id: "claude-code", capabilities: { supportsNativeTerminal: true } }],
  }),
}));

afterEach(cleanup);

describe("native terminal mode reads match the plugin sidebar hooks", () => {
  it("reads cached threads through the same function", () => {
    expect(bootLookup).toBe(pluginLookup);
  });

  it("reads thread entries from the same source in a loading state (test-change-reason: the upstream sidebar entry store reads the query client, so the hook needs a QueryClientProvider)", () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <SidebarThreadEntriesTestProvider>{children}</SidebarThreadEntriesTestProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () => ({ boot: useSidebarThreadEntries(), plugin: useThreadEntryMap() }),
      { wrapper },
    );
    expect(result.current.plugin).toEqual(result.current.boot);
  });

  it("updates the mode data when a listed thread entry arrives after mount", async () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useNativeTerminalModeData({ threadIds: ["thr_a"] }),
      { wrapper },
    );
    const before = result.current;
    expect(before.providerIdOf("thr_a")).toBeNull();
    const navigation = {
      projects: [{ threads: [{ id: "thr_a", providerId: "claude-code" }] }],
      personalProject: { threads: [] },
    } as unknown as SidebarBootstrapResponse;
    act(() => {
      queryClient.setQueryData(sidebarNavigationQueryKey(), navigation);
    });
    await waitFor(() => expect(result.current).not.toBe(before));
    expect(result.current.providerIdOf("thr_a")).toBe("claude-code");
  });
});
