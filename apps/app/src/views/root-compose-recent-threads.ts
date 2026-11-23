import type { ThreadListEntry } from "@bb/domain";
import type { SidebarBootstrapResponse } from "@bb/server-contract";
import {
  buildChronologicalThreadList,
  isThreadRead,
  type CollapsedChildActivity,
  type ProjectThreadItem,
} from "@bb/client-core";
type ThreadListEntryComparator = (
  left: ThreadListEntry,
  right: ThreadListEntry,
) => number;

interface GetMobileRecentThreadsArgs {
  collapsedThreadIds: ReadonlySet<string>;
  draftThreadIds: ReadonlySet<string>;
  threads: readonly ThreadListEntry[];
  now?: number;
  overview?: SidebarBootstrapResponse["overview"];
}

interface OffpageUnreadSummary {
  unread: boolean;
  unreadError: boolean;
}

function buildOffpageUnreadByAncestor(
  overview: SidebarBootstrapResponse["overview"],
): ReadonlyMap<string, OffpageUnreadSummary> {
  const result = new Map<string, OffpageUnreadSummary>();
  if (!overview?.unreadTree.length) return result;
  const byId = new Map(overview.unreadTree.map((entry) => [entry.id, entry]));
  for (const entry of overview.unreadTree) {
    if (isThreadRead(entry)) continue;
    const isError = entry.status === "error";
    let parentId = entry.parentThreadId;
    const visited = new Set<string>();
    while (parentId !== null && !visited.has(parentId)) {
      visited.add(parentId);
      const existing = result.get(parentId);
      result.set(parentId, {
        unread: true,
        unreadError: (existing?.unreadError ?? false) || isError,
      });
      parentId = byId.get(parentId)?.parentThreadId ?? null;
    }
  }
  return result;
}

const compareMobileRecentThreads: ThreadListEntryComparator = (left, right) => {
  const latestAttentionAtDelta =
    right.latestAttentionAt - left.latestAttentionAt;
  if (latestAttentionAtDelta !== 0) {
    return latestAttentionAtDelta;
  }

  const createdAtDelta = right.createdAt - left.createdAt;
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return left.id.localeCompare(right.id);
};

export interface MobileRecentThreadRow {
  thread: ThreadListEntry;
  depth: number;
  childActivity: CollapsedChildActivity;
  hasUnsubmittedDraft: boolean;
  hasChildren: boolean;
  isCollapsed: boolean;
}

function flattenMobileRecentNodes({
  collapsedThreadIds,
  draftThreadIds,
  items,
  rows,
  childCounts,
  offpageUnreadByAncestor,
}: {
  collapsedThreadIds: ReadonlySet<string>;
  draftThreadIds: ReadonlySet<string>;
  items: readonly ProjectThreadItem[];
  rows: MobileRecentThreadRow[];
  childCounts?: Readonly<Record<string, number>>;
  offpageUnreadByAncestor: ReadonlyMap<string, OffpageUnreadSummary>;
}): void {
  for (const { node } of items) {
    const offpageChildCount = childCounts?.[node.thread.id] ?? 0;
    const hasChildren = node.children.length > 0 || offpageChildCount > 0;
    const isCollapsed = hasChildren && collapsedThreadIds.has(node.thread.id);
    const offpageUnread = offpageUnreadByAncestor.get(node.thread.id);
    const childActivity =
      offpageUnread !== undefined
        ? {
            ...node.stats.childActivity,
            unread: node.stats.childActivity.unread || offpageUnread.unread,
            unreadError:
              node.stats.childActivity.unreadError || offpageUnread.unreadError,
          }
        : node.stats.childActivity;
    rows.push({
      thread: node.thread,
      depth: node.depth,
      childActivity,
      hasUnsubmittedDraft: draftThreadIds.has(node.thread.id),
      hasChildren,
      isCollapsed,
    });
    if (hasChildren && !isCollapsed) {
      flattenMobileRecentNodes({
        collapsedThreadIds,
        draftThreadIds,
        items: node.children,
        rows,
        childCounts,
        offpageUnreadByAncestor,
      });
    }
  }
}

export function getMobileRecentAncestorIds({
  threadId,
  threads,
}: {
  threadId: string;
  threads: readonly ThreadListEntry[];
}): string[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const selected = byId.get(threadId);
  if (selected === undefined || selected.visibility === "hidden") {
    return [];
  }

  const ancestorIds: string[] = [];
  let current: ThreadListEntry | undefined = selected;
  let remainingHops = byId.size;
  while (current !== undefined && remainingHops > 0) {
    const parentThreadId: string | null = current.parentThreadId;
    if (parentThreadId === null) break;
    const parent = byId.get(parentThreadId);
    if (parent === undefined) break;
    ancestorIds.push(parent.id);
    current = parent;
    remainingHops -= 1;
  }
  return ancestorIds;
}

export function getFirstPaintMobileRecentRowCount(): number {
  return typeof window === "undefined"
    ? 6
    : Math.ceil(window.innerHeight / 52) + 1;
}

export function getMobileRecentThreads({
  collapsedThreadIds,
  draftThreadIds,
  threads,
  now,
  overview,
}: GetMobileRecentThreadsArgs): MobileRecentThreadRow[] {
  const rows: MobileRecentThreadRow[] = [];
  flattenMobileRecentNodes({
    collapsedThreadIds,
    draftThreadIds,
    items: buildChronologicalThreadList(
      threads,
      compareMobileRecentThreads,
      draftThreadIds,
      now,
    ),
    rows,
    childCounts: overview?.childCounts,
    offpageUnreadByAncestor: buildOffpageUnreadByAncestor(overview),
  });
  return rows;
}
