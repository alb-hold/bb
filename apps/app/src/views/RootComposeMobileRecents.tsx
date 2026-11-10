import {
  getMobileRecentThreads,
  getMobileRecentAncestorIds,
  getFirstPaintMobileRecentRowCount,
  type MobileRecentThreadRow,
} from "./root-compose-recent-threads";
export {
  getMobileRecentThreads,
  getMobileRecentAncestorIds,
} from "./root-compose-recent-threads";
import {
  RecentThreadProviderMark,
  RecentThreadCollapseMark,
  RECENT_THREAD_COLLAPSE_CLASS,
  recentThreadRowIndicatorState,
  RecentThreadRowContent,
  RecentThreadsSection,
  RECENT_THREAD_ROW_CLASS,
  RECENT_THREAD_BODY_CLASS,
} from "./RootComposeRecentRows";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useAtom } from "jotai";
import type { ProviderInfo, ThreadListEntry } from "@bb/domain";
import { RouteAnchor } from "@/components/ui/app-route-anchor";
import { ThreadActionsContextMenu } from "@/components/thread/ThreadActionsMenu";
import { threadListEntryActionTarget } from "@/lib/thread-actions/thread-action-target";
import { getSidebarThreadRowPaddingLeft } from "@bb/shared-ui/sidebar-row-classes";
import { SIDEBAR_WORKING_STATUS_COLOR_CLASS } from "@bb/shared-ui/sidebar-row-classes";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { getThreadRoutePath, isProjectlessProjectId } from "@/lib/route-paths";
import {
  getThreadListIndicatorLabel,
  resolveThreadListIndicator,
} from "@bb/client-core";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { useThreadTitleDisplayText } from "@/components/thread/ThreadTitleMentions";
import { findEnvironmentDisplayProvider } from "@/lib/environment-workspace-display";
import { useSystemEnvironmentProviders } from "@/hooks/queries/environment-provider-queries";
import { cn } from "@bb/shared-ui/lib/utils";
import { usePromptDraftInputThreadIds } from "@/hooks/usePromptDraftStorage";
import { useSecondTick } from "@/hooks/useSecondTick";
import { mobileRecentsCollapsedThreadIdsAtom } from "./mobile-recents-collapse";

const MOBILE_RECENT_ROW_HEIGHT_CLASS = "h-13";

interface MobileRecentThreadRowProps {
  highlighted: boolean;
  onToggleCollapsed: (threadId: string) => void;
  projectName: string | null;
  provider: ProviderInfo | null;
  row: MobileRecentThreadRow;
  now: number;
}

interface RootComposeMobileRecentsProps {
  maxRows?: number;
  highlightedThreadId: string | null;
  projectNamesById: ReadonlyMap<string, string>;
  providersById: ReadonlyMap<string, ProviderInfo>;
  showCreatingRow: boolean;
  threads: readonly ThreadListEntry[];
}

function MobileRecentThreadRow({
  highlighted,
  onToggleCollapsed,
  projectName,
  provider,
  row,
  now,
}: MobileRecentThreadRowProps) {
  const { thread, depth, hasChildren, isCollapsed } = row;
  const touchStartedBeforeLink = useRef(false);
  const { providers: environmentProviders } = useSystemEnvironmentProviders();
  const threadTitle = useThreadTitleDisplayText(getThreadDisplayTitle(thread));
  const { indicatorState, trailingIndicatorState } =
    recentThreadRowIndicatorState(row, now);
  const indicatorKind = resolveThreadListIndicator(trailingIndicatorState);
  const indicatorLabel = getThreadListIndicatorLabel(
    indicatorKind,
    indicatorState.queuedFailedCount,
  );
  const environmentProviderLookup = findEnvironmentDisplayProvider(
    environmentProviders,
    thread.environmentProviderId,
  );
  const providerTile = (
    <RecentThreadProviderMark
      thread={thread}
      provider={provider}
      depth={depth}
    />
  );
  return (
    <ThreadActionsContextMenu thread={threadListEntryActionTarget(thread)}>
      <li
        onTouchStart={(event) => {
          const touch = event.touches[0];
          const link = event.currentTarget.querySelector("a");
          touchStartedBeforeLink.current =
            hasChildren &&
            touch !== undefined &&
            link !== null &&
            touch.clientX < link.getBoundingClientRect().left;
        }}
        style={{ paddingLeft: getSidebarThreadRowPaddingLeft(depth) }}
        className={cn(
          RECENT_THREAD_ROW_CLASS,
          highlighted && "bg-surface-selected",
        )}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-expanded={!isCollapsed}
            aria-label={
              isCollapsed
                ? `Show threads under ${threadTitle}`
                : `Hide threads under ${threadTitle}`
            }
            className={RECENT_THREAD_COLLAPSE_CLASS}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleCollapsed(thread.id);
            }}
          >
            <RecentThreadCollapseMark isCollapsed={isCollapsed} depth={depth}>
              {providerTile}
            </RecentThreadCollapseMark>
          </button>
        ) : (
          providerTile
        )}
        <RouteAnchor
          href={getThreadRoutePath({
            projectId: thread.projectId,
            threadId: thread.id,
          })}
          aria-label={`Open ${threadTitle}${indicatorLabel ? ` — ${indicatorLabel}` : ""}`}
          onClick={(event) => {
            const ignoreTouchClick = touchStartedBeforeLink.current;
            touchStartedBeforeLink.current = false;
            if (event.detail > 0 && ignoreTouchClick) {
              event.preventDefault();
            }
          }}
          className={RECENT_THREAD_BODY_CLASS}
        >
          <RecentThreadRowContent
            thread={thread}
            projectName={projectName}
            environmentProviderLookup={environmentProviderLookup}
            indicatorKind={indicatorKind}
            queuedFailedCount={indicatorState.queuedFailedCount}
          />
        </RouteAnchor>
      </li>
    </ThreadActionsContextMenu>
  );
}

