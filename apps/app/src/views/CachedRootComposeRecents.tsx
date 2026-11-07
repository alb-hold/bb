import { useAtomValue } from "jotai";
import type { SidebarBootstrapResponse } from "@bb/server-contract";
import { getSidebarThreadRowPaddingLeft } from "@bb/shared-ui/sidebar-row-classes";
import { resolveThreadListIndicator } from "@bb/client-core";
import {
  getMobileRecentThreads,
  getFirstPaintMobileRecentRowCount,
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
import { mobileRecentsCollapsedThreadIdsAtom } from "./mobile-recents-collapse";
import {
  providerListCacheKey,
  readCachedProviderList,
} from "@/lib/provider-list-cache";
import {
  environmentProviderListCacheKey,
  readCachedEnvironmentProviderList,
} from "@/lib/environment-provider-list-cache";
import { findEnvironmentDisplayProvider } from "@/lib/environment-workspace-display";
import { isProjectlessProjectId } from "@/lib/route-paths";
import { usePromptDraftInputThreadIds } from "@/hooks/usePromptDraftStorage";

export function CachedRootComposeRecents({
  navigation,
  maxRows,
}: {
  navigation: SidebarBootstrapResponse;
  maxRows?: number;
}) {
  const collapsedIds = useAtomValue(mobileRecentsCollapsedThreadIdsAtom);
  const projects = [...navigation.projects, navigation.personalProject];
  const projectNames = new Map(
    projects.map((project) => [project.id, project.name]),
  );
  const threads = projects
    .flatMap((project) => project.threads)
    .filter(
      (thread) => thread.archivedAt === null && thread.deletedAt === null,
    );
  const now = Date.now();
  const draftThreadIds = usePromptDraftInputThreadIds(threads);
  const rows = getMobileRecentThreads({
    threads,
    collapsedThreadIds: new Set(collapsedIds),
    draftThreadIds,
    now,
  }).slice(0, maxRows ?? getFirstPaintMobileRecentRowCount());
  const providers =
    readCachedProviderList(
      providerListCacheKey({ environmentId: null, hostId: null }),
    ) ?? [];
  const environmentProviders =
    readCachedEnvironmentProviderList(
      environmentProviderListCacheKey({ projectId: null, hostId: null }),
    ) ?? undefined;
  if (rows.length === 0) return null;
  return (
    <div aria-hidden="true" inert>
      <RecentThreadsSection>
        <ul className="space-y-px">
          {rows.map((row) => {
            const { thread, depth } = row;
            const { indicatorState: state, trailingIndicatorState } =
              recentThreadRowIndicatorState(row, now);
            return (
              <li
                key={thread.id}
                className={RECENT_THREAD_ROW_CLASS}
                style={{ paddingLeft: getSidebarThreadRowPaddingLeft(depth) }}
              >
                {row.hasChildren ? (
                  <span className={RECENT_THREAD_COLLAPSE_CLASS}>
                    <RecentThreadCollapseMark
                      depth={depth}
                      isCollapsed={row.isCollapsed}
                    >
                      <RecentThreadProviderMark
                        thread={thread}
                        depth={depth}
                        provider={
                          providers.find(
                            (provider) => provider.id === thread.providerId,
                          ) ?? null
                        }
                      />
                    </RecentThreadCollapseMark>
                  </span>
                ) : (
                  <RecentThreadProviderMark
                    thread={thread}
                    depth={depth}
                    provider={
                      providers.find(
                        (provider) => provider.id === thread.providerId,
                      ) ?? null
                    }
                  />
                )}
                <span className={RECENT_THREAD_BODY_CLASS}>
                  <RecentThreadRowContent
                    thread={thread}
                    projectName={
                      isProjectlessProjectId(thread.projectId)
                        ? null
                        : (projectNames.get(thread.projectId) ?? null)
                    }
                    environmentProviderLookup={findEnvironmentDisplayProvider(
                      environmentProviders,
                      thread.environmentProviderId,
                    )}
                    indicatorKind={resolveThreadListIndicator(
                      trailingIndicatorState,
                    )}
                    queuedFailedCount={state.queuedFailedCount}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      </RecentThreadsSection>
    </div>
  );
}
