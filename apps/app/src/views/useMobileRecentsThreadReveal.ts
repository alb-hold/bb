import { useEffect, useMemo, useRef } from "react";
import { useSetAtom } from "jotai";
import type { ThreadListEntry } from "@bb/domain";
import { isThreadRead } from "@bb/client-core";
import { useRouteState } from "@/hooks/useRouteState";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useSidebarNavigationPreviewWithSelected } from "@/hooks/queries/sidebar-selected-thread-projection";
import { listSidebarNavigationThreads } from "@/hooks/cache-owners/query-cache";
import { mobileRecentsCollapsedThreadIdsAtom } from "./mobile-recents-collapse";

export interface MobileRecentsRevealState {
  pendingNavigation: string | undefined;
  previousThreadId: string | undefined;
  previousUnreadIds: ReadonlySet<string> | null;
}

export const INITIAL_MOBILE_RECENTS_REVEAL_STATE: MobileRecentsRevealState = {
  pendingNavigation: undefined,
  previousThreadId: undefined,
  previousUnreadIds: null,
};

type MobileRecentsRevealRow = Pick<
  ThreadListEntry,
  "id" | "parentThreadId" | "lastReadAt" | "latestAttentionAt"
> & { visibility?: ThreadListEntry["visibility"] };

export function stepMobileRecentsReveal(
  state: MobileRecentsRevealState,
  {
    isPlaceholderData,
    selectedThreadId,
    threads,
  }: {
    isPlaceholderData: boolean;
    selectedThreadId: string | undefined;
    threads: readonly MobileRecentsRevealRow[] | null;
  },
): { ancestorIds: ReadonlySet<string>; state: MobileRecentsRevealState } {
  const navigated = state.previousThreadId !== selectedThreadId;
  let pendingNavigation = navigated
    ? selectedThreadId
    : state.pendingNavigation;
  if (threads === null || isPlaceholderData) {
    return {
      ancestorIds: new Set(),
      state: {
        ...state,
        pendingNavigation,
        previousThreadId: selectedThreadId,
      },
    };
  }
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const revealIds = new Set<string>();
  if (pendingNavigation && threadById.has(pendingNavigation)) {
    revealIds.add(pendingNavigation);
    pendingNavigation = undefined;
  }
  const unreadIds = new Set<string>();
  for (const thread of threads) {
    if (thread.visibility === "hidden" || isThreadRead(thread)) continue;
    unreadIds.add(thread.id);
    if (
      state.previousUnreadIds &&
      !state.previousUnreadIds.has(thread.id) &&
      thread.id !== selectedThreadId
    ) {
      revealIds.add(thread.id);
    }
  }

  const ancestorIds = new Set<string>();
  for (const threadId of revealIds) {
    const thread = threadById.get(threadId);
    if (!thread || thread.visibility === "hidden") continue;
    let parentThreadId = thread.parentThreadId;
    while (parentThreadId !== null && !ancestorIds.has(parentThreadId)) {
      const parent = threadById.get(parentThreadId);
      if (!parent) break;
      ancestorIds.add(parent.id);
      parentThreadId = parent.parentThreadId;
    }
  }
  return {
    ancestorIds,
    state: {
      pendingNavigation,
      previousThreadId: selectedThreadId,
      previousUnreadIds: unreadIds,
    },
  };
}

function collectSelectedChain(
  selectedThreadId: string | undefined,
  rows: readonly ThreadListEntry[],
): ThreadListEntry[] {
  if (!selectedThreadId) return [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const chain: ThreadListEntry[] = [];
  let current = byId.get(selectedThreadId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    chain.push(current);
    current =
      current.parentThreadId !== null
        ? byId.get(current.parentThreadId)
        : undefined;
  }
  return chain;
}

export function useMobileRecentsThreadReveal(): void {
  const { threadId: selectedThreadId } = useRouteState();
  const { data: navigation, isPlaceholderData } = useSidebarNavigation();
  const projectedPreview =
    useSidebarNavigationPreviewWithSelected(selectedThreadId);
  const setCollapsedThreadIds = useSetAtom(mobileRecentsCollapsedThreadIdsAtom);
  const complete = navigation && !isPlaceholderData ? navigation : undefined;

  const threads = useMemo<readonly MobileRecentsRevealRow[] | null>(() => {
    if (complete) return listSidebarNavigationThreads(complete);
    const unreadTree = projectedPreview?.overview?.unreadTree;
    if (!unreadTree) return null;
    if (!selectedThreadId || !projectedPreview) return unreadTree;
    const selectedChain = collectSelectedChain(
      selectedThreadId,
      listSidebarNavigationThreads(projectedPreview),
    );
    if (selectedChain.length === 0) return unreadTree;
    const byId = new Map<string, MobileRecentsRevealRow>(
      unreadTree.map((row) => [row.id, row]),
    );
    for (const row of selectedChain) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
    return [...byId.values()];
  }, [complete, projectedPreview, selectedThreadId]);
  const revealState = useRef(INITIAL_MOBILE_RECENTS_REVEAL_STATE);

  useEffect(() => {
    const { ancestorIds, state } = stepMobileRecentsReveal(
      revealState.current,
      {
        isPlaceholderData: threads === null,
        selectedThreadId,
        threads,
      },
    );
    revealState.current = state;
    if (ancestorIds.size === 0) return;
    setCollapsedThreadIds((current) => {
      const next = current.filter((id) => !ancestorIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [
    isPlaceholderData,
    navigation,
    selectedThreadId,
    setCollapsedThreadIds,
    threads,
  ]);
}
