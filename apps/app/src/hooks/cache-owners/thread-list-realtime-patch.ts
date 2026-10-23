import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import type { ThreadListEntry } from "@bb/domain";
import type {
  ArchivedThreadsListFilters,
  ThreadListQueryFilters,
} from "../queries/query-keys";
import {
  ARCHIVED_THREADS_LIST_KIND,
  threadsQueryKey,
} from "../queries/query-keys";
import {
  getCachedThreadListQueryKeys,
  isArchivedThreadListQueryKey,
} from "./query-cache";
import type { ThreadListCacheData } from "./thread-list-cache-data";

type FetchThreadListRow = (
  threadId: string,
) => Promise<ThreadListEntry | undefined>;

interface PatchThreadListRowArgs {
  archivedRefetchType?: "active" | "none";
  fetchThreadListRow: FetchThreadListRow;
  projectId: string | undefined;
  queryClient: QueryClient;
  threadId: string | undefined;
}

const pendingThreadListRowFetches = new WeakMap<
  QueryClient,
  Map<string, Promise<ThreadListEntry | undefined>>
>();

function readListFilters(
  queryKey: QueryKey,
): ThreadListQueryFilters | ArchivedThreadsListFilters | null {
  if (queryKey[0] !== threadsQueryKey()[0]) return null;
  const candidate = queryKey[1] === ARCHIVED_THREADS_LIST_KIND
    ? queryKey[2]
    : queryKey[1];
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return null;
  }
  const filters = candidate as Record<string, unknown>;
  if (queryKey[1] === ARCHIVED_THREADS_LIST_KIND) {
    if (Object.keys(filters).some((key) => key !== "projectId" && key !== "kind")) {
      return null;
    }
    if (filters.projectId !== undefined && typeof filters.projectId !== "string") return null;
    if (![undefined, "all", "root", "child"].includes(filters.kind as string | undefined)) return null;
    return filters as ArchivedThreadsListFilters;
  }
  const allowed = new Set([
    "projectId",
    "hostId",
    "hasParent",
    "parentThreadId",
    "sourceThreadId",
    "originKind",
    "archived",
    "limit",
  ]);
  if (Object.keys(filters).some((key) => !allowed.has(key))) return null;
  if (typeof filters.archived !== "boolean") return null;
  if (filters.projectId !== undefined && typeof filters.projectId !== "string") return null;
  if (filters.hostId !== undefined && typeof filters.hostId !== "string") return null;
  if (filters.hasParent !== undefined && typeof filters.hasParent !== "boolean") return null;
  if (filters.parentThreadId !== undefined && typeof filters.parentThreadId !== "string") return null;
  if (filters.sourceThreadId !== undefined && typeof filters.sourceThreadId !== "string") return null;
  if (filters.originKind !== undefined && typeof filters.originKind !== "string") return null;
  if (filters.limit !== undefined && typeof filters.limit !== "number") return null;
  return filters as unknown as ThreadListQueryFilters;
}

function rowMatchesFilters(
  row: ThreadListEntry,
  queryKey: QueryKey,
  filters: ThreadListQueryFilters | ArchivedThreadsListFilters,
): boolean {
  if (row.visibility !== "visible") return false;
  if (queryKey[1] === ARCHIVED_THREADS_LIST_KIND) {
    const archivedFilters = filters as ArchivedThreadsListFilters;
    return (
      row.archivedAt !== null &&
      (archivedFilters.projectId === undefined || row.projectId === archivedFilters.projectId) &&
      (archivedFilters.kind === undefined || archivedFilters.kind === "all" ||
        (archivedFilters.kind === "root" && row.parentThreadId === null) ||
        (archivedFilters.kind === "child" && row.parentThreadId !== null))
    );
  }
  const listFilters = filters as ThreadListQueryFilters;
  return (
    (row.archivedAt === null) === !listFilters.archived &&
    (listFilters.projectId === undefined || row.projectId === listFilters.projectId) &&
    (listFilters.hostId === undefined || row.environmentHostId === listFilters.hostId) &&
    (listFilters.hasParent === undefined || (row.parentThreadId !== null) === listFilters.hasParent) &&
    (listFilters.parentThreadId === undefined || row.parentThreadId === listFilters.parentThreadId) &&
    (listFilters.sourceThreadId === undefined || row.sourceThreadId === listFilters.sourceThreadId) &&
    (listFilters.originKind === undefined || row.originKind === listFilters.originKind)
  );
}

function compareActiveRows(left: ThreadListEntry, right: ThreadListEntry): number {
  const projectOrder = compareText(left.projectId, right.projectId);
  if (projectOrder !== 0) return projectOrder;
  const leftPinned = left.pinnedAt !== null;
  const rightPinned = right.pinnedAt !== null;
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
  if (leftPinned && rightPinned) {
    const pinOrder = compareText(left.pinSortKey ?? "", right.pinSortKey ?? "");
    if (pinOrder !== 0) return pinOrder;
    return compareText(left.id, right.id);
  }
  return right.createdAt - left.createdAt || compareText(right.id, left.id);
}

