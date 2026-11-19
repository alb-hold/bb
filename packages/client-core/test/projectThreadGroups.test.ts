import type { ThreadListEntry } from "@bb/domain";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  buildChronologicalThreadList,
  getProjectThreadItemDescendants,
  type ProjectThreadItem,
  type ProjectThreadNode,
  type ThreadComparator,
} from "../src/sidebar/projectThreadGroups.js";

type ThreadListEntryOverrides = Partial<ThreadListEntry>;
type TreeSummary = string | { id: string; children: TreeSummary[] };

const compareByAttentionDescending: ThreadComparator = (left, right) =>
  right.latestAttentionAt - left.latestAttentionAt;

function buildList(threads: readonly ThreadListEntry[]): ProjectThreadItem[] {
  return buildChronologicalThreadList(threads, compareByAttentionDescending);
}

function createThread(
  overrides: ThreadListEntryOverrides = {},
): ThreadListEntry {
  return makeThreadListEntry({
    id: "thr_1",
    projectId: "proj_1",
    title: "Thread",
    titleFallback: "Thread",
    lastReadAt: 0,
    latestAttentionAt: 2,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });
}

function summarizeNode(node: ProjectThreadNode): TreeSummary {
  if (node.children.length === 0) {
    return node.thread.id;
  }

  return {
    id: node.thread.id,
    children: summarizeItems(node.children),
  };
}

function summarizeItems(items: readonly ProjectThreadItem[]): TreeSummary[] {
  return items.map((item) => summarizeNode(item.node));
}

function findNode(
  items: readonly ProjectThreadItem[],
  threadId: string,
): ProjectThreadNode | null {
  for (const { node } of items) {
    if (node.thread.id === threadId) {
      return node;
    }
    const childNode = findNode(node.children, threadId);
    if (childNode) {
      return childNode;
    }
  }

  return null;
}

