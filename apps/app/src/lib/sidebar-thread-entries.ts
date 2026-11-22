import {
  useCallback,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  hashKey,
  notifyManager,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import type { ThreadListEntry } from "@bb/domain";
import type {
  SidebarBootstrapResponse,
  ThreadListResponse,
} from "@bb/server-contract";
import {
  SIDEBAR_SELECTED_THREAD_TARGET_KIND,
  THREADS_QUERY_KEY,
  archivedThreadsListQueryKey,
  sidebarNavigationQueryKey,
} from "@/hooks/queries/query-keys";
import { sidebarNavigationPreviewQueryKey } from "@/hooks/cache-owners/sidebar-preview-cache";
import { writeSidebarNavigation } from "@/hooks/cache-owners/query-cache";
import { readCachedSidebarBootstrap } from "./sidebar-bootstrap-cache";

type ArchivedThreadsData = InfiniteData<ThreadListResponse, number>;
type ThreadEntries = ReadonlyMap<string, ThreadListEntry>;

export interface SidebarThreadEntriesStore {
  get(threadId: string): ThreadListEntry | null;
  getAll(): ThreadEntries;
  subscribe(threadId: string, listener: () => void): () => void;
  subscribeAll(listener: () => void): () => void;
}

const EMPTY_ENTRIES: ThreadEntries = new Map();

const threadEntryMapByPayload = new WeakMap<
  SidebarBootstrapResponse,
  ThreadEntries
>();

export function threadEntryMapFor(
  data: SidebarBootstrapResponse | undefined,
): ThreadEntries {
  if (data === undefined) return EMPTY_ENTRIES;
  const cached = threadEntryMapByPayload.get(data);
  if (cached !== undefined) return cached;
  const entries = new Map<string, ThreadListEntry>();
  for (const project of [...data.projects, data.personalProject]) {
    for (const thread of project.threads) entries.set(thread.id, thread);
  }
  threadEntryMapByPayload.set(data, entries);
  return entries;
}

const mergedEntryMaps = new WeakMap<
  ArchivedThreadsData,
  WeakMap<ThreadEntries, ThreadEntries>
>();

function mergeArchivedEntries(
  active: ThreadEntries,
  archived: ArchivedThreadsData | undefined,
): ThreadEntries {
  if (archived === undefined) return active;
  let maps = mergedEntryMaps.get(archived);
  if (maps === undefined) {
    maps = new WeakMap();
    mergedEntryMaps.set(archived, maps);
  }
  const cached = maps.get(active);
  if (cached !== undefined) return cached;
  const merged = new Map([
    ...archived.pages.flat().map((thread) => [thread.id, thread] as const),
    ...active,
  ]);
  maps.set(active, merged);
  return merged;
}

const targetEntryMaps = new WeakMap<ThreadListResponse, WeakMap<ThreadEntries, ThreadEntries>>();

function mergeSelectedEntries(active: ThreadEntries, rows: ThreadListResponse): ThreadEntries {
  let maps = targetEntryMaps.get(rows);
  if (!maps) {
    maps = new WeakMap();
    targetEntryMaps.set(rows, maps);
  }
  const previous = maps.get(active);
  if (previous) return previous;
  let merged: Map<string, ThreadListEntry> | undefined;
  for (const row of rows) {
    if (row.archivedAt !== null || row.deletedAt !== null || row.visibility === "hidden" || active.has(row.id)) continue;
    merged ??= new Map(active);
    merged.set(row.id, row);
  }
  const result = merged ?? active;
  maps.set(active, result);
  return result;
}

function readSidebarThreadEntries(queryClient: QueryClient): ThreadEntries {
  const navigation =
    queryClient.getQueryData<SidebarBootstrapResponse>(
      sidebarNavigationQueryKey(),
    ) ??
    queryClient.getQueryData<SidebarBootstrapResponse | null>(
      sidebarNavigationPreviewQueryKey(),
    ) ??
    readCachedSidebarBootstrap() ??
    undefined;
  let active = threadEntryMapFor(navigation);
  const selectedTargets = queryClient.getQueriesData<ThreadListResponse>({
    queryKey: [THREADS_QUERY_KEY, SIDEBAR_SELECTED_THREAD_TARGET_KIND],
    type: "active",
  });
  for (const [, rows] of selectedTargets) {
    if (rows?.length) active = mergeSelectedEntries(active, rows);
  }
  return mergeArchivedEntries(
    active,
    queryClient.getQueryData<ArchivedThreadsData>(
      archivedThreadsListQueryKey({}),
    ),
  );
}

const SOURCE_QUERY_HASHES: ReadonlySet<string> = new Set([
  hashKey(sidebarNavigationQueryKey()),
  hashKey(sidebarNavigationPreviewQueryKey()),
  hashKey(archivedThreadsListQueryKey({})),
]);

function isSidebarEntriesSourceQuery(queryKey: readonly unknown[], queryHash: string): boolean {
  return (
    SOURCE_QUERY_HASHES.has(queryHash) ||
    (queryKey[0] === THREADS_QUERY_KEY &&
      queryKey[1] === SIDEBAR_SELECTED_THREAD_TARGET_KIND)
  );
}

function createSidebarThreadEntriesStore(
  queryClient: QueryClient,
): SidebarThreadEntriesStore {
  const threadListeners = new Map<string, Set<() => void>>();
  const allListeners = new Set<() => void>();
  let published: ThreadEntries | null = null;
  let unsubscribeSource: (() => void) | null = null;

  const notifyChanged = (previous: ThreadEntries, next: ThreadEntries) => {
    const changed: (() => void)[] = [];
    for (const [threadId, listeners] of threadListeners) {
      if (previous.get(threadId) !== next.get(threadId)) {
        changed.push(...listeners);
      }
    }
    for (const listener of changed) listener();
    for (const listener of [...allListeners]) listener();
  };

  const syncFromSource = () => {
    if (published === null) return;
    const previous = published;
    const next = readSidebarThreadEntries(queryClient);
    if (next === previous) return;
    published = next;
    notifyManager.schedule(() => notifyChanged(previous, next));
  };

  const connect = () => {
    if (unsubscribeSource !== null) return;
    published = readSidebarThreadEntries(queryClient);
    unsubscribeSource = queryClient.getQueryCache().subscribe((event) => {
      if (
        isSidebarEntriesSourceQuery(event.query.queryKey, event.query.queryHash)
      ) {
        syncFromSource();
      }
    });
  };

  const releaseIfIdle = () => {
    if (threadListeners.size > 0 || allListeners.size > 0) return;
    unsubscribeSource?.();
    unsubscribeSource = null;
    published = null;
  };

  const getAll = () => published ?? readSidebarThreadEntries(queryClient);

  return {
    get: (threadId) => getAll().get(threadId) ?? null,
    getAll,
    subscribe(threadId, listener) {
      connect();
      let listeners = threadListeners.get(threadId);
      if (listeners === undefined) {
        listeners = new Set();
        threadListeners.set(threadId, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) threadListeners.delete(threadId);
        releaseIfIdle();
      };
    },
    subscribeAll(listener) {
      connect();
      allListeners.add(listener);
      return () => {
        allListeners.delete(listener);
        releaseIfIdle();
      };
    },
  };
}

const storesByQueryClient = new WeakMap<
  QueryClient,
  SidebarThreadEntriesStore
>();

export function sidebarThreadEntriesStoreFor(
  queryClient: QueryClient,
): SidebarThreadEntriesStore {
  let store = storesByQueryClient.get(queryClient);
  if (store === undefined) {
    store = createSidebarThreadEntriesStore(queryClient);
    storesByQueryClient.set(queryClient, store);
  }
  return store;
}

export function SidebarThreadEntriesProvider({
  children,
  navigation,
}: {
  children: ReactNode;
  navigation: SidebarBootstrapResponse | undefined;
}) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (
      navigation !== undefined &&
      navigation !== readCachedSidebarBootstrap() &&
      navigation !== queryClient.getQueryData(sidebarNavigationQueryKey())
    ) {
      writeSidebarNavigation(queryClient, navigation);
    }
  }, [navigation, queryClient]);
  return children;
}

export function useSidebarThreadEntriesStore(): SidebarThreadEntriesStore {
  return sidebarThreadEntriesStoreFor(useQueryClient());
}

export function useSidebarThreadEntry(
  threadId: string,
): ThreadListEntry | null {
  const store = useSidebarThreadEntriesStore();
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(threadId, listener),
    [store, threadId],
  );
  const getSnapshot = () => store.get(threadId);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useSidebarThreadEntries(): ThreadEntries {
  const store = useSidebarThreadEntriesStore();
  return useSyncExternalStore(store.subscribeAll, store.getAll, store.getAll);
}
