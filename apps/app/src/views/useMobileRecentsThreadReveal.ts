import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import type { ThreadListEntry, ThreadWithRuntime } from "@bb/domain";
import { isThreadRead } from "@bb/client-core";
import { useRouteState } from "@/hooks/useRouteState";
import {
  useSidebarNavigation,
  useSidebarNavigationPreview,
} from "@/hooks/queries/sidebar-navigation-query";
import { threadQueryKey } from "@/hooks/queries/query-keys";
import { listSidebarNavigationThreads } from "@/hooks/cache-owners/query-cache";
import { sdk } from "@/lib/sdk";
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

export function stepMobileRecentsReveal(
  state: MobileRecentsRevealState,
  {
    isPlaceholderData,
    selectedThreadId,
    threads,
  }: {
    isPlaceholderData: boolean;
    selectedThreadId: string | undefined;
    threads:
      | readonly (Pick<
          ThreadListEntry,
          "id" | "parentThreadId" | "lastReadAt" | "latestAttentionAt"
        > & { visibility?: ThreadListEntry["visibility"] })[]
      | null;
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

function hasSelectedThreadAncestry(
  selectedThreadId: string,
  threads: readonly Pick<ThreadListEntry, "id" | "parentThreadId">[],
): boolean {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  let current = byId.get(selectedThreadId);
  if (!current) return false;
  let remaining = byId.size;
  while (current.parentThreadId !== null && remaining > 0) {
    const parent = byId.get(current.parentThreadId);
    if (!parent) return false;
    current = parent;
    remaining -= 1;
  }
  return true;
}

export function useMobileRecentsThreadReveal(): void {
  const queryClient = useQueryClient();
  const { threadId: selectedThreadId } = useRouteState();
  const { data: navigation, isPlaceholderData } = useSidebarNavigation();
  const preview = useSidebarNavigationPreview();
  const setCollapsedThreadIds = useSetAtom(mobileRecentsCollapsedThreadIdsAtom);
  const complete = navigation && !isPlaceholderData ? navigation : undefined;
  const previewThreads = useMemo(
    () => (preview ? listSidebarNavigationThreads(preview) : null),
    [preview],
  );
  const needsTargetedSelectedReveal =
    selectedThreadId !== undefined &&
    complete === undefined &&
    previewThreads !== null &&
    !hasSelectedThreadAncestry(selectedThreadId, previewThreads);

  useEffect(() => {
    if (!needsTargetedSelectedReveal || selectedThreadId === undefined) {
      return;
    }
    const controller = new AbortController();
    const revealSelection = async () => {
      const cached = queryClient.getQueryData<ThreadWithRuntime>(
        threadQueryKey(selectedThreadId),
      );
      const thread =
        cached ??
        (await sdk.threads.get({
          threadId: selectedThreadId,
          signal: controller.signal,
        }));
      if (
        controller.signal.aborted ||
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        thread.visibility === "hidden"
      ) {
        return;
      }
      const { threads: ancestry } =
        await sdk.threads.experimental_listAncestors({
          threadIds: [selectedThreadId],
          signal: controller.signal,
        });
      if (controller.signal.aborted) return;
      const ancestorIds = new Set(
        ancestry.find((entry) => entry.threadId === selectedThreadId)
          ?.ancestorIds ?? [],
      );
      if (ancestorIds.size === 0) return;
      setCollapsedThreadIds((current) => {
        const next = current.filter((id) => !ancestorIds.has(id));
        return next.length === current.length ? current : next;
      });
    };
    void revealSelection().catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [
    needsTargetedSelectedReveal,
    queryClient,
    selectedThreadId,
    setCollapsedThreadIds,
  ]);

  const threads = useMemo(
    () =>
      complete
        ? listSidebarNavigationThreads(complete)
        : (preview?.overview?.unreadTree ?? null),
    [complete, preview?.overview],
  );
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
