// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  sidebarBootstrapResponseSchema,
  type SidebarBootstrapResponse,
} from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "@/lib/api";
import {
  MAX_CACHED_SIDEBAR_THREADS_PER_PROJECT,
  SIDEBAR_BOOTSTRAP_CACHE_KEY,
  resetSidebarBootstrapCacheForTest,
} from "@/lib/sidebar-bootstrap-cache";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { apiClient } from "@/lib/api-server";
import { sidebarNavigationPagesQueryKey } from "./query-keys";
import {
  useSidebarNavigation,
  useSidebarNavigationPaging,
} from "./sidebar-navigation-query";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, request: vi.fn() };
});

vi.mock("@/lib/api-server", () => ({
  apiClient: { "sidebar-bootstrap": { $get: vi.fn(() => ({})) } },
  fetchWithDeviceHandoffSubmission: vi.fn(),
}));

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useEnvironmentListRealtimeSubscription: vi.fn(),
  useHostListRealtimeSubscription: vi.fn(),
  useProjectListRealtimeSubscription: vi.fn(),
  useThreadListRealtimeSubscription: vi.fn(),
}));

const PERSONAL_PROJECT: SidebarBootstrapResponse["personalProject"] =
  makeProjectWithThreadsResponse({
    id: "proj_personal",
    kind: "personal",
    name: "Personal",
    createdAt: 1,
    updatedAt: 1,
  });

const BOOTSTRAP: SidebarBootstrapResponse = makeSidebarBootstrapResponse({
  projects: [
    makeProjectWithThreadsResponse({
      id: "proj_felt",
      kind: "standard",
      name: "Felt walk",
      createdAt: 1,
      updatedAt: 1,
    }),
  ],
  personalProject: PERSONAL_PROJECT,
});

const pendingForever = () => new Promise<never>(() => {});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
  resetSidebarBootstrapCacheForTest();
});

function mockCursorChain(next: Record<string, string | undefined>): void {
  vi.mocked(apiClient["sidebar-bootstrap"].$get).mockImplementation(
    ((args: { query: { cursor?: string } }) => ({
      cursor: args.query.cursor,
    })) as never,
  );
  vi.mocked(request).mockImplementation((async (
    pending: { cursor?: string },
    onResponse?: (response: Response) => void,
  ) => {
    const cursor = next[pending.cursor ?? "start"];
    onResponse?.(
      new Response(null, {
        headers: cursor ? { "X-BB-Next-Cursor": cursor } : {},
      }),
    );
    return BOOTSTRAP;
  }) as never);
}

