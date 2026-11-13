import type { ThreadListEntry } from "@bb/domain";
import {
  buildChronologicalThreadList,
  getProjectThreadItemDescendants,
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
  hiddenThreads: readonly ThreadListEntry[];
  hiddenThreadsHaveDraft: boolean;
  hasChildren: boolean;
  isCollapsed: boolean;
}

function flattenMobileRecentNodes({
  collapsedThreadIds,
  draftThreadIds,
  items,
  rows,
}: {
  collapsedThreadIds: ReadonlySet<string>;
  draftThreadIds: ReadonlySet<string>;
  items: readonly ProjectThreadItem[];
  rows: MobileRecentThreadRow[];
}): void {
  for (const { node } of items) {
    const hasChildren = node.children.length > 0;
    const isCollapsed = hasChildren && collapsedThreadIds.has(node.thread.id);
    rows.push({
      thread: node.thread,
      depth: node.depth,
      childActivity: node.stats.childActivity,
      hiddenThreads: isCollapsed
        ? getProjectThreadItemDescendants(node.children)
        : [],
      hiddenThreadsHaveDraft:
        isCollapsed &&
        getProjectThreadItemDescendants(node.children).some((thread) =>
          draftThreadIds.has(thread.id),
        ),
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
  });
  return rows;
}
