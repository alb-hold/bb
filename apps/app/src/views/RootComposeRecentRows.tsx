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
import { OverflowFade } from "@bb/shared-ui/overflow-fade";
import { formatCompactRelativeTime } from "@bb/shared-ui/info-list-row";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { ThreadTitle } from "@/components/thread/ThreadTitleMentions";
import { ThreadModeGlyph } from "@bb/shared-ui/thread-mode-glyph";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { ProviderIconMark } from "@/components/settings/ProviderIconMark";
import { ThreadStatusGlyph } from "@/components/thread/ThreadStatusGlyph";
import type { ThreadListIndicatorKind } from "@bb/client-core";

export const RECENT_THREAD_ROW_CLASS =
  "flex select-none items-center gap-2.5 rounded-md pr-2 h-13";
export const RECENT_THREAD_BODY_CLASS =
  "flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring h-13";
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
      {ProviderMark === undefined ? null : provider === null ? (
        <ProviderMark className="size-4" />
      ) : (
        <ProviderIconMark
          provider={provider}
          icon={ProviderMark}
          className="size-4"
        />
      )}
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
            className={cn("font-medium", COARSE_POINTER_TEXT_BASE_CLASS)}
          />
        </span>
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs leading-4",
          )}
          title={metadataText}
        >
          <ThreadModeGlyph nativeTerminal={thread.nativeTerminal === true} isWorktree={thread.environmentIsWorktree === true} />
          <span className="flex min-w-0 flex-1 items-center whitespace-nowrap">
            <span
              className={cn(
                "grid min-w-0",
                metadata.project !== null && metadata.branch !== null
                  ? "grid-cols-[minmax(0,max-content)_auto_minmax(min-content,1fr)]"
                  : "grid-cols-[minmax(0,1fr)]",
              )}
            >
              {metadata.project !== null ? (
                <span className="min-w-0">
                  <span className="block shrink-0 overflow-hidden text-ellipsis">
                    {metadata.project}
                  </span>
                </span>
              ) : null}
              {metadata.project !== null && metadata.branch !== null ? (
                <span className="shrink-0 whitespace-pre">{" \u00b7 "}</span>
              ) : null}
              {metadata.branch !== null ? (
                <span
                  className="grid min-w-min before:invisible before:col-start-1 before:row-start-1 before:content-[attr(data-branch-minimum)]"
                  data-branch-minimum={
                    metadata.branch.length <= 7
                      ? metadata.branch
                      : `${metadata.branch.slice(0, 6)}…`
                  }
                >
                  <span className="col-start-1 row-start-1 min-w-0 truncate">
                    {metadata.branch}
                  </span>
                </span>
              ) : null}
            </span>
            {metadata.project !== null || metadata.branch !== null ? (
              <span className="shrink-0 whitespace-pre">{" \u00b7 "}</span>
            ) : null}
            <span className="shrink-0">{metadata.age}</span>
          </span>
        </span>
      </span>
      {indicatorKind !== "none" ? (
        <span className="flex size-6 shrink-0 items-center justify-center">
          <ThreadStatusGlyph
            indicator={indicatorKind}
            experimental_queuedFailedCount={queuedFailedCount}
          />
        </span>
      ) : null}
    </>
  );
}
export function RecentThreadsSection({ children }: { children: ReactNode }) {
  return (
    <section
      data-root-compose-mobile-recents=""
      aria-labelledby="root-compose-mobile-recents"
    >
      <div className="sticky top-0 z-10 bg-background px-2 py-1">
        <h2
          id="root-compose-mobile-recents"
          className={cn(CHROME_SECTION_LABEL_CLASS, "text-subtle-foreground")}
        >
          Recent
        </h2>
        <OverflowFade placement="below" tone="background" />
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
