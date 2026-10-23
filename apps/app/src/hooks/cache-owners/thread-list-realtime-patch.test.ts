import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import type { ThreadListEntry } from "@bb/domain";
import type { ChangedMessage } from "@bb/domain";
import { createAppQueryClient } from "@/lib/query-client";
import { sdk } from "@/lib/sdk";
import { createRealtimeCacheEffects } from "../realtime-cache-effects";
import {
  archivedThreadsListQueryKey,
  threadListQueryKey,
} from "../queries/query-keys";

function makeRow(
  id: string,
  changes: Partial<ThreadListEntry> = {},
): ThreadListEntry {
  return makeThreadListEntry({
    id,
    projectId: "project-1",
    createdAt: 1,
    ...changes,
  });
}

function makeEffects(queryClient: ReturnType<typeof createAppQueryClient>) {
  return createRealtimeCacheEffects({
    queryClient,
    visibility: { isDocumentVisible: () => true, subscribe: () => () => {} },
  });
}

async function flushEffects() {
  await vi.advanceTimersByTimeAsync(250);
  await Promise.resolve();
  await Promise.resolve();
}

describe("realtime thread list row patching", () => {
  afterEach(() => vi.useRealTimers());

  it("inserts a created row in active list order with one row fetch", async () => {
    vi.useFakeTimers();
    const queryClient = createAppQueryClient();
    const effects = makeEffects(queryClient);
    const key = threadListQueryKey({ projectId: "project-1", archived: false });
    const unpinned = makeRow("thread_unpinned", { createdAt: 100 });
    const pinnedLast = makeRow("thread_pinned_z", { createdAt: 1, pinnedAt: 1, pinSortKey: "z" });
    const pinnedFirst = makeRow("thread_pinned_a", { createdAt: 1, pinnedAt: 1, pinSortKey: "a" });
    const created = makeRow("thread_created", { createdAt: 2, pinnedAt: 1, pinSortKey: "b" });
    queryClient.setQueryData(key, [unpinned, pinnedLast, pinnedFirst]);
    const list = vi.spyOn(sdk.threads, "list").mockResolvedValue([created]);
    try {
      effects.handleChanged({ type: "changed", entity: "thread", id: created.id, changes: ["thread-created"] });
      await flushEffects();
      expect(queryClient.getQueryData(key)).toEqual([pinnedFirst, created, pinnedLast, unpinned]);
      expect(list).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledWith({ threadIds: [created.id], includeHidden: true });
    } finally {
      effects.dispose();
      queryClient.clear();
      list.mockRestore();
    }
  });

  it("moves an archived row out of active and into archived lists", async () => {
    vi.useFakeTimers();
    const queryClient = createAppQueryClient();
    const effects = makeEffects(queryClient);
    const activeKey = threadListQueryKey({ projectId: "project-1", archived: false });
    const archivedKey = archivedThreadsListQueryKey({ projectId: "project-1" });
    const prior = makeRow("thread_archived", { createdAt: 2 });
    const archived = makeRow("thread_archived", { createdAt: 2, archivedAt: 20 });
    const other = makeRow("thread_other", { createdAt: 1 });
    const archivedOlder = makeRow("thread_archived_older", { createdAt: 3, archivedAt: 10 });
    const archivedNewest = makeRow("thread_archived_newest", { createdAt: 4, archivedAt: 50 });
    queryClient.setQueryData(activeKey, [prior, other]);
    queryClient.setQueryData(archivedKey, [archivedOlder, archivedNewest]);
    const list = vi.spyOn(sdk.threads, "list").mockResolvedValue([archived]);
    try {
      effects.handleChanged({ type: "changed", entity: "thread", id: archived.id, changes: ["archived-changed"] });
      await flushEffects();
      expect(queryClient.getQueryData(activeKey)).toEqual([other]);
      expect(queryClient.getQueryData(archivedKey)).toEqual([archivedNewest, archived, archivedOlder]);
      expect(list).toHaveBeenCalledTimes(1);
      expect(list.mock.calls[0]?.[0]?.threadIds).toEqual([archived.id]);
    } finally {
      effects.dispose();
      queryClient.clear();
      list.mockRestore();
    }
  });

  it("updates a renamed row from the fetched list-row shape", async () => {
    vi.useFakeTimers();
    const queryClient = createAppQueryClient();
    const effects = makeEffects(queryClient);
    const key = threadListQueryKey({ projectId: "project-1", archived: false });
    const before = makeRow("thread_renamed", { title: "Before", createdAt: 2 });
    const renamed = makeRow("thread_renamed", { title: "After", createdAt: 2 });
    queryClient.setQueryData(key, [before]);
    const list = vi.spyOn(sdk.threads, "list").mockResolvedValue([renamed]);
    try {
      effects.handleChanged({ type: "changed", entity: "thread", id: renamed.id, changes: ["title-changed"] });
      await flushEffects();
      expect(queryClient.getQueryData(key)).toEqual([renamed]);
      expect(list).toHaveBeenCalledTimes(1);
      expect(list.mock.calls[0]?.[0]?.threadIds).toEqual([renamed.id]);
    } finally {
      effects.dispose();
      queryClient.clear();
      list.mockRestore();
    }
  });

  it("patches status from the fetched row and status metadata", async () => {
    vi.useFakeTimers();
    const queryClient = createAppQueryClient();
    const effects = makeEffects(queryClient);
    const key = threadListQueryKey({ projectId: "project-1", archived: false });
    const before = makeRow("thread_status", { status: "idle", createdAt: 2 });
    const updated = makeRow("thread_status", { status: "error", createdAt: 2, updatedAt: 3 });
    queryClient.setQueryData(key, [before]);
    const list = vi.spyOn(sdk.threads, "list").mockResolvedValue([updated]);
    try {
      effects.handleChanged({
        type: "changed",
        entity: "thread",
        id: updated.id,
        changes: ["status-changed"],
        metadata: {
          statusChange: {
            status: updated.status,
            runtime: updated.runtime,
            activity: updated.activity,
            latestAttentionAt: updated.latestAttentionAt,
            updatedAt: updated.updatedAt,
          },
        },
      });
      await flushEffects();
      expect(queryClient.getQueryData(key)).toEqual([updated]);
      expect(list).toHaveBeenCalledTimes(1);
      expect(list.mock.calls[0]?.[0]?.threadIds).toEqual([updated.id]);
    } finally {
      effects.dispose();
      queryClient.clear();
      list.mockRestore();
    }
  });

  it("moves a row into its new project's list", async () => {
    vi.useFakeTimers();
    const queryClient = createAppQueryClient();
    const effects = makeEffects(queryClient);
    const firstKey = threadListQueryKey({ projectId: "project-1", archived: false });
    const secondKey = threadListQueryKey({ projectId: "project-2", archived: false });
    const movedBefore = makeRow("thread_moved", { projectId: "project-1", createdAt: 3 });
    const moved = makeRow("thread_moved", { projectId: "project-2", createdAt: 3 });
    const firstOther = makeRow("thread_first", { createdAt: 1 });
    const secondOther = makeRow("thread_second", { projectId: "project-2", createdAt: 2 });
    queryClient.setQueryData(firstKey, [movedBefore, firstOther]);
    queryClient.setQueryData(secondKey, [secondOther]);
    const list = vi.spyOn(sdk.threads, "list").mockResolvedValue([moved]);
    try {
      effects.handleChanged({ type: "changed", entity: "thread", id: moved.id, changes: ["environment-changed"] });
      await flushEffects();
      expect(queryClient.getQueryData(firstKey)).toEqual([firstOther]);
      expect(queryClient.getQueryData(secondKey)).toEqual([moved, secondOther]);
      expect(list).toHaveBeenCalledTimes(1);
      expect(list.mock.calls[0]?.[0]?.threadIds).toEqual([moved.id]);
    } finally {
      effects.dispose();
      queryClient.clear();
      list.mockRestore();
    }
  });

  it("coalesces multiple changes for one ID into one row fetch", async () => {
    vi.useFakeTimers();
    const queryClient = createAppQueryClient();
    const effects = makeEffects(queryClient);
    const key = threadListQueryKey({ projectId: "project-1", archived: false });
    const before = makeRow("thread_burst", { createdAt: 2 });
    const updated = makeRow("thread_burst", { createdAt: 2, archivedAt: 20, title: "After" });
    queryClient.setQueryData(key, [before]);
    const list = vi.spyOn(sdk.threads, "list").mockResolvedValue([updated]);
    try {
      effects.handleChanged({ type: "changed", entity: "thread", id: updated.id, changes: ["title-changed"] });
      effects.handleChanged({ type: "changed", entity: "thread", id: updated.id, changes: ["archived-changed"] });
      await flushEffects();
      expect(queryClient.getQueryData(key)).toEqual([]);
      expect(list).toHaveBeenCalledTimes(1);
      expect(list.mock.calls[0]?.[0]?.threadIds).toEqual([updated.id]);
    } finally {
      effects.dispose();
      queryClient.clear();
      list.mockRestore();
    }
  });

  it.each([
    ["events-appended", { backgroundActivityChanged: true }],
    ["queue-changed", undefined],
    ["thread-created", undefined],
    ["thread-deleted", undefined],
    ["history-rewritten", undefined],
    ["status-changed", undefined],
    ["title-changed", undefined],
    ["archived-changed", undefined],
    ["pin-state-changed", undefined],
    ["parent-changed", undefined],
    ["environment-changed", undefined],
    ["read-state-changed", undefined],
  ] as const)("patches the canonical row for %s with one row fetch", async (change, eventMetadata) => {
    vi.useFakeTimers();
    const queryClient = createAppQueryClient();
    const effects = makeEffects(queryClient);
    const key = threadListQueryKey({ projectId: "project-1", archived: false });
    const other = makeRow("thread_other", { createdAt: 1 });
    const id = change === "thread-created" ? "thread_created" : "thread_changed";
    const previous = makeRow(id, { createdAt: 2 });
    const changed = change === "thread-deleted"
      ? undefined
      : makeRow(id, {
          ...previous,
          ...(change === "archived-changed" ? { archivedAt: 20 } : {}),
          ...(change === "pin-state-changed" ? { pinnedAt: 10, pinSortKey: "a" } : {}),
          ...(change === "read-state-changed" ? { lastReadAt: 50 } : {}),
          ...(change === "title-changed" ? { title: "After" } : {}),
        });
    const initial = change === "thread-created"
      ? [other]
      : [previous, other];
    const expected = change === "thread-deleted" || change === "archived-changed"
      ? [other]
      : change === "pin-state-changed"
        ? [changed as ThreadListEntry, other]
        : [changed as ThreadListEntry, other];
    queryClient.setQueryData(key, initial);
    const list = vi.spyOn(sdk.threads, "list").mockResolvedValue(changed ? [changed] : []);
    const metadata = change === "status-changed" && changed
      ? {
          statusChange: {
            status: changed.status,
            runtime: changed.runtime,
            activity: changed.activity,
            latestAttentionAt: changed.latestAttentionAt,
            updatedAt: changed.updatedAt,
          },
        }
      : eventMetadata;
    try {
      const event = {
        type: "changed",
        entity: "thread",
        id,
        changes: [change],
        ...(metadata ? { metadata } : {}),
      } as ChangedMessage;
      effects.handleChanged(event);
      await flushEffects();
      expect(queryClient.getQueryData(key)).toEqual(expected);
      expect(list).toHaveBeenCalledTimes(1);
      expect(list.mock.calls[0]?.[0]?.threadIds).toEqual([id]);
      expect(list.mock.calls.filter(([args]) => args?.threadIds === undefined)).toHaveLength(0);
    } finally {
      effects.dispose();
      queryClient.clear();
      list.mockRestore();
    }
  });
});
