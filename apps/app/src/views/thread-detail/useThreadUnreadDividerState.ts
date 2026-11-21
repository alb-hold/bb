import { useState } from "react";
import type { ThreadTimelineUnreadDividerPlacement } from "@/components/thread/timeline";
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
): ThreadTimelineUnreadDividerPlacement | null {
  if (
    thread.lastReadAt === null ||
    thread.lastReadAt >= thread.latestAttentionAt
  ) {
    return null;
  }
  return { cutoffAt: thread.lastReadAt };
}

export function useThreadUnreadDividerState({
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
  const threadId = thread?.id;
  const threadLastReadAt = thread?.lastReadAt;
  const threadLatestAttentionAt = thread?.latestAttentionAt;
  const snapshotInputs = JSON.stringify([
    routeThreadId,
    threadId,
    threadLastReadAt,
    threadLatestAttentionAt,
    isOpening,
    isFocused,
    threadQuery.isPlaceholderData,
  ]);
  const [snapshotState, setSnapshotState] = useState<{
    inputs: string | null;
    snapshot: ThreadUnreadDividerSnapshot | null;
  }>({ inputs: null, snapshot: null });
  if (snapshotState.inputs !== snapshotInputs) {
    const currentSnapshot = snapshotState.snapshot;
    let nextSnapshot: ThreadUnreadDividerSnapshot | null = null;
    if (
      threadId !== undefined &&
      threadLastReadAt !== undefined &&
      threadLatestAttentionAt !== undefined &&
      shouldTrackThreadUnreadDivider({ routeThreadId, threadId })
    ) {
      const threadState: ThreadUnreadDividerThreadState = {
        id: threadId,
        lastReadAt: threadLastReadAt,
        latestAttentionAt: threadLatestAttentionAt,
      };

      const threadIsUnread = isThreadUnread({
        lastReadAt: threadLastReadAt,
        latestAttentionAt: threadLatestAttentionAt,
      });
      nextSnapshot = (() => {
        const currentSnapshotValue = currentSnapshot;
        const nextIsOpening =
          currentSnapshotValue?.threadId === threadId
            ? currentSnapshotValue.isOpening && isOpening
            : isOpening;
        const replacedPlaceholder =
          currentSnapshotValue?.threadId === threadId &&
          currentSnapshotValue.isPlaceholderData &&
          !threadQuery.isPlaceholderData;
        if (
          currentSnapshotValue?.threadId === threadId &&
          currentSnapshotValue.attentionAt === threadLatestAttentionAt
        ) {
          const becameFocused = !currentSnapshotValue.isFocused && isFocused;
          const focusChanged = currentSnapshotValue.isFocused !== isFocused;
          if (threadLastReadAt === null) {
            return {
              attentionAt: threadLatestAttentionAt,
              hasAttentionAfterOpening:
                currentSnapshotValue.hasAttentionAfterOpening,
              hasUnseenUpdatesOnOpen:
                currentSnapshotValue.hasUnseenUpdatesOnOpen ||
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
          const placement = buildUnreadDividerPlacement(threadState);
          return currentSnapshotValue.isOpening === nextIsOpening &&
            !focusChanged &&
            !replacedPlaceholder
            ? currentSnapshotValue
            : {
                ...currentSnapshotValue,
                hasUnseenUpdatesOnOpen:
                  currentSnapshotValue.hasUnseenUpdatesOnOpen ||
                  ((becameFocused || replacedPlaceholder) && threadIsUnread),
                isFocused,
                isOpening: nextIsOpening,
                isPlaceholderData: threadQuery.isPlaceholderData,
                landOnDivider: replacedPlaceholder
                  ? placement !== null
                  : currentSnapshotValue.landOnDivider,
                placement: replacedPlaceholder
                  ? placement
                  : currentSnapshotValue.placement,
              };
        }

        const placement = buildUnreadDividerPlacement(threadState);
        const becameFocused =
          currentSnapshotValue?.threadId === threadId &&
          !currentSnapshotValue.isFocused &&
          isFocused;
        return {
          attentionAt: threadLatestAttentionAt,
          hasAttentionAfterOpening:
            currentSnapshotValue?.threadId === threadId
              ? currentSnapshotValue.hasAttentionAfterOpening ||
                (!currentSnapshotValue.isOpening &&
                  !becameFocused &&
                  !replacedPlaceholder &&
                  threadIsUnread)
              : false,
          hasUnseenUpdatesOnOpen:
            currentSnapshotValue?.threadId === threadId
              ? currentSnapshotValue.hasUnseenUpdatesOnOpen ||
                ((currentSnapshotValue.isOpening || becameFocused || replacedPlaceholder) &&
                  threadIsUnread)
              : threadIsUnread,
          isFocused,
          isOpening: nextIsOpening,
          isPlaceholderData: threadQuery.isPlaceholderData,
          landOnDivider:
            placement !== null &&
            (currentSnapshotValue?.threadId !== threadId ||
              currentSnapshotValue.isOpening ||
              replacedPlaceholder),
          placement,
          threadId,
        };
      })();
    }
    setSnapshotState({ inputs: snapshotInputs, snapshot: nextSnapshot });
  }
  const snapshot =
    snapshotState.inputs === snapshotInputs ? snapshotState.snapshot : null;

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
      ready:
        snapshot !== null &&
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
    ready:
      snapshot !== null &&
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
          : buildUnreadDividerPlacement(thread),
  };
}
