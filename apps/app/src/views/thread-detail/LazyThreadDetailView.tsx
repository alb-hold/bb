import type { NativeThreadFrame } from "./NativeThreadFrame";
import { useNativeThreadFrame } from "./NativeThreadFrameContext";
import { useRouteState } from "@/hooks/useRouteState";
import {
  useThread,
  useThreadDetailBootstrap,
} from "@/hooks/queries/thread-queries";
import { useNativeTerminalThread } from "@/hooks/queries/native-terminal-queries";
import { useTerminalSuspenseGate } from "@/hooks/useTerminalMountGate";
import { useEffect, type ComponentProps } from "react";
import { defineSplit } from "@/lib/define-split";
import { RouteLoadingSkeleton } from "@/components/ui/route-loading-skeleton";
import { ThreadTimelineLoadingSkeleton } from "@/components/thread/timeline/ThreadTimelineLoadingSkeleton";
import { usePaneContext } from "./PaneContext";
import type { ThreadDetailView } from "./ThreadDetailView";

function ThreadDetailViewLoading() {
  useTerminalSuspenseGate("terminal-thread-view-fallback");
  const { isBoundedPane } = usePaneContext();
  const nativeFrame = useNativeThreadFrame();
  if (nativeFrame) return null;
  return (
    <RouteLoadingSkeleton isBoundedPane={isBoundedPane}>
      <ThreadTimelineLoadingSkeleton />
    </RouteLoadingSkeleton>
  );
}

const DetailModule = defineSplit<ComponentProps<typeof ThreadDetailView>>({
  id: "thread-detail",
  tier: "intent",
  load: () =>
    import("./ThreadDetailView").then((module) => module.ThreadDetailView),
  loading: ThreadDetailViewLoading,
});

const NativeFrameModule = defineSplit<ComponentProps<typeof NativeThreadFrame>>(
  {
    id: "native-thread-frame",
    tier: "intent",
    load: () =>
      import("./NativeThreadFrame").then((module) => module.NativeThreadFrame),
    loading: ThreadDetailViewLoading,
  },
);
export const preloadNativeThreadFrame = NativeFrameModule.preload;

function ThreadDetailEntry(props: ComponentProps<typeof ThreadDetailView>) {
  useEffect(() => {
    void DetailModule.preload();
  }, []);
  const route = useRouteState();
  const threadId =
    props.surface === "pane" ? props.threadId : (route.threadId ?? "");
  const native = useNativeTerminalThread(threadId);
  useEffect(() => {
    if (native.data != null) void preloadNativeThreadFrame();
  }, [native.data]);
  useThreadDetailBootstrap(threadId, {
    enabled: threadId.length > 0,
    timelinePrefetch: false,
  });
  const threadQuery = useThread(threadId, { enabled: false });
  const thread = threadQuery.data;
  const projectId =
    props.surface === "pane"
      ? props.projectId
      : route.isProjectlessView && thread?.id === threadId
        ? thread.projectId
        : route.projectId;
  if (thread?.nativeTerminal === false) return <DetailModule {...props} />;
  if (
    native.isPending ||
    (native.data != null &&
      (thread === undefined || threadQuery.isPlaceholderData))
  )
    return <ThreadDetailViewLoading />;
  if (
    native.data?.threadId === threadId &&
    thread?.nativeTerminal &&
    thread.id === threadId &&
    thread.projectId === projectId
  ) {
    return (
      <NativeFrameModule key={threadId} thread={thread} view={native.data}>
        <DetailModule {...props} />
      </NativeFrameModule>
    );
  }
  return <DetailModule {...props} />;
}
export const LazyThreadDetailView = Object.assign(ThreadDetailEntry, {
  preload: DetailModule.preload,
  id: DetailModule.id,
  tier: DetailModule.tier,
  isLoaded: DetailModule.isLoaded,
  intentProps: DetailModule.intentProps,
});
