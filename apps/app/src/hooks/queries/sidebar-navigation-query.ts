import {
  clearSidebarPreview,
  publishSidebarPreview,
  sidebarNavigationPreviewQueryKey,
} from "../cache-owners/sidebar-preview-cache";
import {
  queryOptions,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
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
import { sidebarNavigationQueryKey } from "./query-keys";
import { REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY } from "./query-policies";
import {
  readCachedSidebarBootstrap,
  writeCachedSidebarBootstrap,
} from "@/lib/sidebar-bootstrap-cache";

const SIDEBAR_PAGE_SIZE = 25;

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
      let next: string | undefined;
      const page = await request<SidebarBootstrapResponse>(
        apiClient["sidebar-bootstrap"].$get(
          { query: { limit: String(SIDEBAR_PAGE_SIZE), cursor } },
          requestOptions(signal),
        ),
        (response) => {
          next = response.headers.get("X-BB-Next-Cursor") ?? undefined;
        },
      );
      signal.throwIfAborted();
      const snapshot = mergeSidebarBootstrapPages(preview, page);
      if (!next) {
        writeCachedSidebarBootstrap(snapshot);
        return snapshot;
      }
      if (seenCursors.has(next))
        throw new Error("Sidebar returned a repeated continuation");
      seenCursors.add(next);
      preview = publishSidebarPreview(client, snapshot);
      cursor = next;
    }
  } finally {
    if (preview) clearSidebarPreview(client, preview);
  }
}

export function useSidebarNavigation(options?: QueryOptions) {
  const enabled = options?.enabled ?? true;
  useEnvironmentListRealtimeSubscription({ enabled });
  useHostListRealtimeSubscription({ enabled });
  useProjectListRealtimeSubscription({ enabled });
  useThreadListRealtimeSubscription({ enabled });

  return useQuery<SidebarBootstrapResponse>({
    queryKey: sidebarNavigationQueryKey(),
    queryFn: fetchSidebarNavigation,
    enabled,
    ...REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY,
    placeholderData: () => readCachedSidebarBootstrap() ?? undefined,
  });
}

export function useProjectDisplayName(
  projectId: string | undefined,
): string | undefined {
  const { data } = useQuery<SidebarBootstrapResponse>({
    queryKey: sidebarNavigationQueryKey(),
    queryFn: fetchSidebarNavigation,
    ...REALTIME_OWNED_STATIC_CACHE_QUERY_POLICY,
    enabled: Boolean(projectId),
  });
  if (!data || !projectId) {
    return undefined;
  }
  if (projectId === PERSONAL_PROJECT_ID) {
    return data.personalProject.name;
  }
  return data.projects.find((project) => project.id === projectId)?.name;
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
