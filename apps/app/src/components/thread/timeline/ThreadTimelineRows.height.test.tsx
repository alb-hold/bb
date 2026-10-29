// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Provider } from "jotai";
import { afterEach, expect, it, vi } from "vitest";
import {
  BottomAnchorContext,
  type BottomAnchorContextValue,
} from "@/components/ui/bottom-anchored-scroll-body";
import { AutoHeightContainer } from "@/components/ui/height-transition";
import { ScrollPositionKeeper } from "@/components/ui/scroll-position-keeper";
import { conversationRow, turnRow } from "@/test/fixtures/thread-timeline-rows";
import { ThreadTimelineRows } from "./ThreadTimelineRows";

class ResizeObserverStub implements ResizeObserver {
  static instances: ResizeObserverStub[] = [];
  readonly targets = new Set<Element>();

  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve: ResizeObserver["unobserve"] = vi.fn();
  disconnect: ResizeObserver["disconnect"] = vi.fn();

  static trigger(target: Element, height: number) {
    const entry = {
      target,
      contentRect: new DOMRect(0, 0, 400, height),
      borderBoxSize: [{ inlineSize: 400, blockSize: height }],
      contentBoxSize: [{ inlineSize: 400, blockSize: height }],
      devicePixelContentBoxSize: [{ inlineSize: 400, blockSize: height }],
    } as ResizeObserverEntry;
    for (const observer of ResizeObserverStub.instances) {
      if (observer.targets.has(target)) observer.callback([entry], observer);
    }
  }
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  ResizeObserverStub.instances = [];
});

it("snap-syncs the timeline height when older rows are prepended", () => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return (
        this.querySelectorAll(
          '[data-timeline-row-list="top-level"] > [data-timeline-items] > [data-timeline-row-id]',
        ).length * 100
      );
    },
  );

  const latestRows = [
    conversationRow({
      id: "newer_user",
      role: "user",
      seq: 20,
      text: "Newest request",
    }),
    turnRow({ id: "newest_turn", seq: 21, status: "completed" }),
  ];
  const olderRows = [
    conversationRow({
      id: "older_user",
      role: "user",
      seq: 10,
      text: "Older request",
    }),
    turnRow({ id: "older_turn", seq: 11, status: "completed" }),
  ];
  const queryClient = new QueryClient();
  const timeline = (rows: typeof latestRows) => (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ThreadTimelineRows
          threadId="thr_main"
          timelineRows={rows}
          threadRuntimeDisplayStatus="idle"
          workspaceRootPath={undefined}
          threadIsActive={false}
        />
      </QueryClientProvider>
    </MemoryRouter>
  );
  const view = render(timeline(latestRows));
  const rowList = view.container.querySelector<HTMLElement>(
    '[data-timeline-row-list="top-level"]',
  );
  const heightWrapper = rowList?.parentElement?.parentElement;

  expect(heightWrapper?.style.height).toBe("200px");

  view.rerender(timeline([...olderRows, ...latestRows]));

  expect(heightWrapper?.style.height).toBe("400px");
  expect(heightWrapper?.style.transitionDuration).toBe("0s");
});

it("snaps active timeline growth on fine-pointer browsers", () => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("CSS", { supports: () => true });
  const queryClient = new QueryClient();
  const rows = [turnRow({ id: "active_turn", seq: 1, status: "pending" })];
  const timeline = (active: boolean) => (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ThreadTimelineRows
          threadId="thr_main"
          timelineRows={rows}
          threadRuntimeDisplayStatus={active ? "active" : "idle"}
          workspaceRootPath={undefined}
          threadIsActive={false}
        />
      </QueryClientProvider>
    </MemoryRouter>
  );
  const view = render(timeline(false));
  const rowList = view.container.querySelector<HTMLElement>(
    '[data-timeline-row-list="top-level"]',
  );
  const wrapper = rowList?.parentElement?.parentElement;
  expect(wrapper?.style.transition).toContain("height 180ms");
  view.rerender(timeline(true));
  expect(wrapper?.style.transition).toContain("height 0ms");
  view.rerender(timeline(false));
  expect(wrapper?.style.transition).toContain("height 180ms");
});