export function RootComposeMobileRecents({
  maxRows,
  highlightedThreadId,
  projectNamesById,
  providersById,
  showCreatingRow,
  threads,
}: RootComposeMobileRecentsProps) {
  const [collapsedThreadIdList, setCollapsedThreadIdList] = useAtom(
    mobileRecentsCollapsedThreadIdsAtom,
  );
  const collapsedThreadIds = useMemo(
    () => new Set(collapsedThreadIdList),
    [collapsedThreadIdList],
  );
  const draftThreadIds = usePromptDraftInputThreadIds(threads);
  const activityNow = useSecondTick(
    threads.some((thread) => thread.runtime.nativeActivity !== undefined),
  );
  const toggleCollapsed = useCallback(
    (threadId: string) => {
      setCollapsedThreadIdList((current) =>
        current.includes(threadId)
          ? current.filter((id) => id !== threadId)
          : [...current, threadId],
      );
    },
    [setCollapsedThreadIdList],
  );
  useEffect(() => {
    if (highlightedThreadId === null) return;
    const ancestorIds = getMobileRecentAncestorIds({
      threadId: highlightedThreadId,
      threads,
    });
    if (ancestorIds.length === 0) return;
    setCollapsedThreadIdList((current) => {
      const next = current.filter((id) => !ancestorIds.includes(id));
      return next.length === current.length ? current : next;
    });
  }, [highlightedThreadId, setCollapsedThreadIdList, threads]);
  const recentThreads = useMemo(
    () =>
      getMobileRecentThreads({
        collapsedThreadIds,
        draftThreadIds,
        now: activityNow,
        threads,
      }),
    [activityNow, collapsedThreadIds, draftThreadIds, threads],
  );
  const hasMountedAllRows = useDeferredValue(true, false);
  const renderedThreads = hasMountedAllRows
    ? recentThreads.slice(0, maxRows)
    : recentThreads.slice(0, maxRows ?? getFirstPaintMobileRecentRowCount());

  if (!showCreatingRow && recentThreads.length === 0) {
    return null;
  }

  return (
    <RecentThreadsSection>
      {showCreatingRow ? (
        <div
          role="status"
          className={cn(
            "flex items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground",
            MOBILE_RECENT_ROW_HEIGHT_CLASS,
          )}
        >
          <span className="min-w-0 flex-1 truncate">Creating thread</span>
          <span className="flex size-6 shrink-0 items-center justify-center">
            <Icon
              name="Loading"
              className={cn(
                "shrink-0 animate-spin",
                SIDEBAR_WORKING_STATUS_COLOR_CLASS,
                COARSE_POINTER_ICON_SIZE_CLASS,
              )}
              aria-hidden="true"
            />
          </span>
        </div>
      ) : null}
      {recentThreads.length > 0 ? (
        <ul className="space-y-px">
          {renderedThreads.map((row) => (
            <MobileRecentThreadRow
              key={row.thread.id}
              highlighted={row.thread.id === highlightedThreadId}
              onToggleCollapsed={toggleCollapsed}
              provider={providersById.get(row.thread.providerId) ?? null}
              projectName={
                isProjectlessProjectId(row.thread.projectId)
                  ? null
                  : (projectNamesById.get(row.thread.projectId) ?? null)
              }
              row={row}
              now={activityNow}
            />
          ))}
        </ul>
      ) : null}
    </RecentThreadsSection>
  );
}
