import {
  didThreadDetailBootstrapRefreshAfterMount,
  useThread,
  useThreadDetailBootstrap,
} from "@/hooks/queries/thread-queries";
import type { ThreadTimelineUnreadDividerAnchor } from "@/components/thread/timeline";
import { useMarkThreadRead } from "@/hooks/mutations/thread-state-mutations";
import { useRetainedThreadSnapshot } from "@/hooks/use-retained-thread-snapshot";
import { useThreadReadTracking } from "@/hooks/useThreadReadTracking";
import { useThreadUnreadDividerState } from "./useThreadUnreadDividerState";

interface ThreadDetailThreadTimelineState {
  hasUnseenTimelineEvents: boolean;
  isFocused: boolean;
}

const DEFAULT_TIMELINE_STATE: ThreadDetailThreadTimelineState = {
  hasUnseenTimelineEvents: false,
  isFocused: true,
};

export function useThreadDetailThread(
  threadId: string,
  trackRead: boolean,
  unreadDividerAnchor: ThreadTimelineUnreadDividerAnchor,
  { hasUnseenTimelineEvents, isFocused }: ThreadDetailThreadTimelineState = DEFAULT_TIMELINE_STATE,
) {
  const threadDetailBootstrapQuery = useThreadDetailBootstrap(threadId);
  const hasThreadDetailBootstrapSettled =
    threadDetailBootstrapQuery.isSuccess || threadDetailBootstrapQuery.isError;
  const threadQuery = useThread(threadId, {
    enabled: hasThreadDetailBootstrapSettled,
    refetchOnMount: didThreadDetailBootstrapRefreshAfterMount(
      threadDetailBootstrapQuery,
    )
      ? false
      : "always",
  });
  const thread = useRetainedThreadSnapshot({
    snapshot: threadQuery.data,
    threadId,
  });
  const unreadDividerState = useThreadUnreadDividerState({
    anchor: unreadDividerAnchor,
    bootstrapQuery: threadDetailBootstrapQuery,
    threadQuery: {
      isFetchedAfterMount: threadQuery.isFetchedAfterMount,
      isError: threadQuery.isError,
      isPlaceholderData: threadQuery.isPlaceholderData,
    },
    hasUnseenTimelineEvents,
    isFocused,
    routeThreadId: threadId,
    thread,
  });
  useThreadReadTracking({
    isFocused,
    markThreadRead: useMarkThreadRead(),
    thread: trackRead && unreadDividerState.ready ? thread : undefined,
  });
  return {
    hasThreadDetailBootstrapSettled,
    thread,
    threadDetailBootstrapQuery,
    threadQuery,
    unreadDividerState,
  };
}