it("keeps the reading row in place through eased growth frames", () => {
  let intrinsicHeight = 800;
  let transitionHeight = 800;
  let scrollArea: HTMLElement | null = null;
  let contentWrapper: HTMLElement | null = null;
  let readingRow: HTMLElement | null = null;
  const positionKeeper = new ScrollPositionKeeper({
    bottomThresholdPx: 4,
    deferWritesWhileScrolling: false,
    getContentElement: () => contentWrapper,
    getFloorElement: () => null,
    getFooterElement: () => null,
    getScrollElement: () => scrollArea,
    getTopLevelRows: () => (readingRow === null ? [] : [readingRow]),
    initiallyAttached: false,
  });
  const bottomAnchorValue: BottomAnchorContextValue = {
    getScrollElement: () => scrollArea,
    isAtBottom: false,
    scrollToBottom: () => undefined,
    scrollElementIntoView: () => undefined,
    captureScrollAnchor: () => undefined,
    holdContentPosition: () => undefined,
    positionKeeper,
  };
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "performance"],
  });
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("CSS", { supports: () => true });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.testid === "animated-content" ? intrinsicHeight : 0;
    },
  );
  const view = render(
    <Provider>
      <BottomAnchorContext.Provider value={bottomAnchorValue}>
        <div
          ref={(element) => {
            scrollArea = element;
          }}
          data-page-scroll-viewport=""
          data-testid="scroll-area"
        >
          <AutoHeightContainer>
            <div data-testid="animated-content" />
          </AutoHeightContainer>
          <div
            ref={(element) => {
              readingRow = element;
            }}
            data-timeline-row-id="reading-row"
          >
            Reading row
          </div>
        </div>
      </BottomAnchorContext.Provider>
    </Provider>,
  );
  const area = view.getByTestId("scroll-area");
  scrollArea = area;
  contentWrapper = area.firstElementChild as HTMLElement;
  const wrapper = contentWrapper;
  const content = wrapper.firstElementChild as HTMLElement;
  let scrollTop = 600;
  const scrollTopWrites: number[] = [];
  Object.defineProperty(area, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTopWrites.push(value);
      scrollTop = value;
    },
  });
  const row = view.container.querySelector<HTMLElement>(
    '[data-timeline-row-id="reading-row"]',
  );
  if (row === null) throw new Error("reading row is missing");
  readingRow = row;
  Object.defineProperty(area, "clientHeight", {
    configurable: true,
    value: 500,
  });
  Object.defineProperty(area, "scrollHeight", {
    configurable: true,
    get: () => 2_000 + transitionHeight,
  });
  area.getBoundingClientRect = () => new DOMRect(0, 0, 400, 500);
  row.getBoundingClientRect = () => {
    const transformY =
      Number(
        /translate3d\(0, (-?[\d.]+)px/u.exec(wrapper.style.transform)?.[1],
      ) || 0;
    return new DOMRect(
      0,
      100 + transitionHeight - area.scrollTop + transformY,
      400,
      100,
    );
  };
  area.scrollTop = 600;

  const disconnect = positionKeeper.connect(area);
  positionKeeper.hold(row, "top");
  act(() => vi.advanceTimersByTime(300));
  scrollTopWrites.length = 0;
  const readingRowTop = row.getBoundingClientRect().top;
  const initialScrollTop = area.scrollTop;

  intrinsicHeight = 1_000;
  act(() => ResizeObserverStub.trigger(content, intrinsicHeight));
  expect(wrapper.style.height).toBe("1000px");
  expect(wrapper.style.transition).toContain("height 180ms");
  expect(wrapper.style.transition).toContain("cubic-bezier(0.16, 1, 0.3, 1)");
  expect(area.scrollTop).toBe(initialScrollTop);
  expect(scrollTopWrites).toEqual([]);
  expect(row.getBoundingClientRect().top).toBe(readingRowTop);

  for (const frameHeight of [850, 900, 950, 1_000]) {
    transitionHeight = frameHeight;
    act(() => ResizeObserverStub.trigger(wrapper, frameHeight));
    expect(scrollTopWrites).toEqual([]);
    expect(row.getBoundingClientRect().top).toBe(readingRowTop);
  }
  act(() => {
    const transitionEnd = new Event("transitionend");
    Object.defineProperty(transitionEnd, "propertyName", { value: "height" });
    wrapper.dispatchEvent(transitionEnd);
  });
  disconnect();
});
