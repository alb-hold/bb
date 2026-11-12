import { useTerminalSuspenseGate } from "@/hooks/useTerminalMountGate";
import type { ComponentProps } from "react";
import { defineSplit } from "@/lib/define-split";
import { RouteLoadingSkeleton } from "@/components/ui/route-loading-skeleton";
import { ThreadTimelineLoadingSkeleton } from "@/components/thread/timeline/ThreadTimelineLoadingSkeleton";
import { usePaneContext } from "./PaneContext";
import type { ThreadDetailView } from "./ThreadDetailView";
import { loadThreadDetailView } from "./thread-detail-loader";

function ThreadDetailViewLoading() {
  useTerminalSuspenseGate("terminal-thread-view-fallback");
  const { isBoundedPane } = usePaneContext();
  return (
    <RouteLoadingSkeleton isBoundedPane={isBoundedPane}>
      <ThreadTimelineLoadingSkeleton />
    </RouteLoadingSkeleton>
  );
}

export const LazyThreadDetailView = defineSplit<
  ComponentProps<typeof ThreadDetailView>
>({
  id: "thread-detail",
  tier: "intent",
  load: loadThreadDetailView,
  loading: ThreadDetailViewLoading,
});
