import { useEffect, useState } from "react";
import type {
  ThreadTimelineUnreadDividerAnchor,
  ThreadTimelineUnreadDividerPlacement,
} from "@/components/thread/timeline";
import { didThreadDetailBootstrapRefreshAfterMount } from "@/hooks/queries/thread-queries";

interface ThreadUnreadDividerThreadState {
  id: string;
  lastReadAt: number | null;
  latestAttentionAt: number;
}

interface ThreadUnreadDividerSnapshot {
  attentionAt: number;
  hasAttentionAfterOpening: boolean;
  hasUnseenUpdatesOnOpen: boolean;
  isFocused: boolean;
  isOpening: boolean;
  isPlaceholderData: boolean;
  landOnDivider: boolean;
  placement: ThreadTimelineUnreadDividerPlacement | null;
  threadId: string;
}

interface ThreadUnreadDividerState {
  ready: boolean;
  autoScroll: boolean;
  hasUnseenTimelineEvents: boolean;
  landOnDivider: boolean;
  placement: ThreadTimelineUnreadDividerPlacement | null;
}

interface ShouldTrackThreadUnreadDividerArgs {
  routeThreadId: string | undefined;
  threadId: string | undefined;
}

interface IsThreadUnreadArgs {
  lastReadAt: number | null | undefined;
  latestAttentionAt: number | undefined;
}

interface UseThreadUnreadDividerStateArgs {
  anchor: ThreadTimelineUnreadDividerAnchor;
  bootstrapQuery: Parameters<
    typeof didThreadDetailBootstrapRefreshAfterMount
  >[0];
  threadQuery: {
    isFetchedAfterMount: boolean;
    isError: boolean;
    isPlaceholderData: boolean;
  };
  hasUnseenTimelineEvents: boolean;
  isFocused?: boolean;
  routeThreadId: string | undefined;
  thread: ThreadUnreadDividerThreadState | undefined;
}

const NO_UNREAD_DIVIDER_STATE: ThreadUnreadDividerState = {
  ready: false,
  autoScroll: false,
  hasUnseenTimelineEvents: false,
  landOnDivider: false,
  placement: null,
};

function shouldOpenThreadAtLatest({
  hasUnseenTimelineEvents,
  hasUnseenUpdatesOnOpen,
}: {
  hasUnseenTimelineEvents: boolean;
  hasUnseenUpdatesOnOpen: boolean;
}): boolean {
  return hasUnseenTimelineEvents || hasUnseenUpdatesOnOpen;
}

function shouldTrackThreadUnreadDivider({
  routeThreadId,
  threadId,
}: ShouldTrackThreadUnreadDividerArgs): boolean {
  if (threadId === undefined || routeThreadId !== threadId) {
    return false;
  }

  return true;
}

function isThreadUnread({
  lastReadAt,
  latestAttentionAt,
}: IsThreadUnreadArgs): boolean {
  if (lastReadAt === undefined || latestAttentionAt === undefined) {
    return false;
  }
  return lastReadAt === null || lastReadAt < latestAttentionAt;
}

function buildUnreadDividerPlacement(
  thread: ThreadUnreadDividerThreadState,
  anchor: ThreadTimelineUnreadDividerAnchor,
): ThreadTimelineUnreadDividerPlacement | null {
  if (
    thread.lastReadAt === null ||
    thread.lastReadAt >= thread.latestAttentionAt
  ) {
    return null;
  }
  return { anchor, cutoffAt: thread.lastReadAt };
}