describe("useSidebarNavigation", () => {
  it("refetches a three-page chain without a repeated-continuation error", async () => {
    mockCursorChain({ start: "c1", c1: "c2", c2: undefined });
    const harness = createQueryClientTestHarness();
    const { result } = renderHook(
      () => ({
        nav: useSidebarNavigation(),
        paging: useSidebarNavigationPaging(),
      }),
      { wrapper: harness.wrapper },
    );
    await waitFor(() => expect(result.current.paging.hasNextPage).toBe(true));
    await act(() => result.current.paging.fetchNextPage());
    await waitFor(() => expect(result.current.paging.hasNextPage).toBe(true));
    await act(() => result.current.paging.fetchNextPage());
    await waitFor(() => expect(result.current.paging.hasNextPage).toBe(false));
    await act(async () => {
      await harness.queryClient.refetchQueries({
        queryKey: sidebarNavigationPagesQueryKey(),
      });
    });
    expect(result.current.nav.isError).toBe(false);
    expect(
      harness.queryClient.getQueryState(sidebarNavigationPagesQueryKey())
        ?.status,
    ).toBe("success");
  });

  it("still rejects a continuation loop", async () => {
    mockCursorChain({ start: "c1", c1: "c2", c2: "c1" });
    const harness = createQueryClientTestHarness();
    const { result } = renderHook(() => useSidebarNavigationPaging(), {
      wrapper: harness.wrapper,
    });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(() => result.current.fetchNextPage());
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.isFetchNextPageError).toBe(true));
  });

  it("recovers from a transient page failure through query retry", async () => {
    let calls = 0;
    vi.mocked(request).mockImplementation((async () => {
      calls += 1;
      if (calls === 1) throw new Error("network timeout");
      return BOOTSTRAP;
    }) as never);
    const harness = createQueryClientTestHarness({ queries: { retry: undefined } });
    const { result } = renderHook(() => useSidebarNavigation(), {
      wrapper: harness.wrapper,
    });
    await waitFor(() => expect(result.current.data).toEqual(BOOTSTRAP), {
      timeout: 5_000,
    });
    expect(result.current.isError).toBe(false);
  });

  it("replays the last bootstrap while the live one loads", async () => {
    sidebarBootstrapResponseSchema.parse(BOOTSTRAP);

    vi.mocked(request).mockResolvedValue(BOOTSTRAP);
    const warmHarness = createQueryClientTestHarness();
    const warm = renderHook(() => useSidebarNavigation(), {
      wrapper: warmHarness.wrapper,
    });
    await waitFor(() => expect(warm.result.current.data).toEqual(BOOTSTRAP));
    warm.unmount();

    vi.mocked(request).mockImplementation(pendingForever);
    const reloadHarness = createQueryClientTestHarness();
    const { result } = renderHook(() => useSidebarNavigation(), {
      wrapper: reloadHarness.wrapper,
    });
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data?.projects[0]?.name).toBe("Felt walk");
    await waitFor(() => expect(request).toHaveBeenCalled());
  });

  it("keeps the cold-profile skeleton: no placeholder without a stored bootstrap", () => {
    vi.mocked(request).mockImplementation(pendingForever);
    const harness = createQueryClientTestHarness();
    const { result } = renderHook(() => useSidebarNavigation(), {
      wrapper: harness.wrapper,
    });
    expect(result.current.data).toBeUndefined();
    expect(result.current.isPlaceholderData).toBe(false);
    expect(result.current.isPending).toBe(true);
  });

  it("stores a bounded copy off the critical path and replays it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const manyThreads = Array.from(
        { length: MAX_CACHED_SIDEBAR_THREADS_PER_PROJECT + 20 },
        (_, index) =>
          makeThreadListEntry({ id: `thr_${index}`, projectId: "proj_felt" }),
      );
      const large: SidebarBootstrapResponse = {
        ...BOOTSTRAP,
        projects: [{ ...BOOTSTRAP.projects[0]!, threads: manyThreads }],
        personalProject: { ...PERSONAL_PROJECT, threads: manyThreads },
      };
      sidebarBootstrapResponseSchema.parse(large);

      vi.mocked(request).mockResolvedValue(large);
      const warmHarness = createQueryClientTestHarness();
      const warm = renderHook(() => useSidebarNavigation(), {
        wrapper: warmHarness.wrapper,
      });
      await waitFor(() => expect(warm.result.current.data).toEqual(large));
      expect(
        window.localStorage.getItem(SIDEBAR_BOOTSTRAP_CACHE_KEY),
      ).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      const stored = sidebarBootstrapResponseSchema.parse(
        JSON.parse(window.localStorage.getItem(SIDEBAR_BOOTSTRAP_CACHE_KEY)!),
      );
      expect(stored.projects[0]!.threads).toHaveLength(
        MAX_CACHED_SIDEBAR_THREADS_PER_PROJECT,
      );
      expect(stored.projects[0]!.threads[0]!.id).toBe("thr_0");
      expect(stored.personalProject.threads).toHaveLength(
        MAX_CACHED_SIDEBAR_THREADS_PER_PROJECT,
      );
      warm.unmount();

      resetSidebarBootstrapCacheForTest();
      vi.mocked(request).mockImplementation(pendingForever);
      const reloadHarness = createQueryClientTestHarness();
      const { result } = renderHook(() => useSidebarNavigation(), {
        wrapper: reloadHarness.wrapper,
      });
      expect(result.current.isPlaceholderData).toBe(true);
      expect(result.current.data?.projects[0]?.threads).toHaveLength(
        MAX_CACHED_SIDEBAR_THREADS_PER_PROJECT,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
