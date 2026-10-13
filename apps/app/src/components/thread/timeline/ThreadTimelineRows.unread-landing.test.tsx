// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { threadTimelineScrollAnchorAtomFamily } from "@/lib/thread-timeline-scroll-anchor";
import { commandRow, conversationRow } from "@/test/fixtures/thread-timeline-rows";
import { useThreadUnreadDividerState } from "@/views/thread-detail/useThreadUnreadDividerState";
import { ThreadTimelinePane } from "@/views/thread-detail/ThreadTimelinePane";
import { ThreadProviderContext } from "../thread-provider-context";

const THREAD_ID = "thr_landing";
const SCROLL_HEIGHT = 3500;
const CLIENT_HEIGHT = 800;
const LATEST_SCROLL_TOP = SCROLL_HEIGHT - CLIENT_HEIGHT;
const DIVIDER_OFFSET = 900;

vi.mock("@/components/thread/toc/ThreadTableOfContents", () => ({
  ThreadTableOfContents: () => null,
}));

const rows = [
  conversationRow({
    id: "user-100",
    seq: 100,
    role: "user",
    text: "PROMPT",
    createdAt: 100,
    startedAt: 100,
    turnId: "turn-1",
  }),
  ...[200, 300, 400].map((seq) =>
    commandRow({
      id: `command-${seq}`,
      seq,
      command: `echo ${seq}`,
      createdAt: seq,
      startedAt: seq,
      turnId: "turn-1",
    }),
  ),
  conversationRow({
    id: "assistant-500",
    seq: 500,
    role: "assistant",
    text: "ANSWER",
    createdAt: 500,
    startedAt: 500,
    turnId: "turn-1",
  }),
];

class ResizeObserverMock implements ResizeObserver {
  static instances: ResizeObserverMock[] = [];
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve() {}
  disconnect() {}
  trigger() {
    if (
      [...this.targets].some((target) =>
        target.hasAttribute("data-page-scroll-viewport"),
      )
    ) {
      this.callback([], this);
    }
  }
}

beforeEach(() => {
  ResizeObserverMock.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  let nextHandle = 0;
  vi.stubGlobal("requestAnimationFrame", () => ++nextHandle);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const area = this.closest<HTMLElement>("[data-page-scroll-viewport]");
      if (this === area) return new DOMRect(0, 0, 390, CLIENT_HEIGHT);
      const offset =
        this.dataset.testid === "thread-unread-divider" ? DIVIDER_OFFSET : 200;
      return new DOMRect(0, offset - (area?.scrollTop ?? 0), 390, 400);
    },
  );
});

afterEach(() => {
  cleanup();
  getDefaultStore().set(threadTimelineScrollAnchorAtomFamily(THREAD_ID), null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function UnseenThread() {
  const { placement, hasUnseenTimelineEvents } = useThreadUnreadDividerState({
    routeThreadId: THREAD_ID,
    bootstrapQuery: {
      dataUpdatedAt: 0,
      isFetchedAfterMount: false,
      isSuccess: false,
    },
    threadQuery: {
      isFetchedAfterMount: false,
      isError: false,
      isPlaceholderData: false,
    },
    isFocused: true,
    hasUnseenTimelineEvents: false,
    thread: { id: THREAD_ID, lastReadAt: 350, latestAttentionAt: 500 },
  });
  return (
    <ThreadTimelinePane
      footer={<div>Composer</div>}
      canSpawnChild={false}
      hasOlderTimelineRows={false}
      isLoadingOlderTimelineRows={false}
      isStopping={false}
      onLoadOlderRows={() => undefined}
      resolveMentionLink={() => null}
      stoppingAnchorAt={0}
      activeThinking={null}
      contextBoundarySeq={null}
      hasUnseenTimelineEvents={hasUnseenTimelineEvents}
      isThreadTimelinePending={false}
      timelineError={false}
      showOngoingIndicator={false}
      threadId={THREAD_ID}
      threadRuntimeDisplayStatus="idle"
      workspaceRootPath={undefined}
      timelineRows={rows}
      unreadDividerPlacement={placement}
    />
  );
}

function openUnseenThread() {
  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ThreadProviderContext.Provider
          value={{ providerId: "echo-agent", pluginId: "echo-provider" }}
        >
          <UnseenThread />
        </ThreadProviderContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const area = container.querySelector<HTMLElement>(
    "[data-page-scroll-viewport]",
  );
  if (!area) throw new Error("Missing scroll viewport");
  Object.defineProperty(area, "scrollHeight", {
    configurable: true,
    get: () => SCROLL_HEIGHT,
  });
  Object.defineProperty(area, "clientHeight", {
    configurable: true,
    value: CLIENT_HEIGHT,
  });
  const settle = () => {
    act(() => {
      for (const observer of ResizeObserverMock.instances) observer.trigger();
    });
    act(() => vi.advanceTimersByTime(50));
  };
  return { area, container, settle };
}

describe("opening a thread with unseen activity", () => {
  it("keeps the top-level viewport on the latest content instead of scrolling to the unread divider", () => {
    const { area, container, settle } = openUnseenThread();

    expect(
      container.querySelector('[data-testid="thread-unread-divider"]'),
    ).not.toBeNull();
    settle();

    expect(area.scrollTop).toBe(LATEST_SCROLL_TOP);
    expect(area.scrollTop).not.toBeLessThanOrEqual(DIVIDER_OFFSET);
  });

  it("keeps the viewport on the latest content while a nested timeline expands", async () => {
    const { area, container, settle } = openUnseenThread();
    settle();
    expect(area.scrollTop).toBe(LATEST_SCROLL_TOP);

    fireEvent.click(screen.getByText("Ran 3 commands"));
    await act(() => vi.advanceTimersByTimeAsync(500));
    settle();

    const nested = container.querySelector(
      '[data-timeline-row-list]:not([data-timeline-row-list="top-level"])',
    );
    expect(nested).not.toBeNull();
    expect(
      nested?.querySelector('[data-testid="thread-unread-divider"]') ?? null,
    ).toBeNull();
    expect(
      container.querySelectorAll('[data-testid="thread-unread-divider"]'),
    ).toHaveLength(1);
    expect(area.scrollTop).toBe(LATEST_SCROLL_TOP);
  });
});
