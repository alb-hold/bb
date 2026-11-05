// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupCachedThread as bootLookup } from "@/lib/cached-thread";
import {
  lookupCachedThread as pluginLookup,
  useThreadEntryMap,
} from "@/lib/plugin-sidebar-hooks";
import { useSidebarThreadEntries } from "@/lib/sidebar-thread-entries";
import { SidebarThreadEntriesTestProvider } from "@/test/sidebarThreadEntriesTestProvider";

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
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

afterEach(cleanup);

describe("native terminal mode reads match the plugin sidebar hooks", () => {
  it("reads cached threads through the same function", () => {
    expect(bootLookup).toBe(pluginLookup);
  });

  it("reads thread entries from the same source in a loading state", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SidebarThreadEntriesTestProvider>{children}</SidebarThreadEntriesTestProvider>
    );
    const { result } = renderHook(
      () => ({ boot: useSidebarThreadEntries(), plugin: useThreadEntryMap() }),
      { wrapper },
    );
    expect(result.current.plugin).toEqual(result.current.boot);
  });
});