function compareArchivedRows(left: ThreadListEntry, right: ThreadListEntry): number {
  return (right.archivedAt ?? 0) - (left.archivedAt ?? 0) || compareText(right.id, left.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function updateListData(
  data: ThreadListCacheData,
  row: ThreadListEntry | undefined,
  threadId: string,
  queryKey: QueryKey,
  filters: ThreadListQueryFilters | ArchivedThreadsListFilters,
): ThreadListCacheData {
  const updatePage = (entries: ThreadListEntry[]) => {
    const remaining = entries.filter((entry) => entry.id !== threadId);
    if (row && rowMatchesFilters(row, queryKey, filters)) remaining.push(row);
    remaining.sort(queryKey[1] === ARCHIVED_THREADS_LIST_KIND
      ? compareArchivedRows
      : compareActiveRows);
    if (queryKey[1] !== ARCHIVED_THREADS_LIST_KIND) {
      const limit = (filters as ThreadListQueryFilters).limit;
      if (limit !== undefined) remaining.length = Math.min(remaining.length, limit);
    }
    return remaining;
  };
  if (Array.isArray(data)) return updatePage(data);
  const infinite = data as InfiniteData<ThreadListEntry[]>;
  const previousPages = infinite.pages;
  const rows = updatePage(previousPages.flat());
  let offset = 0;
  const pages = previousPages.map((page, index) => {
    const length = index === previousPages.length - 1
      ? rows.length - offset
      : page.length;
    const next = rows.slice(offset, offset + length);
    offset += length;
    return next;
  });
  return { ...infinite, pages };
}

function getFetchForClient(
  queryClient: QueryClient,
  fetchThreadListRow: FetchThreadListRow,
  threadId: string,
): Promise<ThreadListEntry | undefined> {
  let fetches = pendingThreadListRowFetches.get(queryClient);
  if (!fetches) {
    fetches = new Map();
    pendingThreadListRowFetches.set(queryClient, fetches);
  }
  const current = fetches.get(threadId);
  if (current) return current;
  const pending = Promise.resolve().then(() => fetchThreadListRow(threadId));
  fetches.set(threadId, pending);
  void pending.finally(() => {
    if (fetches?.get(threadId) === pending) fetches.delete(threadId);
  }).catch(() => {});
  return pending;
}

export async function patchCachedThreadListRow({
  archivedRefetchType = "active",
  fetchThreadListRow,
  projectId,
  queryClient,
  threadId,
}: PatchThreadListRowArgs): Promise<void> {
  const queryKeys = getCachedThreadListQueryKeys(queryClient);
  const cachedKeys = queryClient.getQueryCache().findAll({ queryKey: threadsQueryKey() });
  if (threadId === undefined) {
    for (const query of cachedKeys) {
      if (isFallbackKeyForProject(query.queryKey, projectId)) {
        invalidateThreadListKey(queryClient, query.queryKey, archivedRefetchType);
      }
    }
    return;
  }
  let row: ThreadListEntry | undefined;
  try {
    row = await getFetchForClient(queryClient, fetchThreadListRow, threadId);
  } catch {
    for (const query of cachedKeys) {
      if (isFallbackKeyForProject(query.queryKey, projectId)) {
        invalidateThreadListKey(queryClient, query.queryKey, archivedRefetchType);
      }
    }
    return;
  }
  const supportedKeys = new Set(queryKeys.map((queryKey) => JSON.stringify(queryKey)));
  for (const query of cachedKeys) {
    const queryKey = query.queryKey;
    const filters = readListFilters(queryKey);
    if (!supportedKeys.has(JSON.stringify(queryKey)) || !filters) {
      if (isFallbackKeyForProject(queryKey, projectId)) {
        invalidateThreadListKey(queryClient, queryKey, archivedRefetchType);
      }
      continue;
    }
    if (!query.state.data) {
      invalidateThreadListKey(queryClient, queryKey, archivedRefetchType);
      continue;
    }
    const isPaged = !Array.isArray(query.state.data) &&
      typeof query.state.data === "object" && query.state.data !== null &&
      "pages" in query.state.data && Array.isArray(query.state.data.pages);
    const isLimited = queryKey[1] !== ARCHIVED_THREADS_LIST_KIND &&
      (filters as ThreadListQueryFilters).limit !== undefined;
    if (isPaged || isLimited || !Array.isArray(query.state.data)) {
      invalidateThreadListKey(queryClient, queryKey, archivedRefetchType);
      continue;
    }
    queryClient.setQueryData<ThreadListCacheData>(queryKey, (data) =>
      data ? updateListData(data, row, threadId, queryKey, filters) : data,
    );
  }
}

function invalidateThreadListKey(
  queryClient: QueryClient,
  queryKey: QueryKey,
  archivedRefetchType: "active" | "none",
): void {
  queryClient.invalidateQueries({
    exact: true,
    queryKey,
    ...(isArchivedThreadListQueryKey(queryKey) && archivedRefetchType === "none"
      ? { refetchType: "none" as const }
      : {}),
  });
}

function isFallbackKeyForProject(
  queryKey: QueryKey,
  projectId: string | undefined,
): boolean {
  if (projectId === undefined) return true;
  const filters = readListFilters(queryKey);
  if (filters === null) return true;
  return filters.projectId === undefined || filters.projectId === projectId;
}
