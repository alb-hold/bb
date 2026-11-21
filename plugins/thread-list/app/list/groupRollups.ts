import { useMemo } from "react";
import {
  useSidebarSplitLayout,
  useSidebarThreadRowStatuses,
  type PluginSidebarSplitPane,
  type PluginSidebarThreadRowStatus,
} from "@get-bb/plugin-sdk/app";
import type { SidebarThread } from "../model/sidebar-thread.js";
import {
  getCollapsedChildActivity,
  resolveThreadListIndicator,
  type ThreadListIndicatorKind,
} from "../model/thread-activity.js";
import { useThreadsHaveDraft } from "./sidebarDraftPresence.js";

export interface ThreadSplitIndicatorTarget {
  id: string;
}

interface ThreadGroupSplitIndicator {
  isOpenInSplit: boolean;
  miniMap: PluginSidebarSplitPane[] | null;
}

const NO_INDICATOR: ThreadGroupSplitIndicator = {
  isOpenInSplit: false,
  miniMap: null,
};

export function useThreadGroupSplitIndicator(
  threads: readonly ThreadSplitIndicatorTarget[],
  enabled: boolean,
): ThreadGroupSplitIndicator {
  const layout = useSidebarSplitLayout();
  return useMemo<ThreadGroupSplitIndicator>(() => {
    if (!enabled || threads.length === 0 || layout === null) {
      return NO_INDICATOR;
    }
    const threadIds = new Set(threads.map((thread) => thread.id));
    const slots = layout.panes.map<PluginSidebarSplitPane>((pane) => ({
      paneId: pane.paneId,
      rect: pane.rect,
      isMe: pane.threadId !== null && threadIds.has(pane.threadId),
      isFocused: pane.isFocused,
    }));
    return slots.some((slot) => slot.isMe)
      ? { isOpenInSplit: true, miniMap: slots }
      : NO_INDICATOR;
  }, [enabled, layout, threads]);
}

export function usePluginThreadRowStatusForThreads(
  threads: readonly { id: string }[],
): PluginSidebarThreadRowStatus | null {
  const statuses = useSidebarThreadRowStatuses();
  return useMemo(() => {
    for (const thread of threads) {
      const status = statuses.get(thread.id);
      if (status) return status;
    }
    return null;
  }, [statuses, threads]);
}

export const NO_HIDDEN_THREADS: readonly SidebarThread[] = [];

export interface HiddenThreadsStatus {
  indicator: ThreadListIndicatorKind;
  rowStatus: PluginSidebarThreadRowStatus | null;
  isWorking: boolean;
}

export function useHiddenThreadsStatus(
  threads: readonly SidebarThread[],
  rowStatus: PluginSidebarThreadRowStatus | null,
): HiddenThreadsStatus {
  const hasUnsubmittedDraft = useThreadsHaveDraft(threads);
  return useMemo(() => {
    const activity = getCollapsedChildActivity(threads);
    const indicator = resolveThreadListIndicator({
      hasPendingInteraction: activity.pending,
      hasTerminalAttention: activity.terminalAttention,
      hasUnsubmittedDraft,
      hasUnreadError: activity.unreadError,
      hasUnreadSuccess: activity.unread,
      isAutomationWoken: false,
      isBackgroundAgentActive: activity.backgroundAgent,
      isBackgroundCommandActive: activity.backgroundCommand,
      isGoalActive: activity.goal,
      isActivityUnreported: false,
      queuedFailedCount: 0,
      queuedWork: "none",
      isPlanModeActive: activity.planMode,
      isRuntimeActive: activity.runtimeWorking,
      isWorkflowActive: activity.workflow,
    });
    return {
      indicator,
      rowStatus,
      isWorking: activity.working || rowStatus?.tone === "running",
    };
  }, [hasUnsubmittedDraft, rowStatus, threads]);
}
