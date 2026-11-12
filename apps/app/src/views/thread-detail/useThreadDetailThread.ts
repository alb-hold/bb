import {
  didThreadDetailBootstrapRefreshAfterMount,
  useThread,
  useThreadDetailBootstrap,
} from "@/hooks/queries/thread-queries";
import { useMarkThreadRead } from "@/hooks/mutations/thread-state-mutations";
import { useRetainedThreadSnapshot } from "@/hooks/use-retained-thread-snapshot";
import { useThreadReadTracking } from "@/hooks/useThreadReadTracking";
import { useThreadUnreadDividerState } from "./useThreadUnreadDividerState";

interface ThreadDetailThreadTimelineState {
  hasUnseenTimelineEvents: boolean;
  isFocused: boolean;
  nativeTerminalReady?: boolean;
}

const DEFAULT_TIMELINE_STATE: ThreadDetailThreadTimelineState = {
  hasUnseenTimelineEvents: false,
  isFocused: true,
};

export function useThreadDetailThread(
  threadId: string,
  trackRead: boolean,
  {
    hasUnseenTimelineEvents,
    isFocused,
    nativeTerminalReady = false,
  }: ThreadDetailThreadTimelineState = DEFAULT_TIMELINE_STATE,
) {
  const threadDetailBootstrapQuery = useThreadDetailBootstrap(threadId);
  const hasThreadDetailBootstrapSettled =
    threadDetailBootstrapQuery.isSuccess || threadDetailBootstrapQuery.isError;
  const threadQuery = useThread(threadId, {
    enabled: hasThreadDetailBootstrapSettled || nativeTerminalReady,
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
