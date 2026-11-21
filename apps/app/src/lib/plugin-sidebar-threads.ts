import type { ThreadListEntry } from "@bb/domain";
import type {
  PluginSidebarThread,
  PluginSidebarThreadActivity,
  PluginThreadStatusThread,
} from "@get-bb/plugin-sdk";
import {
  getThreadListIndicatorLabel,
  isThreadRead,
  resolveThreadListIndicator,
  threadListIndicatorStateForThread,
} from "@bb/client-core";
import { withEffectiveDisplayStatus } from "@bb/domain";
import {
  isNativeActivityUnconfirmed,
  nativeActivityEvidenceKind,
} from "@bb/client-core";
import {
  EMPTY_TITLE_MENTION_RESOURCES,
  resolveThreadTitleDisplayText,
  type ThreadTitleMentionResources,
} from "@/components/thread/ThreadTitleMentions";
import { getThreadDisplayTitle } from "./thread-title";
import { getThreadRoutePath } from "./route-paths";

type PluginSidebarThreadActivityWithRetiredGoals = PluginSidebarThreadActivity;

export function toThreadStatusThread(
  entry: ThreadListEntry,
  now = Date.now(),
): PluginThreadStatusThread {
  const nativeActivityUnconfirmed = isNativeActivityUnconfirmed(
    entry.runtime,
    now,
  );
  const activity: PluginSidebarThreadActivityWithRetiredGoals = {
    workflows: entry.activity.activeWorkflowCount,
    backgroundAgents: entry.activity.activeBackgroundAgentCount,
    backgroundCommands: entry.activity.activeBackgroundCommandCount,
    planMode: entry.activity.activePlanModeCount,
    goals: entry.activity.activeGoalCount,
  };
  return {
    status: entry.status,
    runtimeStatus: nativeActivityUnconfirmed
      ? "idle"
      : entry.runtime.displayStatus,
    queuedWork: entry.queuedWork,
    hasPendingInteraction: entry.hasPendingInteraction,
    activity,
    isUnread: !isThreadRead(entry),
    parentThreadId: entry.parentThreadId,
  };
}

export function toPluginSidebarThread(
  entry: ThreadListEntry,
  hostNamesById: ReadonlyMap<string, string> = new Map(),
  titleResources: ThreadTitleMentionResources = EMPTY_TITLE_MENTION_RESOURCES,
  now = Date.now(),
  nativeActivityUnconfirmed = isNativeActivityUnconfirmed(entry.runtime, now),
): PluginSidebarThread {
  entry = withEffectiveDisplayStatus(entry);
  const statusThread = toThreadStatusThread(entry, now);
  const indicatorState = threadListIndicatorStateForThread(
    entry,
    false,
    now,
    nativeActivityUnconfirmed,
  );
  const forkIndicator = resolveThreadListIndicator({
    ...indicatorState,
    isAutomationWoken:
      indicatorState.isAutomationWoken || entry.listIndicator === "woke",
  });
  const indicatorLabel = getThreadListIndicatorLabel(
    forkIndicator,
    entry.queuedFailedCount,
  );

  return {
    ...statusThread,
    experimental_queuedFailedCount: entry.queuedFailedCount,
    id: entry.id,
    projectId: entry.projectId,
    title: entry.title,
    titleFallback: entry.titleFallback,
    displayTitle: resolveThreadTitleDisplayText(
      getThreadDisplayTitle(entry),
      titleResources,
    ),
    parentNotifications: entry.parentNotifications,
    lifecycleOwnerThreadId: entry.lifecycleOwnerThreadId,
    sourceThreadId: entry.sourceThreadId,
    sectionId: entry.sectionId,
    originKind: entry.originKind,
    originPluginId: entry.originPluginId,
    providerId: entry.providerId,
    status: entry.status,
    experimental_rowState: entry.rowState,
    runtimeStatus: entry.runtime.displayStatus,
    experimental_nativeTerminal: entry.nativeTerminal === true,
    ...(entry.runtime.nativeActivity === undefined
      ? {}
      : {
          experimental_nativeActivity: {
            ...entry.runtime.nativeActivity,
            confirmation: nativeActivityUnconfirmed
              ? "unconfirmed"
              : "confirmed",
            evidenceKind: nativeActivityEvidenceKind(
              entry.runtime,
              now,
              nativeActivityUnconfirmed,
            ),
          },
        }),
    indicator: forkIndicator,
    indicatorLabel,
    isPinned: entry.pinnedAt !== null,
    pinnedAt: entry.pinnedAt,
    pinSortKey: entry.pinSortKey,
    isArchived: entry.archivedAt !== null,
    archivedAt: entry.archivedAt,
    href: getThreadRoutePath({
      projectId: entry.projectId,
      threadId: entry.id,
    }),
    isHidden: entry.visibility === "hidden",
    environment:
      entry.environmentId === null
        ? null
        : {
            id: entry.environmentId,
            name: entry.environmentName,
            branchName: entry.environmentBranchName,
            path: entry.environmentPath,
            isWorktree: entry.environmentIsWorktree,
            providerId: entry.environmentProviderId,
            workspaceDisplayKind: entry.environmentWorkspaceDisplayKind,
          },
    host:
      entry.environmentHostId === null
        ? null
        : {
            id: entry.environmentHostId,
            name:
              hostNamesById.get(entry.environmentHostId) ??
              entry.environmentHostId,
          },
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastReadAt: entry.lastReadAt,
    latestAttentionAt: entry.latestAttentionAt,
  };
}
