// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useThreadUnreadDividerState } from "./useThreadUnreadDividerState";

interface DividerThread {
  id: string;
  lastReadAt: number | null;
  latestAttentionAt: number;
}

interface DividerQuery {
  isFetchedAfterMount: boolean;
  isPlaceholderData: boolean;
}

const SETTLED_QUERY: DividerQuery = {
  isFetchedAfterMount: true,
  isPlaceholderData: false,
};

function renderDividerState(
  initialThread: DividerThread,
  initialQuery: DividerQuery = SETTLED_QUERY,
) {
  const renders: ReturnType<typeof useThreadUnreadDividerState>[] = [];
  const view = renderHook(
    ({ query, thread }: { query: DividerQuery; thread: DividerThread }) => {
      const state = useThreadUnreadDividerState({
        anchor: "first-unread-row",
        bootstrapQuery: { dataUpdatedAt: 0, isFetchedAfterMount: false, isSuccess: false },
        threadQuery: { ...query, isError: false },
        hasUnseenTimelineEvents: false,
        routeThreadId: thread.id,
        thread,
      });
      renders.push(state);
      return state;
    },
    { initialProps: { query: initialQuery, thread: initialThread } },
  );
  return {
    renders,
    result: view.result,
    show: (thread: DividerThread, query: DividerQuery = SETTLED_QUERY) => {
      renders.length = 0;
      view.rerender({ query, thread });
    },
  };
}

afterEach(() => {
  cleanup();
});

describe("useThreadUnreadDividerState", () => {
  it("places and auto-scrolls the divider on the first render of an unread thread", () => {
    const { renders } = renderDividerState({
      id: "thr_a",
      lastReadAt: 100,
      latestAttentionAt: 200,
    });

    expect(renders[0]).toEqual({
      ready: false,
      autoScroll: true,
      hasUnseenTimelineEvents: true,
      landOnDivider: false,
      placement: { anchor: "first-unread-row", cutoffAt: 100 },
    });
  });

  it("places the next thread's divider on the first render after a switch", () => {
    const { renders, show } = renderDividerState({
      id: "thr_a",
      lastReadAt: 100,
      latestAttentionAt: 200,
    });

    show({ id: "thr_b", lastReadAt: null, latestAttentionAt: 300 });

    expect(renders[0]).toEqual({
      ready: false,
      autoScroll: true,
      hasUnseenTimelineEvents: true,
      landOnDivider: false,
      placement: null,
    });
  });

  it("keeps the opening divider when the thread is marked read, and drops it after a watched reply", () => {
    const { result, show } = renderDividerState({
      id: "thr_a",
      lastReadAt: 100,
      latestAttentionAt: 200,
    });

    show({ id: "thr_a", lastReadAt: 250, latestAttentionAt: 200 });
    expect(result.current).toEqual({
      ready: true,
      autoScroll: true,
      hasUnseenTimelineEvents: true,
      landOnDivider: true,
      placement: { anchor: "first-unread-row", cutoffAt: 100 },
    });

    show({ id: "thr_a", lastReadAt: 400, latestAttentionAt: 300 });
    expect(result.current).toEqual({
      ready: true,
      autoScroll: true,
      hasUnseenTimelineEvents: true,
      landOnDivider: false,
      placement: null,
    });
  });

  it("opens a read thread without a divider", () => {
    const { renders } = renderDividerState({
      id: "thr_a",
      lastReadAt: 300,
      latestAttentionAt: 200,
    });

    expect(renders[0]).toEqual({
      ready: false,
      autoScroll: false,
      hasUnseenTimelineEvents: false,
      landOnDivider: false,
      placement: null,
    });
  });

  it("opens a never-read thread without a divider, and adds none when it is marked unread while open", () => {
    const { result, show } = renderDividerState({
      id: "thr_a",
      lastReadAt: null,
      latestAttentionAt: 200,
    });
    expect(result.current.placement).toBeNull();
    expect(result.current.landOnDivider).toBe(false);

    show({ id: "thr_b", lastReadAt: 300, latestAttentionAt: 200 });
    show({ id: "thr_b", lastReadAt: null, latestAttentionAt: 200 });
    expect(result.current.placement).toBeNull();
    expect(result.current.landOnDivider).toBe(false);
  });

  it("lands on a divider that arrives with the fresh fetch after reopening on cached read state", () => {
    const cached: DividerQuery = {
      isFetchedAfterMount: false,
      isPlaceholderData: true,
    };
    const { result, show } = renderDividerState(
      { id: "thr_a", lastReadAt: 300, latestAttentionAt: 200 },
      cached,
    );
    expect(result.current.ready).toBe(false);
    expect(result.current.placement).toBeNull();
    expect(result.current.landOnDivider).toBe(false);

    show({ id: "thr_a", lastReadAt: 300, latestAttentionAt: 400 });
    expect(result.current.ready).toBe(true);
    expect(result.current.placement).toEqual({
      anchor: "first-unread-row",
      cutoffAt: 300,
    });
    expect(result.current.landOnDivider).toBe(true);
  });

  it("places but does not land on a divider from a reply that arrives after the thread settled", () => {
    const { result, show } = renderDividerState({
      id: "thr_a",
      lastReadAt: 300,
      latestAttentionAt: 200,
    });

    show({ id: "thr_a", lastReadAt: 300, latestAttentionAt: 400 });
    expect(result.current.placement).toEqual({
      anchor: "first-unread-row",
      cutoffAt: 300,
    });
    expect(result.current.landOnDivider).toBe(false);
  });
});
