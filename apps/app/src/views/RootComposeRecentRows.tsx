import { ThreadRowMetadata } from "@bb/shared-ui/thread-row-metadata";
import {
  threadListIndicatorStateForThread,
  type ThreadListIndicatorState,
} from "@bb/client-core";
import type { MobileRecentThreadRow } from "./root-compose-recent-threads";
import type { ReactNode } from "react";
import type { ProviderInfo, ThreadListEntry } from "@bb/domain";
import type { EnvironmentDisplayProviderLookup } from "@bb/core-ui";
import { resolveEnvironmentDisplayName } from "@bb/core-ui";
import { cn } from "@bb/shared-ui/lib/utils";
import { CHROME_SECTION_LABEL_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { COARSE_POINTER_TEXT_BASE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { formatCompactRelativeTime } from "@/lib/relative-time";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { ThreadTitle } from "@/components/thread/ThreadTitleMentions";
import { ThreadLeadingMark } from "@bb/shared-ui/thread-mode-glyph";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { ThreadStatusGlyph } from "@/components/thread/ThreadStatusGlyph";
import type { ThreadListIndicatorKind } from "@bb/client-core";

export const RECENT_THREAD_ROW_CLASS =
  "flex select-none items-center gap-2.5 rounded-md pr-2 h-13 md:h-10";
export const RECENT_THREAD_BODY_CLASS =
  "flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring h-13 md:h-10";
function repeatsProjectName(
  workspaceName: string,
  projectName: string | null,
): boolean {
  return (
    projectName !== null &&
    (workspaceName === projectName ||
      workspaceName.startsWith(`${projectName} `))
  );
}

function getMobileRecentThreadMetadata({
  environmentProviderLookup,
  projectName,
  thread,
}: {
  environmentProviderLookup: EnvironmentDisplayProviderLookup;
  projectName: string | null;
  thread: ThreadListEntry;
}): { project: string | null; branch: string | null; age: string } {
  const workspaceName = resolveEnvironmentDisplayName(
    {
      name: thread.environmentName,
      branchName: thread.environmentBranchName,
      path: thread.environmentPath,
      environmentProviderId: thread.environmentProviderId,
    },
    environmentProviderLookup,
  );
  return {
    project: projectName || null,
    branch:
      workspaceName !== null && repeatsProjectName(workspaceName, projectName)
        ? null
        : workspaceName || null,
    age: formatCompactRelativeTime({
      timestamp: thread.latestAttentionAt,
      now: Date.now(),
    }),
  };
}

export function RecentThreadProviderMark({
  thread,
  provider,
  depth,
}: {
  thread: ThreadListEntry;
  provider: ProviderInfo | null;
  depth: number;
}) {
  const providerIcon = getProviderIconInfo(
    "agent",
    thread.providerId,
    provider,
  );
  const ProviderMark = providerIcon?.icon;
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center text-muted-foreground",
        depth > 0 && "opacity-60",
      )}
    >
      <ThreadLeadingMark
        nativeTerminal={thread.nativeTerminal === true}
        isWorktree={
          thread.environmentIsWorktree === true &&
          thread.nativeTerminal !== true
        }
        providerName={provider?.displayName ?? null}
      >
        {ProviderMark === undefined ? null : (
          <ProviderMark className="size-4" />
        )}
      </ThreadLeadingMark>
    </span>
  );
}
export function RecentThreadRowContent({
  thread,
  projectName,
  environmentProviderLookup,
  indicatorKind,
  queuedFailedCount,
}: {
  thread: ThreadListEntry;
  projectName: string | null;
  environmentProviderLookup: EnvironmentDisplayProviderLookup;
  indicatorKind: ThreadListIndicatorKind;
  queuedFailedCount: number;
}) {
  const metadata = getMobileRecentThreadMetadata({
    environmentProviderLookup,
    projectName,
    thread,
  });
  const metadataText = [metadata.project, metadata.branch, metadata.age]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ");
  return (
    <>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <ThreadTitle
            title={getThreadDisplayTitle(thread)}
            className={cn("font-normal", COARSE_POINTER_TEXT_BASE_CLASS)}
          />
        </span>
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-subtle-foreground text-xs leading-4",
          )}
          title={metadataText}
        >
          <ThreadRowMetadata
            project={metadata.project}
            branch={metadata.branch}
            age={metadata.age}
          />
        </span>
      </span>
      <span
        className="flex size-6 shrink-0 items-center justify-center"
        data-recent-status-slot=""
      >
        {indicatorKind !== "none" ? (
          <ThreadStatusGlyph
            indicator={indicatorKind}
            experimental_queuedFailedCount={queuedFailedCount}
          />
        ) : null}
      </span>
    </>
  );
}
export function RecentThreadsSection({ children }: { children: ReactNode }) {
  return (
    <section
      data-root-compose-mobile-recents=""
      aria-labelledby="root-compose-mobile-recents"
    >
      <div className="sticky top-0 z-10 bg-background px-2 pt-1 pb-2">
        <h2
          id="root-compose-mobile-recents"
          className={cn(CHROME_SECTION_LABEL_CLASS, "text-subtle-foreground")}
        >
          Recent
        </h2>
      </div>
      {children}
    </section>
  );
}

