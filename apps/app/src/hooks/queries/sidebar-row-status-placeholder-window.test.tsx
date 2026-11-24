// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { SidebarBootstrapResponse } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { request } from "@/lib/api";
import { apiClient } from "@/lib/api-server";
import {
  resetSidebarBootstrapCacheForTest,
  writeCachedSidebarBootstrap,
} from "@/lib/sidebar-bootstrap-cache";
import { useSidebarThreads } from "@/lib/plugin-sidebar-hooks";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { createRealtimeCacheEffects } from "@/hooks/realtime-cache-effects";
import { hashKey } from "@tanstack/react-query";
import {
  sidebarNavigationPagesQueryKey,
  sidebarNavigationQueryKey,
} from "./query-keys";

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

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: [] }),
}));

vi.mock("@/components/thread/ThreadActionsProvider", () => ({
  useThreadActions: () => ({
    requestArchive: vi.fn(),
    requestDelete: vi.fn(),
    togglePin: vi.fn(),
    toggleRead: vi.fn(),
  }),
}));

vi.mock("@/hooks/mutations/thread-state-mutations", () => ({
  usePinThread: () => ({ mutateAsync: vi.fn() }),
  useUnpinThread: () => ({ mutateAsync: vi.fn() }),
  useUpdateThread: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/components/ui/app-route-anchor", () => ({
  useRouteNavigate: () => vi.fn(),
}));

vi.mock("@bb/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => false,
}));

vi.mock("@/lib/root-compose-selection", () => ({
  useSetRootComposeProjectId: () => vi.fn(),
}));

vi.mock("@/hooks/queries/environment-provider-queries", () => ({
  useSystemEnvironmentProviders: () => ({ providers: undefined }),
}));

vi.mock("@/hooks/useQuickCreateProject", () => ({
  useQuickCreateProject: () => ({
    isAvailable: true,
    isCreating: false,
    openCreateDialog: vi.fn(),
  }),
  useQuickCreateProjectController: () => ({
    isAvailable: true,
    isCreating: false,
    openCreateDialog: vi.fn(),
  }),
}));

vi.mock("@/hooks/usePromptDraftStorage", () => ({
  usePromptDraftHasInput: () => false,
  usePromptDraftInputThreadIds: () => new Set<string>(),
}));

const THREAD_ID = "thr_working_row";

function snapshotWith(
  status: "idle" | "active",
  updatedAt: number,
): SidebarBootstrapResponse {
  const thread = makeThreadListEntry({
    id: THREAD_ID,
    projectId: "proj_app",
    status,
    updatedAt,
    runtime: { displayStatus: status },
  });
  return makeSidebarBootstrapResponse({
    projects: [
      makeProjectWithThreadsResponse({
        id: "proj_app",
        name: "App",
        threads: [thread],
      }),
    ],
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
  resetSidebarBootstrapCacheForTest();
});

describe("sidebar row status across the complete-query reset", () => {
  it("keeps a working row working while a partial pages refetch resets the complete query", async () => {
    const stale = snapshotWith("idle", 1_000);
    const live = snapshotWith("active", 2_000);
    let phase: "complete" | "partial" = "complete";
    vi.mocked(request).mockImplementation((async (
      _pending: unknown,
      onResponse?: (response: Response) => void,
    ) => {
      const isPartial = phase === "partial";
      onResponse?.(
        new Response(null, {
          headers: isPartial ? { "X-BB-Next-Cursor": "c1" } : {},
        }),
      );
      return isPartial ? live : stale;
    }) as never);
    vi.mocked(apiClient["sidebar-bootstrap"].$get).mockImplementation(
      (() => ({})) as never,
    );

    const harness = createQueryClientTestHarness();
    const effects = createRealtimeCacheEffects({
      queryClient: harness.queryClient,
    });
    const observed: Array<string | undefined> = [];
    const { result } = renderHook(
      () => {
        const state = useSidebarThreads();
        const row = state.threads.find((thread) => thread.id === THREAD_ID);
        observed.push(row?.runtimeStatus);
        return row;
      },
      { wrapper: harness.wrapper },
    );
    await waitFor(() => expect(result.current?.runtimeStatus).toBe("idle"));
    writeCachedSidebarBootstrap(stale);

    const activeRow = live.projects[0]!.threads[0]!;
    act(() => {
      effects.handleChanged({
        type: "changed",
        entity: "thread",
        id: THREAD_ID,
        changes: ["status-changed"],
        metadata: {
          statusChange: {
            status: "active",
            runtime: activeRow.runtime,
            activity: activeRow.activity,
            latestAttentionAt: activeRow.latestAttentionAt,
            updatedAt: 3_000,
          },
        },
      });
    });
    await waitFor(() => expect(result.current?.runtimeStatus).toBe("active"));

    const completeKey = sidebarNavigationQueryKey();
    const pagesKey = sidebarNavigationPagesQueryKey();
    expect(harness.queryClient.getQueryData(completeKey)).toBeDefined();
    expect(harness.queryClient.getQueryData(pagesKey)).toBeDefined();
    const completeEvents: string[] = [];
    const unsubscribe = harness.queryClient
      .getQueryCache()
      .subscribe((event) => {
        if (
          event.type === "updated" &&
          event.query.queryHash === hashKey(completeKey)
        ) {
          completeEvents.push(
            `${event.action.type}:${event.query.state.data === undefined ? "empty" : "data"}`,
          );
        }
      });

    phase = "partial";
    observed.length = 0;
    const requestsBefore = vi.mocked(request).mock.calls.length;
    await act(async () => {
      await harness.queryClient.refetchQueries({ queryKey: pagesKey });
    });
    expect(vi.mocked(request).mock.calls.length).toBeGreaterThan(
      requestsBefore,
    );
    const pagesAfter = harness.queryClient.getQueryData<{
      pages: Array<{ nextCursor?: string }>;
    }>(pagesKey);
    expect(pagesAfter?.pages.at(-1)?.nextCursor).toBe("c1");
    await waitFor(() =>
      expect(completeEvents.some((entry) => entry.endsWith(":empty"))).toBe(
        true,
      ),
    );
    await act(async () => {
      await harness.queryClient.refetchQueries({
        queryKey: completeKey,
        exact: true,
      });
    });
    unsubscribe();

    expect(observed.length).toBeGreaterThan(0);
    expect(new Set(observed)).toEqual(new Set(["active"]));
  });
});