describe("buildChronologicalThreadList", () => {
  it("expires collapsed native child activity at the shared freshness boundary", () => {
    const parent = createThread({ id: "parent" });
    const child = createThread({
      id: "native-child",
      parentThreadId: parent.id,
      status: "active",
      runtime: {
        displayStatus: "active",
        nativeActivity: {
          lastEvidenceAt: 1_000_000,
          freshForMs: 90_000,
          confirmation: "confirmed",
          evidenceKind: "holder-report",
        },
      },
    });
    vi.useFakeTimers();
    let atBoundary: ProjectThreadItem[];
    let afterBoundary: ProjectThreadItem[];
    try {
      vi.setSystemTime(1_090_000);
      atBoundary = buildChronologicalThreadList(
        [parent, child],
        compareByAttentionDescending,
        new Set(),
        1_090_000,
      );
      vi.setSystemTime(1_090_001);
      afterBoundary = buildChronologicalThreadList(
        [parent, child],
        compareByAttentionDescending,
        new Set(),
        1_090_001,
      );
    } finally {
      vi.useRealTimers();
    }

    expect(
      findNode(atBoundary, parent.id)?.stats.childActivity.runtimeWorking,
    ).toBe(true);
    expect(
      findNode(afterBoundary, parent.id)?.stats.childActivity.runtimeWorking,
    ).toBe(false);
  });

  it("nests threads recursively from parentThreadId regardless of thread type", () => {
    const rootItems = buildList([
      createThread({
        id: "manager-root",
        createdAt: 10,
      }),
      createThread({
        id: "standard-child",
        parentThreadId: "manager-root",
        createdAt: 20,
      }),
      createThread({
        id: "standard-grandchild",
        parentThreadId: "standard-child",
        createdAt: 30,
      }),
      createThread({
        id: "manager-grandchild",
        parentThreadId: "standard-grandchild",
        createdAt: 40,
      }),
    ]);

    expect(summarizeItems(rootItems)).toEqual([
      {
        id: "manager-root",
        children: [
          {
            id: "standard-child",
            children: [
              {
                id: "standard-grandchild",
                children: ["manager-grandchild"],
              },
            ],
          },
        ],
      },
    ]);
    expect(findNode(rootItems, "manager-grandchild")?.depth).toBe(3);
  });

  it("renders forks as roots and excludes side chats", () => {
    const rootItems = buildList([
      createThread({
        id: "thr_parent",
        createdAt: 10,
        latestAttentionAt: 30,
      }),
      createThread({
        id: "thr_fork",
        sourceThreadId: "thr_parent",
        originKind: "fork",
        createdAt: 20,
        latestAttentionAt: 20,
      }),
      createThread({
        id: "thr_sidechat",
        sourceThreadId: "thr_parent",
        visibility: "hidden",
        createdAt: 30,
        latestAttentionAt: 40,
      }),
    ]);

    expect(summarizeItems(rootItems)).toEqual(["thr_parent", "thr_fork"]);
    expect(findNode(rootItems, "thr_parent")?.children).toEqual([]);
    expect(findNode(rootItems, "thr_fork")?.depth).toBe(0);
    expect(findNode(rootItems, "thr_sidechat")).toBeNull();
  });

  it("keeps orphaned children as project roots", () => {
    const rootItems = buildList([
      createThread({
        id: "orphan-child",
        parentThreadId: "missing-parent",
        createdAt: 20,
        latestAttentionAt: 20,
      }),
      createThread({
        id: "root-thread",
        createdAt: 10,
        latestAttentionAt: 10,
      }),
    ]);

    expect(summarizeItems(rootItems)).toEqual(["orphan-child", "root-thread"]);
  });

  it("cuts cycles without duplicating or dropping every cycle member", () => {
    const rootItems = buildList([
      createThread({
        id: "cycle-a",
        parentThreadId: "cycle-b",
        createdAt: 10,
      }),
      createThread({
        id: "cycle-b",
        parentThreadId: "cycle-a",
        createdAt: 20,
      }),
    ]);

    expect(summarizeItems(rootItems)).toEqual([
      {
        id: "cycle-a",
        children: ["cycle-b"],
      },
    ]);
  });

  it("lists every descendant of a parent for its collapsed rollup", () => {
    const rootItems = buildList([
      createThread({ id: "parent" }),
      createThread({ id: "quiet-child", parentThreadId: "parent" }),
      createThread({
        id: "busy-grandchild",
        parentThreadId: "quiet-child",
        latestAttentionAt: 3,
      }),
      createThread({ id: "pending-grandchild", parentThreadId: "quiet-child" }),
    ]);

    const parent = findNode(rootItems, "parent");
    expect(
      getProjectThreadItemDescendants(parent?.children ?? []).map(
        (thread) => thread.id,
      ),
    ).toEqual(["quiet-child", "busy-grandchild", "pending-grandchild"]);
  });

  it("nests parent/child threads under globally sorted roots", () => {
    const items = buildList([
      createThread({ id: "parent", createdAt: 10, latestAttentionAt: 10 }),
      createThread({
        id: "child",
        parentThreadId: "parent",
        createdAt: 30,
        latestAttentionAt: 30,
      }),
      createThread({ id: "other", createdAt: 20, latestAttentionAt: 20 }),
    ]);

    expect(summarizeItems(items)).toEqual([
      "other",
      { id: "parent", children: ["child"] },
    ]);
  });

  it("keeps worktree siblings as thread rows", () => {
    const items = buildList([
      createThread({ id: "parent", createdAt: 100 }),
      createThread({
        id: "worktree-a",
        parentThreadId: "parent",
        environmentId: "env_shared",
        queuedWork: "none",
        createdAt: 10,
        latestAttentionAt: 100,
      }),
      createThread({
        id: "worktree-b",
        parentThreadId: "parent",
        environmentId: "env_shared",
        queuedWork: "none",
        createdAt: 20,
        latestAttentionAt: 200,
      }),
    ]);

    expect(summarizeItems(items)).toEqual([
      {
        id: "parent",
        children: ["worktree-b", "worktree-a"],
      },
    ]);
  });

  it("excludes side chats", () => {
    const items = buildList([
      createThread({ id: "root", createdAt: 10 }),
      createThread({
        id: "side",
        parentThreadId: "root",
        visibility: "hidden",
        createdAt: 20,
      }),
    ]);

    expect(summarizeItems(items)).toEqual(["root"]);
  });
});