export function recentThreadRowIndicatorState(
  row: MobileRecentThreadRow,
  now: number,
) {
  const {
    thread,
    hasUnsubmittedDraft,
    hasChildren,
    isCollapsed,
    childActivity,
  } = row;
  const indicatorState: ThreadListIndicatorState =
    threadListIndicatorStateForThread(thread, hasUnsubmittedDraft, now);
  const hasHiddenChildren = hasChildren && isCollapsed;
  const trailingIndicatorState: ThreadListIndicatorState = hasHiddenChildren
    ? {
        hasPendingInteraction:
          indicatorState.hasPendingInteraction || childActivity.pending,
        isActivityUnreported: indicatorState.isActivityUnreported,
        queuedFailedCount: indicatorState.queuedFailedCount,
        hasUnsubmittedDraft:
          indicatorState.hasUnsubmittedDraft ||
          childActivity.hasUnsubmittedDraft,
        hasUnreadError:
          indicatorState.hasUnreadError || childActivity.unreadError,
        hasUnreadSuccess:
          indicatorState.hasUnreadSuccess ||
          (childActivity.unread && !childActivity.unreadError),
        isBackgroundAgentActive:
          indicatorState.isBackgroundAgentActive ||
          childActivity.backgroundAgent,
        isBackgroundCommandActive:
          indicatorState.isBackgroundCommandActive ||
          childActivity.backgroundCommand,
        isGoalActive: indicatorState.isGoalActive || childActivity.goal,
        queuedWork: indicatorState.queuedWork,
        isPlanModeActive:
          indicatorState.isPlanModeActive || childActivity.planMode,
        isRuntimeActive:
          indicatorState.isRuntimeActive || childActivity.runtimeWorking,
        isWorkflowActive:
          indicatorState.isWorkflowActive || childActivity.workflow,
        isAutomationWoken: indicatorState.isAutomationWoken,
      }
    : indicatorState;
  return { indicatorState, trailingIndicatorState };
}

export const RECENT_THREAD_COLLAPSE_CLASS =
  "group relative -ml-6 flex h-11 w-13 shrink-0 cursor-pointer items-center rounded-md pl-6 outline-none";
export function RecentThreadCollapseMark({
  depth,
  isCollapsed,
  children,
}: {
  depth: number;
  isCollapsed: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <Icon
        name="ChevronRight"
        className={cn(
          "absolute left-2 size-3 text-subtle-foreground transition-transform duration-150 group-hover:text-muted-foreground group-focus-visible:text-muted-foreground",
          !isCollapsed && "rotate-90",
          depth > 0 && "opacity-60",
        )}
        aria-hidden="true"
      />
      {children}
    </>
  );
}