export function useThreadUnreadDividerState({
  anchor,
  bootstrapQuery,
  threadQuery,
  hasUnseenTimelineEvents,
  isFocused = true,
  routeThreadId,
  thread,
}: UseThreadUnreadDividerStateArgs): ThreadUnreadDividerState {
  const isOpening =
    !didThreadDetailBootstrapRefreshAfterMount(bootstrapQuery) &&
    !threadQuery.isFetchedAfterMount &&
    !threadQuery.isError;
  const [snapshot, setSnapshot] = useState<ThreadUnreadDividerSnapshot | null>(
    null,
  );
  const threadId = thread?.id;
  const threadLastReadAt = thread?.lastReadAt;
  const threadLatestAttentionAt = thread?.latestAttentionAt;

  useEffect(() => {
    if (
      threadId === undefined ||
      threadLastReadAt === undefined ||
      threadLatestAttentionAt === undefined ||
      !shouldTrackThreadUnreadDivider({
        routeThreadId,
        threadId,
      })
    ) {
      setSnapshot(null);
      return;
    }

    const threadState: ThreadUnreadDividerThreadState = {
      id: threadId,
      lastReadAt: threadLastReadAt,
      latestAttentionAt: threadLatestAttentionAt,
    };

    const threadIsUnread = isThreadUnread({
      lastReadAt: threadLastReadAt,
      latestAttentionAt: threadLatestAttentionAt,
    });
    setSnapshot((currentSnapshot) => {
      const nextIsOpening =
        currentSnapshot?.threadId === threadId
          ? currentSnapshot.isOpening && isOpening
          : isOpening;
      const replacedPlaceholder =
        currentSnapshot?.threadId === threadId &&
        currentSnapshot.isPlaceholderData &&
        !threadQuery.isPlaceholderData;
      if (
        currentSnapshot?.threadId === threadId &&
        currentSnapshot.attentionAt === threadLatestAttentionAt
      ) {
        const becameFocused = !currentSnapshot.isFocused && isFocused;
        const focusChanged = currentSnapshot.isFocused !== isFocused;
        if (threadLastReadAt === null) {
          return {
            attentionAt: threadLatestAttentionAt,
            hasAttentionAfterOpening:
              currentSnapshot.hasAttentionAfterOpening,
            hasUnseenUpdatesOnOpen:
              currentSnapshot.hasUnseenUpdatesOnOpen ||
              becameFocused ||
              replacedPlaceholder,
            isFocused,
            isOpening: nextIsOpening,
            isPlaceholderData: threadQuery.isPlaceholderData,
            landOnDivider: false,
            placement: null,
            threadId,
          };
        }
        const placement = buildUnreadDividerPlacement(threadState, anchor);
        return currentSnapshot.isOpening === nextIsOpening &&
          !focusChanged &&
          !replacedPlaceholder
          ? currentSnapshot
          : {
              ...currentSnapshot,
              hasUnseenUpdatesOnOpen:
                currentSnapshot.hasUnseenUpdatesOnOpen ||
                ((becameFocused || replacedPlaceholder) && threadIsUnread),
              isFocused,
              isOpening: nextIsOpening,
              isPlaceholderData: threadQuery.isPlaceholderData,
              landOnDivider: replacedPlaceholder
                ? placement !== null
                : currentSnapshot.landOnDivider,
              placement: replacedPlaceholder
                ? placement
                : currentSnapshot.placement,
            };
      }

      const placement = buildUnreadDividerPlacement(threadState, anchor);
      const becameFocused =
        currentSnapshot?.threadId === threadId &&
        !currentSnapshot.isFocused &&
        isFocused;
      return {
        attentionAt: threadLatestAttentionAt,
        hasAttentionAfterOpening:
          currentSnapshot?.threadId === threadId
            ? currentSnapshot.hasAttentionAfterOpening ||
              (!currentSnapshot.isOpening && !becameFocused && threadIsUnread)
            : false,
        hasUnseenUpdatesOnOpen:
          currentSnapshot?.threadId === threadId
            ? currentSnapshot.hasUnseenUpdatesOnOpen ||
              ((currentSnapshot.isOpening || becameFocused) && threadIsUnread)
            : threadIsUnread,
        isFocused,
        isOpening: nextIsOpening,
        isPlaceholderData: threadQuery.isPlaceholderData,
        landOnDivider:
          placement !== null &&
          (currentSnapshot?.threadId !== threadId ||
            currentSnapshot.isOpening),
        placement,
        threadId,
      };
    });
  }, [
    anchor,
    isOpening,
    isFocused,
    routeThreadId,
    threadId,
    threadLastReadAt,
    threadLatestAttentionAt,
    threadQuery.isPlaceholderData,
  ]);

  if (
    !shouldTrackThreadUnreadDivider({
      routeThreadId,
      threadId,
    }) ||
    (snapshot !== null &&
      snapshot.threadId === threadId &&
      snapshot.attentionAt !== threadLatestAttentionAt &&
      !isThreadUnread({
        lastReadAt: threadLastReadAt,
        latestAttentionAt: threadLatestAttentionAt,
      }))
  ) {
    return {
      ...NO_UNREAD_DIVIDER_STATE,
      ready: snapshot !== null &&
        snapshot.threadId === threadId &&
        !snapshot.isPlaceholderData,
      autoScroll: isFocused && hasUnseenTimelineEvents,
      hasUnseenTimelineEvents: isFocused && hasUnseenTimelineEvents,
    };
  }

  const hasUnseenUpdatesOnOpen =
    snapshot !== null && snapshot.threadId === threadId
      ? snapshot.hasUnseenUpdatesOnOpen ||
        ((snapshot.isOpening ||
          (!snapshot.isFocused && isFocused) ||
          (snapshot.isPlaceholderData && !threadQuery.isPlaceholderData)) &&
          isThreadUnread({
            lastReadAt: threadLastReadAt,
            latestAttentionAt: threadLatestAttentionAt,
          }))
      : isThreadUnread({
          lastReadAt: threadLastReadAt,
          latestAttentionAt: threadLatestAttentionAt,
        });
  const becameFocused =
    snapshot !== null &&
    snapshot.threadId === threadId &&
    !snapshot.isFocused &&
    isFocused;
  const hasNewAttentionAfterOpening =
    snapshot !== null &&
    snapshot.threadId === threadId &&
    !snapshot.isOpening &&
    !(snapshot.isPlaceholderData && !threadQuery.isPlaceholderData) &&
    !hasUnseenUpdatesOnOpen &&
    (snapshot.hasAttentionAfterOpening ||
      (snapshot.attentionAt !== threadLatestAttentionAt && !becameFocused));
  const autoScroll = shouldOpenThreadAtLatest({
    hasUnseenTimelineEvents:
      isFocused && hasUnseenTimelineEvents && !hasNewAttentionAfterOpening,
    hasUnseenUpdatesOnOpen: isFocused && hasUnseenUpdatesOnOpen,
  });
  return {
    ready: snapshot !== null &&
        snapshot.threadId === threadId &&
        !snapshot.isPlaceholderData,
    autoScroll,
    hasUnseenTimelineEvents: autoScroll,
    landOnDivider:
      snapshot !== null &&
      snapshot.threadId === threadId &&
      !(snapshot.isPlaceholderData && !threadQuery.isPlaceholderData) &&
      snapshot.landOnDivider,
    placement:
      snapshot !== null &&
      snapshot.threadId === threadId &&
      !(snapshot.isPlaceholderData && !threadQuery.isPlaceholderData)
        ? snapshot.placement
        : thread === undefined
          ? null
          : buildUnreadDividerPlacement(thread, anchor),
  };
}
