import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { PERSONAL_PROJECT_ID, type ThreadListEntry } from "@bb/domain";
import type { SidebarBootstrapResponse } from "@bb/server-contract";
import { listSidebarNavigationThreads } from "@/hooks/cache-owners/query-cache";
import { apiClient } from "@/lib/api-server";
import { request, requestOptions, requestResponse } from "@/lib/api";
import { fetchWithDeviceHandoffSubmission } from "@/lib/api-server";
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

async function fetchSidebarPage(signal?: AbortSignal, cursor?: string) {
  const url = new URL(apiClient["sidebar-bootstrap"].$url().toString());
  url.searchParams.set("limit", String(SIDEBAR_PAGE_SIZE));
  if (cursor) url.searchParams.set("cursor", cursor);
  const response = await requestResponse(
    fetchWithDeviceHandoffSubmission(url, requestOptions(signal)?.init),
  );
  const data = (await response.json()) as SidebarBootstrapResponse;
  return {
    data,
    paged: response.headers.get("X-BB-Pagination") !== null,
    nextCursor: response.headers.get("X-BB-Next-Cursor"),
  };
}

export function useProgressiveSidebarNavigation(enabled = true) {
  const queryClient = useQueryClient();
  const previewQuery = useQuery({
    queryKey: ["sidebar-navigation-preview"],
    queryFn: ({ signal }) => fetchSidebarPage(signal),
    staleTime: 30_000,
    enabled,
  });
  const completeQuery = useQuery({
    queryKey: ["sidebar-navigation-progressive"],
    queryFn: async ({ signal }) => {
      const first = previewQuery.data ?? await fetchSidebarPage(signal);
      const preview = first.data;
      if (!first.paged) {
        queryClient.setQueryData(sidebarNavigationQueryKey(), first.data);
        writeCachedSidebarBootstrap(first.data);
        return { preview: first.data, complete: first.data };
      }
      const pages = [first.data];
      let cursor = first.nextCursor;
      while (cursor !== null) {
        const page = await fetchSidebarPage(signal, cursor);
        pages.push(page.data);
        cursor = page.nextCursor;
      }
      const firstPage = pages[0] ?? preview;
      const mergeThreads = (getRows: (page: SidebarBootstrapResponse) => SidebarBootstrapResponse["personalProject"]["threads"]) => {
        const seen = new Set<string>();
        return pages.flatMap(getRows).filter((thread) => {
          if (seen.has(thread.id)) return false;
          seen.add(thread.id);
          return true;
        });
      };
      const complete: SidebarBootstrapResponse = {
        ...firstPage,
        projects: firstPage.projects.map((project) => ({
          ...project,
          threads: mergeThreads((page) => page.projects.find((item) => item.id === project.id)?.threads ?? []),
        })),
        personalProject: {
          ...firstPage.personalProject,
          threads: mergeThreads((page) => page.personalProject.threads),
        },
      };
      queryClient.setQueryData(sidebarNavigationQueryKey(), complete);
      writeCachedSidebarBootstrap(complete);
      return { preview, complete };
    },
    enabled: enabled && previewQuery.data !== undefined,
    staleTime: 30_000,
  });
  return {
    ...completeQuery,
    preview: previewQuery.data?.data,
    isComplete: completeQuery.data !== undefined,
  };
}

function fetchSidebarNavigation(
  signal?: AbortSignal,
): Promise<SidebarBootstrapResponse> {
  return request<SidebarBootstrapResponse>(
    apiClient["sidebar-bootstrap"].$get(undefined, requestOptions(signal)),
  );
}

export function useSidebarNavigation(options?: QueryOptions) {
  const enabled = options?.enabled ?? true;
  useEnvironmentListRealtimeSubscription({ enabled });
  useHostListRealtimeSubscription({ enabled });
  useProjectListRealtimeSubscription({ enabled });
  useThreadListRealtimeSubscription({ enabled });

  return useQuery<SidebarBootstrapResponse>({
    queryKey: sidebarNavigationQueryKey(),
    queryFn: async ({ signal }) => {
      const response = await fetchSidebarNavigation(signal);
      writeCachedSidebarBootstrap(response);
      return response;
    },
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
    queryFn: ({ signal }) => fetchSidebarNavigation(signal),
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
    queryFn: ({ signal }) => fetchSidebarNavigation(signal),
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
