import {
  clearSidebarPreview,
  publishSidebarPreview,
  sidebarNavigationPreviewQueryKey,
} from "../cache-owners/sidebar-preview-cache";
import {
  hashKey,
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { PERSONAL_PROJECT_ID, type ThreadListEntry } from "@bb/domain";
import {
  mergeSidebarBootstrapPages,
  type SidebarBootstrapResponse,
} from "@bb/server-contract";
import { listSidebarNavigationThreads } from "@/hooks/cache-owners/query-cache";
import { apiClient } from "@/lib/api-server";
import { request, requestOptions } from "@/lib/api";
import {
  useEnvironmentListRealtimeSubscription,
  useHostListRealtimeSubscription,
  useProjectListRealtimeSubscription,
  useThreadListRealtimeSubscription,
} from "@/hooks/useRealtimeSubscription";
import type { QueryOptions } from "./query-helpers";
import {
  sidebarNavigationPagesQueryKey,
  sidebarNavigationQueryKey,
} from "./query-keys";
import { REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY } from "./query-policies";
import {
  readCachedSidebarBootstrap,
  writeCachedSidebarBootstrap,
} from "@/lib/sidebar-bootstrap-cache";

const SIDEBAR_PAGE_SIZE = 25;

interface SidebarNavigationPage {
  response: SidebarBootstrapResponse;
  nextCursor: string | undefined;
}

type SidebarNavigationPagesData = InfiniteData<
  SidebarNavigationPage,
  string | undefined
>;

export interface SidebarNavigationPagingState {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => Promise<void>;
}

const syncedSidebarClients = new WeakSet<QueryClient>();

function mergeSidebarNavigationPages(
  pages: readonly SidebarNavigationPage[],
): {
  snapshot: SidebarBootstrapResponse;
  complete: boolean;
} | null {
  if (pages.length === 0) return null;
  let snapshot: SidebarBootstrapResponse | undefined;
  let overview: SidebarBootstrapResponse["overview"];
  for (const page of pages) {
    overview ??= page.response.overview;
    snapshot = mergeSidebarBootstrapPages(snapshot, page.response);
  }
  if (!snapshot) return null;
  const lastPage = pages[pages.length - 1];
  if (!lastPage) return null;
  const complete = lastPage.nextCursor === undefined;
  return {
    snapshot:
      !complete && overview !== undefined
        ? { ...snapshot, overview }
        : snapshot,
    complete,
  };
}

function syncSidebarNavigationPagesCache(client: QueryClient): void {
  if (syncedSidebarClients.has(client)) return;
  syncedSidebarClients.add(client);
  const pagesHash = hashKey(sidebarNavigationPagesQueryKey());
  client.getQueryCache().subscribe((event) => {
    if (
      event.type !== "updated" ||
      event.action.type !== "success" ||
      event.query.queryHash !== pagesHash
    ) {
      return;
    }
    const data = client.getQueryData<SidebarNavigationPagesData>(
      sidebarNavigationPagesQueryKey(),
    );
    if (!data) return;
    const merged = mergeSidebarNavigationPages(data.pages);
    if (!merged) return;
    if (merged.complete) {
      writeCachedSidebarBootstrap(merged.snapshot);
      client.setQueryData<SidebarBootstrapResponse>(
        sidebarNavigationQueryKey(),
        merged.snapshot,
      );
      clearSidebarPreview(client);
    } else {
      publishSidebarPreview(client, merged.snapshot);
      if (client.getQueryData(sidebarNavigationQueryKey()) !== undefined) {
        void client.resetQueries({
          queryKey: sidebarNavigationQueryKey(),
          exact: true,
        });
      }
    }
  });
}

async function fetchSidebarNavigationPage({
  client,
  pageParam,
  signal,
}: {
  client: QueryClient;
  pageParam: string | undefined;
  signal: AbortSignal;
}): Promise<SidebarNavigationPage> {
  let nextCursor: string | undefined;
  const response = await request<SidebarBootstrapResponse>(
    apiClient["sidebar-bootstrap"].$get(
      {
        query: {
          limit: String(SIDEBAR_PAGE_SIZE),
          cursor: pageParam,
          overview: pageParam === undefined ? "true" : undefined,
        },
      },
      requestOptions(signal),
    ),
    (httpResponse) => {
      nextCursor = httpResponse.headers.get("X-BB-Next-Cursor") ?? undefined;
    },
  );
  signal.throwIfAborted();
  if (nextCursor !== undefined) {
    const existing = client.getQueryData<SidebarNavigationPagesData>(
      sidebarNavigationPagesQueryKey(),
    );
    if (
      nextCursor === pageParam ||
      (pageParam !== undefined && existing?.pageParams.includes(nextCursor))
    ) {
      throw new Error("Sidebar returned a repeated continuation");
    }
  }
  return { response, nextCursor };
}

function sidebarNavigationPagesQueryOptions(options?: { enabled?: boolean }) {
  return infiniteQueryOptions<
    SidebarNavigationPage,
    Error,
    SidebarNavigationPagesData,
    ReturnType<typeof sidebarNavigationPagesQueryKey>,
    string | undefined
  >({
    queryKey: sidebarNavigationPagesQueryKey(),
    queryFn: ({ client, pageParam, signal }) =>
      fetchSidebarNavigationPage({ client, pageParam, signal }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: options?.enabled ?? true,
    ...REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY,
  });
}

export function useSidebarNavigationPreview() {
  return useQuery<SidebarBootstrapResponse | null>({
    queryKey: sidebarNavigationPreviewQueryKey(),
    enabled: false,
    staleTime: Infinity,
  }).data;
}

export async function fetchSidebarNavigation({
  client,
  signal,
}: {
  client: QueryClient;
  signal: AbortSignal;
}): Promise<SidebarBootstrapResponse> {
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let preview: SidebarBootstrapResponse | undefined;
  try {
    for (;;) {
      const page = await fetchSidebarNavigationPage({
        client,
        pageParam: cursor,
        signal,
      });
      const snapshot = mergeSidebarBootstrapPages(preview, page.response);
      if (!page.nextCursor) {
        writeCachedSidebarBootstrap(snapshot);
        return snapshot;
      }
      if (seenCursors.has(page.nextCursor)) {
        throw new Error("Sidebar returned a repeated continuation");
      }
      seenCursors.add(page.nextCursor);
      preview = publishSidebarPreview(client, {
        ...snapshot,
        overview: preview?.overview ?? page.response.overview,
      });
      cursor = page.nextCursor;
    }
  } finally {
    if (preview) clearSidebarPreview(client, preview);
  }
}

export function useSidebarNavigation(options?: QueryOptions) {
  const enabled = options?.enabled ?? true;
  const queryClient = useQueryClient();
  syncSidebarNavigationPagesCache(queryClient);
  useEnvironmentListRealtimeSubscription({ enabled });
  useHostListRealtimeSubscription({ enabled });
  useProjectListRealtimeSubscription({ enabled });
  useThreadListRealtimeSubscription({ enabled });

  const completeQuery = useQuery<SidebarBootstrapResponse>({
    queryKey: sidebarNavigationQueryKey(),
    queryFn: fetchSidebarNavigation,
    enabled: false,
    ...REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY,
    placeholderData: () => readCachedSidebarBootstrap() ?? undefined,
  });
  const hasSeededComplete =
    completeQuery.data !== undefined &&
    !completeQuery.isPlaceholderData &&
    !completeQuery.isStale &&
    queryClient.getQueryData(sidebarNavigationPagesQueryKey()) === undefined;
  const pagesQuery = useInfiniteQuery(
    sidebarNavigationPagesQueryOptions({
      enabled: enabled && !hasSeededComplete,
    }),
  );

  if (completeQuery.data !== undefined) {
    return completeQuery;
  }
  if (pagesQuery.isError) {
    return {
      ...completeQuery,
      error: pagesQuery.error,
      isError: true,
      isPending: false,
      isLoading: false,
      status: "error" as const,
    };
  }
  return completeQuery;
}

export function useSidebarNavigationPaging(
  options?: QueryOptions,
): SidebarNavigationPagingState {
  const enabled = options?.enabled ?? true;
  const queryClient = useQueryClient();
  syncSidebarNavigationPagesCache(queryClient);
  const completeQuery = useQuery<SidebarBootstrapResponse>({
    queryKey: sidebarNavigationQueryKey(),
    queryFn: fetchSidebarNavigation,
    enabled: false,
    ...REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY,
  });
  const hasSeededComplete =
    completeQuery.data !== undefined &&
    !completeQuery.isStale &&
    queryClient.getQueryData(sidebarNavigationPagesQueryKey()) === undefined;
  const pagesQuery = useInfiniteQuery(
    sidebarNavigationPagesQueryOptions({
      enabled: enabled && !hasSeededComplete,
    }),
  );
  const fetchNext = pagesQuery.fetchNextPage;
  const fetchNextPage = useCallback(async () => {
    await fetchNext({ cancelRefetch: false });
  }, [fetchNext]);
  return useMemo(
    () => ({
      hasNextPage: pagesQuery.hasNextPage,
      isFetchingNextPage: pagesQuery.isFetchingNextPage,
      isFetchNextPageError: pagesQuery.isFetchNextPageError,
      fetchNextPage,
    }),
    [
      pagesQuery.hasNextPage,
      pagesQuery.isFetchingNextPage,
      pagesQuery.isFetchNextPageError,
      fetchNextPage,
    ],
  );
}

export function useProjectDisplayName(
  projectId: string | undefined,
): string | undefined {
  const { data, isPlaceholderData } = useSidebarNavigation({
    enabled: Boolean(projectId),
  });
  const preview = useSidebarNavigationPreview();
  const navigation = isPlaceholderData ? (preview ?? data) : (data ?? preview);
  if (!navigation || !projectId) {
    return undefined;
  }
  if (projectId === PERSONAL_PROJECT_ID) {
    return navigation.personalProject.name;
  }
  return navigation.projects.find((project) => project.id === projectId)?.name;
}

export interface SidebarNavigationThreadSelection<T> {
  data: T | undefined;
  isBootstrapPending: boolean;
}

export function sidebarNavigationThreadSelectionQueryOptions<T>(
  selectFromNavigation: (navigation: SidebarBootstrapResponse) => T,
) {
  return queryOptions<SidebarBootstrapResponse, Error, T>({
    queryKey: sidebarNavigationQueryKey(),
    queryFn: fetchSidebarNavigation,
    ...REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY,
    enabled: false,
    select: selectFromNavigation,
  });
}

export function toSidebarNavigationThreadSelection<T>(result: {
  data: T | undefined;
  isFetching: boolean;
}): SidebarNavigationThreadSelection<T> {
  const data = result.data;
  return {
    data,
    isBootstrapPending: data === undefined && result.isFetching,
  };
}

export function useSidebarNavigationThreadSelection<T>(
  select: (threads: ThreadListEntry[]) => T,
): SidebarNavigationThreadSelection<T> {
  const selectFromNavigation = useCallback(
    (navigation: SidebarBootstrapResponse) =>
      select(listSidebarNavigationThreads(navigation)),
    [select],
  );
  return toSidebarNavigationThreadSelection(
    useQuery(
      sidebarNavigationThreadSelectionQueryOptions(selectFromNavigation),
    ),
  );
}
