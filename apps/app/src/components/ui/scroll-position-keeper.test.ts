// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeFlowLayout, setFakeHeight } from "@/test/fake-flow-layout";
import { ScrollPositionKeeper } from "./scroll-position-keeper";

const VIEWPORT_HEIGHT = 500;

interface RowSpec {
  id: string;
  height: number;
  children?: RowSpec[];
}

let restoreLayout: (() => void) | null = null;

afterEach(() => {
  restoreLayout?.();
  restoreLayout = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function rowsOf(count: number, height = 200, prefix = "row"): RowSpec[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    height,
  }));
}

function createTimeline(
  initialRows: RowSpec[],
  {
    deferWrites = false,
    attached = false,
    footerTop = null,
  }: {
    deferWrites?: boolean;
    attached?: boolean;
    footerTop?: number | null;
  } = {},
) {
  const scrollElement = document.createElement("div");
  const content = document.createElement("div");
  const list = document.createElement("div");
  list.setAttribute("data-timeline-row-list", "top-level");
  const items = document.createElement("div");
  items.setAttribute("data-timeline-items", "");
  list.append(items);
  content.append(list);
  scrollElement.append(content);
  document.body.append(scrollElement);
  const layout = installFakeFlowLayout({
    scrollElement,
    viewportHeight: VIEWPORT_HEIGHT,
  });
  restoreLayout = layout.restore;

  const elements = new Map<string, HTMLElement>();
  const build = (row: RowSpec): HTMLElement => {
    const element = elements.get(row.id) ?? document.createElement("div");
    elements.set(row.id, element);
    element.setAttribute("data-timeline-row-id", row.id);
    element.replaceChildren(...(row.children ?? []).map(build));
    if (row.children === undefined) setFakeHeight(element, row.height);
    else element.removeAttribute("data-fake-height");
    return element;
  };
  const setRows = (rows: RowSpec[]) => {
    items.replaceChildren(...rows.map(build));
  };
  setRows(initialRows);
  const footer = document.createElement("div");
  footer.getBoundingClientRect = () =>
    new DOMRect(0, footerTop ?? VIEWPORT_HEIGHT, 100, 80);

  const keeper = new ScrollPositionKeeper({
    bottomThresholdPx: 4,
    deferWritesWhileScrolling: deferWrites,
    getContentElement: () => content,
    getFooterElement: () => (footerTop === null ? null : footer),
    getScrollElement: () => scrollElement,
    getTopLevelRows: () =>
      items.querySelectorAll<HTMLElement>(":scope > [data-timeline-row-id]"),
    initiallyAttached: attached,
  });
  const disconnect = keeper.connect(scrollElement);
  const previousRestore = restoreLayout;
  restoreLayout = () => {
    disconnect();
    previousRestore?.();
  };

  const topOf = (id: string) => {
    const element = elements.get(id);
    if (element === undefined) throw new Error(`No row ${id}`);
    return element.getBoundingClientRect().top;
  };

  return {
    content,
    keeper,
    layout,
    scrollElement,
    setRows,
    topOf,
    resize(id: string, height: number) {
      const element = elements.get(id);
      if (element === undefined) throw new Error(`No row ${id}`);
      setFakeHeight(element, height);
    },
    userScrollTo(top: number) {
      layout.userScrollTo(top);
    },
  };
}

describe("ScrollPositionKeeper", () => {
  it("keeps the reading row in place when an older page is prepended", () => {
    const rows = rowsOf(10);
    const timeline = createTimeline(rows);
    timeline.userScrollTo(450);
    const before = timeline.topOf("row-3");

    timeline.setRows([...rowsOf(6, 150, "older"), ...rows]);
    timeline.keeper.reconcile();

    expect(timeline.topOf("row-3")).toBe(before);
    expect(timeline.keeper.isAttached()).toBe(false);
  });

  it("drives each reconcile to the same intent, so a clamped intermediate correction is not counted twice", () => {
    const rows = rowsOf(10);
    const timeline = createTimeline(rows);
    timeline.userScrollTo(450);
    const before = timeline.topOf("row-3");

    timeline.setRows(rows.slice(3));
    timeline.keeper.reconcile();
    expect(timeline.layout.scrollTop).toBe(0);

    timeline.setRows([...rowsOf(8, 100, "older"), ...rows]);
    timeline.keeper.reconcile();
    timeline.keeper.reconcile();

    expect(timeline.topOf("row-3")).toBe(before);
  });

  it.each(["scroll-before-resize", "resize-before-scroll"] as const)(
    "keeps a passive shrink clamp detached in %s order and through later growth (test-change-reason: owner rule 2026-10-24; fork #124 (a70b9e0f73) keeps passive shrink clamps detached in both event orders)",
    async (eventOrder) => {
      const rows = rowsOf(10);
      const timeline = createTimeline(rows);
      timeline.userScrollTo(1_400);
      expect(timeline.keeper.isAttached()).toBe(false);

      timeline.setRows(rows.slice(0, 7));
      if (eventOrder === "scroll-before-resize") {
        timeline.layout.layoutScrollTo(timeline.layout.maxScrollTop());
        timeline.keeper.reconcile();
      } else {
        timeline.keeper.reconcile();
        timeline.layout.layoutScrollTo(timeline.layout.maxScrollTop());
      }
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });

      expect(timeline.layout.scrollTop).toBe(timeline.layout.maxScrollTop());
      expect(timeline.keeper.isAttached()).toBe(false);
      const clampedScrollTop = timeline.layout.scrollTop;

      timeline.setRows(rows.slice(0, 8));
      timeline.keeper.reconcile();
      expect(timeline.keeper.isAttached()).toBe(false);
      expect(timeline.layout.scrollTop).toBe(clampedScrollTop);
    },
  );

  it("does not publish a passive shrink clamp after a deferred downward scroll", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const timeline = createTimeline(rowsOf(10), { deferWrites: true });
    timeline.userScrollTo(500);
    vi.advanceTimersByTime(500);
    const frameCallbacks: FrameRequestCallback[] = [];
    let nextFrameId = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      nextFrameId += 1;
      return nextFrameId;
    });

    timeline.layout.layoutScrollTo(1_300);
    for (const callback of frameCallbacks.splice(0)) callback(0);
    timeline.setRows(rowsOf(7));
    timeline.keeper.reconcile();
    let positionNotifications = 0;
    timeline.keeper.subscribePosition(() => {
      positionNotifications += 1;
    });
    timeline.layout.layoutScrollTo(timeline.layout.maxScrollTop());
    const clampedReadingRowTop = timeline.topOf("row-4");
    for (const callback of frameCallbacks.splice(0)) callback(0);

    expect(timeline.keeper.isAttached()).toBe(false);
    expect(timeline.topOf("row-4")).toBe(clampedReadingRowTop);
    expect(positionNotifications).toBe(0);
  });

  it.each([
    {
      eventOrder: "clamp-without-own-event-before-reconcile",
      input: "single-event jump",
      outcome: "reattaches on a single-event jump to end",
    },
    {
      eventOrder: "clamp-without-own-event-before-reconcile",
      input: "wheel",
      outcome: "reattaches on a wheel scroll to end",
    },
    {
      eventOrder: "clamp-without-own-event-before-reconcile",
      input: "touch",
      outcome: "stays reattachable on a touch to end",
    },
    {
      eventOrder: "non-end-scroll-after-reconcile",
      input: "single-event jump",
      outcome: "reattaches on a single-event jump to end",
    },
    {
      eventOrder: "non-end-scroll-after-reconcile",
      input: "wheel",
      outcome: "reattaches on a wheel scroll to end",
    },
    {
      eventOrder: "non-end-scroll-after-reconcile",
      input: "touch",
      outcome: "stays reattachable on a touch to end",
    },
  ] as const)(
    "clears the passive shrink latch after $eventOrder and $outcome",
    async ({ eventOrder, input }) => {
      const rows = rowsOf(10);
      const timeline = createTimeline(rows);
      timeline.userScrollTo(1_400);

      timeline.setRows(rows.slice(0, 7));
      if (eventOrder === "clamp-without-own-event-before-reconcile") {
        timeline.layout.bounceTo(0);
        timeline.keeper.reconcile();
        timeline.layout.bounceTo(0);
        timeline.keeper.reconcile();
      } else {
        timeline.keeper.reconcile();
        timeline.layout.layoutScrollTo(0);
      }
      expect(timeline.layout.scrollTop).not.toBe(
        timeline.layout.maxScrollTop(),
      );
      expect(timeline.keeper.isAttached()).toBe(false);

      if (input === "single-event jump") {
        timeline.layout.layoutScrollTo(timeline.layout.maxScrollTop());
      } else if (input === "wheel") {
        timeline.layout.userScrollTo(timeline.layout.maxScrollTop());
      } else {
        const touch = (type: string, clientY: number) =>
          Object.assign(new Event(type), { touches: [{ clientY }] });
        timeline.scrollElement.dispatchEvent(touch("touchstart", 300));
        timeline.scrollElement.dispatchEvent(touch("touchmove", 280));
        timeline.layout.layoutScrollTo(timeline.layout.maxScrollTop());
        timeline.scrollElement.dispatchEvent(new TouchEvent("touchend"));
      }
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });

      expect(timeline.keeper.isAttached()).toBe(true);
      timeline.setRows(rows.slice(0, 8));
      timeline.keeper.reconcile();
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
      expect(timeline.layout.scrollTop).toBe(timeline.layout.maxScrollTop());
      expect(timeline.keeper.isAttached()).toBe(true);
    },
  );

  it.each(["scroll-before-resize", "resize-before-scroll"] as const)(
    "reattaches on touch at the clamped end in %s order and follows growth",
    async (eventOrder) => {
      const rows = rowsOf(10);
      const timeline = createTimeline(rows);
      timeline.userScrollTo(1_400);

      timeline.setRows(rows.slice(0, 7));
      if (eventOrder === "scroll-before-resize") {
        timeline.layout.layoutScrollTo(timeline.layout.maxScrollTop());
        timeline.keeper.reconcile();
      } else {
        timeline.keeper.reconcile();
        timeline.layout.layoutScrollTo(timeline.layout.maxScrollTop());
      }
      timeline.scrollElement.dispatchEvent(new TouchEvent("touchstart"));
      expect(timeline.keeper.isAttached()).toBe(true);

      timeline.setRows(rows.slice(0, 8));
      timeline.keeper.reconcile();
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
      expect(timeline.layout.scrollTop).toBe(timeline.layout.maxScrollTop());
      expect(timeline.keeper.isAttached()).toBe(true);
    },
  );

  it("keeps a user-scrolled-up reader detached when later content grows", () => {
    const rows = rowsOf(10);
    const timeline = createTimeline(rows);
    timeline.userScrollTo(400);
    const readingRowTop = timeline.topOf("row-2");

    timeline.setRows([...rows, ...rowsOf(2, 200, "later")]);
    timeline.keeper.reconcile();

    expect(timeline.keeper.isAttached()).toBe(false);
    expect(timeline.topOf("row-2")).toBe(readingRowTop);
  });

  it("attaches when the viewport grows and the reader's position no longer fits above the end", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const timeline = createTimeline(rowsOf(10));
    timeline.userScrollTo(1350);
    vi.advanceTimersByTime(500);
    expect(timeline.keeper.isAttached()).toBe(false);

    timeline.layout.setViewportHeight(800);
    timeline.layout.layoutScrollTo(timeline.layout.maxScrollTop());
    timeline.keeper.reconcile();
    expect(timeline.keeper.isAttached()).toBe(true);

    timeline.setRows(rowsOf(11));
    timeline.keeper.reconcile();
    expect(timeline.layout.scrollTop).toBe(timeline.layout.maxScrollTop());
  });

  it("keeps a detached reader on their row when the viewport grows but the row still fits above the end", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const timeline = createTimeline(rowsOf(10));
    timeline.userScrollTo(400);
    vi.advanceTimersByTime(500);
    const before = timeline.topOf("row-3");

    timeline.layout.setViewportHeight(800);
    timeline.keeper.reconcile();

    expect(timeline.keeper.isAttached()).toBe(false);
    expect(timeline.topOf("row-3")).toBe(before);
  });

  it("keeps the reading row in place across eased content-growth frames", () => {
    const timeline = createTimeline(rowsOf(10));
    timeline.userScrollTo(450);
    const readingRowTop = timeline.topOf("row-3");

    for (const height of [210, 220, 230, 240]) {
      timeline.resize("row-1", height);
      timeline.keeper.reconcile();
      expect(timeline.topOf("row-3")).toBe(readingRowTop);
    }
  });

  it("attaches a reader left detached at the end when they drag toward the end, though the drag cannot scroll", () => {
    const rows = rowsOf(10);
    const timeline = createTimeline(rows);
    timeline.userScrollTo(1200);
    timeline.setRows(rows.slice(0, 7));
    timeline.keeper.reconcile();
    expect(timeline.keeper.isAttached()).toBe(false);
    const touch = (type: string, clientY: number) =>
      Object.assign(new Event(type), { touches: [{ clientY }] });

    timeline.scrollElement.dispatchEvent(touch("touchstart", 300));
    timeline.scrollElement.dispatchEvent(touch("touchmove", 280));

    expect(timeline.keeper.isAttached()).toBe(true);
  });

  it("publishes the touch scroll position at touchend before a scroll event arrives", () => {
    const timeline = createTimeline(rowsOf(10));
    const reportedPositions: string[] = [];
    timeline.keeper.subscribePosition(() => {
      reportedPositions.push(timeline.keeper.getPosition().kind);
    });
    const touch = (type: string, clientY: number) =>
      Object.assign(new Event(type), { touches: [{ clientY }] });

    timeline.scrollElement.dispatchEvent(touch("touchstart", 300));
    timeline.scrollElement.scrollTop = 100;
    timeline.scrollElement.dispatchEvent(
      Object.assign(new Event("touchend"), { touches: [] }),
    );

    expect(reportedPositions).toEqual(["anchor", "anchor"]);
    expect(timeline.keeper.getPosition().kind).toBe("anchor");
  });

  it("saves a detached reader who sits at the end as at the bottom", () => {
    const rows = rowsOf(10);
    const timeline = createTimeline(rows);
    timeline.userScrollTo(1200);
    timeline.setRows(rows.slice(0, 7));
    timeline.keeper.reconcile();
    expect(timeline.keeper.isAttached()).toBe(false);

    expect(timeline.keeper.savedPosition()).toEqual({
      rowId: "",
      offsetWithinRow: 0,
      atBottom: true,
    });
  });

  it("attaches when a restored row lands at the end", () => {
    const timeline = createTimeline(rowsOf(10));

    timeline.keeper.restore({
      rowId: "row-8",
      offsetWithinRow: 0,
      atBottom: false,
    });

    expect(timeline.layout.scrollTop).toBe(timeline.layout.maxScrollTop());
    expect(timeline.keeper.isAttached()).toBe(true);
  });

  it("keeps the end in view on every layout change while attached and stays attached", () => {
    const timeline = createTimeline(rowsOf(10), { attached: true });
    expect(timeline.layout.scrollTop).toBe(timeline.layout.maxScrollTop());

    timeline.resize("row-9", 900);
    timeline.keeper.reconcile();
    expect(timeline.layout.scrollTop).toBe(timeline.layout.maxScrollTop());

    timeline.resize("row-4", 20);
    timeline.keeper.reconcile();
    timeline.scrollElement.dispatchEvent(new Event("scroll"));
    expect(timeline.layout.scrollTop).toBe(timeline.layout.maxScrollTop());
    expect(timeline.keeper.isAttached()).toBe(true);
  });

  it("stays attached when a navigation target clamps to the end, so content that grows afterwards stays in view", () => {
    const timeline = createTimeline(rowsOf(10), { attached: true });

    timeline.keeper.scrollTo(timeline.topOf("row-8") + 1600, "instant");
    expect(timeline.layout.scrollTop).toBe(timeline.layout.maxScrollTop());
    expect(timeline.keeper.isAttached()).toBe(true);

    timeline.resize("row-9", 260);
    timeline.keeper.reconcile();
    expect(timeline.layout.scrollTop).toBe(timeline.layout.maxScrollTop());
  });

  it("detaches when a navigation target lands above the end", () => {
    const timeline = createTimeline(rowsOf(10), { attached: true });

    timeline.keeper.scrollTo(400, "instant");
    expect(timeline.keeper.isAttached()).toBe(false);

    timeline.resize("row-9", 260);
    timeline.keeper.reconcile();
    expect(timeline.layout.scrollTop).toBe(400);
  });

  it("shifts content above an attached toggle by exactly the height change", () => {
    const timeline = createTimeline(rowsOf(10), { attached: true });
    const lastBottom = () => timeline.topOf("row-9") + 200;
    const bottomBefore = lastBottom();
    const toggledBefore = timeline.topOf("row-8");

    timeline.resize("row-8", 450);
    timeline.keeper.reconcile();

    expect(lastBottom()).toBe(bottomBefore);
    expect(timeline.topOf("row-8")).toBe(toggledBefore - 250);
  });

  it("keeps the reader in place through another visible row when the anchor row's key goes away", () => {
    const rows = rowsOf(10);
    const timeline = createTimeline(rows);
    timeline.userScrollTo(450);
    const before = timeline.topOf("row-4");

    timeline.setRows([
      ...rows.slice(0, 1),
      { id: "row-1-and-2", height: 120 },
      { id: "row-3-renamed", height: 200 },
      ...rows.slice(4),
    ]);
    timeline.keeper.reconcile();

    expect(timeline.topOf("row-4")).toBe(before);
  });

  it("does not write when nothing changed above the reading row", () => {
    const timeline = createTimeline(rowsOf(10));
    timeline.userScrollTo(450);
    const setter = vi.spyOn(timeline.scrollElement, "scrollTop", "set");

    timeline.resize("row-8", 600);
    timeline.keeper.reconcile();
    timeline.keeper.reconcile();

    expect(setter).not.toHaveBeenCalled();
  });

  it("corrects a row above the reading row resizing within the same reconcile", () => {
    const timeline = createTimeline(rowsOf(10));
    timeline.userScrollTo(450);
    const before = timeline.topOf("row-3");

    timeline.resize("row-1", 520);
    timeline.keeper.reconcile();

    expect(timeline.topOf("row-3")).toBe(before);
  });

  it("attaches only when the reader scrolls down into the end, and detaches when they scroll up out of it", () => {
    const timeline = createTimeline(rowsOf(10), { attached: true });
    const max = timeline.layout.maxScrollTop();

    timeline.userScrollTo(max - 2);
    expect(timeline.keeper.isAttached()).toBe(true);
    timeline.userScrollTo(max - 300);
    expect(timeline.keeper.isAttached()).toBe(false);
    timeline.userScrollTo(max - 200);
    expect(timeline.keeper.isAttached()).toBe(false);
    timeline.userScrollTo(max);
    expect(timeline.keeper.isAttached()).toBe(true);
  });

  it("attributes layout that changed before a scroll event to layout, not to the reader's movement", () => {
    const timeline = createTimeline(rowsOf(10));
    timeline.userScrollTo(450);
    const before = timeline.topOf("row-3");

    timeline.resize("row-1", 224);
    timeline.keeper.reconcile();
    timeline.userScrollTo(timeline.layout.scrollTop - 10);

    expect(timeline.topOf("row-3")).toBe(before + 10);
  });

  it("does not read scroll dimensions from the scroll handler", () => {
    const timeline = createTimeline(rowsOf(10));
    timeline.userScrollTo(450);
    timeline.scrollElement.scrollTop = 460;
    const scrollHeight = vi.spyOn(
      timeline.scrollElement,
      "scrollHeight",
      "get",
    );
    const clientHeight = vi.spyOn(
      timeline.scrollElement,
      "clientHeight",
      "get",
    );

    timeline.scrollElement.dispatchEvent(new Event("scroll"));

    expect(scrollHeight).not.toHaveBeenCalled();
    expect(clientHeight).not.toHaveBeenCalled();
  });

  it("corrects a row above the reading row that grows while the lists re-render for a scroll", () => {
    const timeline = createTimeline(rowsOf(10));
    timeline.userScrollTo(450);
    let grown = false;
    timeline.keeper.registerList({
      itemAt: () => null,
      onPositionChange: () => {
        if (grown) return;
        grown = true;
        timeline.resize("row-1", 220);
      },
    });
    const before = timeline.topOf("row-3");

    timeline.userScrollTo(440);

    expect(timeline.topOf("row-3")).toBe(before + 10);
  });

  it("adopts the rows that mount under an estimated position instead of moving the view to the estimate", () => {
    const timeline = createTimeline([]);
    const spacer = document.createElement("div");
    setFakeHeight(spacer, 6_000);
    timeline.content.prepend(spacer);
    timeline.keeper.reconcile();
    timeline.keeper.registerList({
      itemAt: (viewportTop) => ({ key: "row-1", top: viewportTop + 40 }),
      onPositionChange: () => {
        if (timeline.content.firstElementChild !== spacer) return;
        spacer.remove();
        timeline.setRows(rowsOf(20));
      },
    });

    timeline.userScrollTo(1_100);

    expect(timeline.layout.scrollTop).toBe(1_100);
    expect(timeline.topOf("row-5")).toBe(-100);
    timeline.keeper.reconcile();
    expect(timeline.layout.scrollTop).toBe(1_100);
  });

  it("measures a logarithmic number of rows per scroll event, however long the timeline is", () => {
    const measuredPerScroll = (count: number) => {
      const timeline = createTimeline(rowsOf(count, 120));
      timeline.userScrollTo(count * 60);
      const reads = vi.spyOn(Element.prototype, "getBoundingClientRect");
      timeline.userScrollTo(count * 60 - 300);
      const calls = reads.mock.calls.length;
      reads.mockRestore();
      restoreLayout?.();
      restoreLayout = null;
      document.body.replaceChildren();
      return calls;
    };

    const short = measuredPerScroll(100);
    const long = measuredPerScroll(1_000);

    expect(long - short).toBeLessThanOrEqual(15);
  });

  it("anchors the first top-level row that starts in the viewport, not a nested row above it", () => {
    const timeline = createTimeline([
      ...rowsOf(2),
      {
        id: "group",
        height: 0,
        children: [
          { id: "group-a", height: 300 },
          { id: "group-b", height: 300 },
        ],
      },
      ...rowsOf(5, 200, "after"),
    ]);
    timeline.userScrollTo(850);
    const before = timeline.topOf("after-0");

    timeline.resize("group-b", 340);
    timeline.keeper.reconcile();

    expect(timeline.topOf("after-0")).toBe(before);
  });

  it("anchors the row the reader can see, not one hidden behind the composer", () => {
    const timeline = createTimeline(rowsOf(10, 450), { footerTop: 300 });
    timeline.userScrollTo(1_000);
    const before = timeline.topOf("row-2");

    timeline.resize("row-2", 500);
    timeline.keeper.reconcile();

    expect(timeline.topOf("row-2")).toBe(before);
  });

  it("holds a correction as a transform during a touch and writes it once scrolling settles", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const rows = rowsOf(10);
    const timeline = createTimeline(rows, { deferWrites: true });
    timeline.userScrollTo(450);
    vi.advanceTimersByTime(500);
    const before = timeline.topOf("row-3");
    const setter = vi.spyOn(timeline.scrollElement, "scrollTop", "set");

    timeline.scrollElement.dispatchEvent(new TouchEvent("touchstart"));
    timeline.setRows([...rowsOf(4, 100, "older"), ...rows]);
    timeline.keeper.reconcile();
    expect(setter).not.toHaveBeenCalled();
    expect(timeline.topOf("row-3")).toBe(before);

    timeline.scrollElement.dispatchEvent(new TouchEvent("touchend"));
    vi.advanceTimersByTime(400);
    expect(setter).toHaveBeenCalled();
    expect(timeline.content.style.transform).toBe("");
    expect(timeline.topOf("row-3")).toBe(before);
  });

  it("defers a detached reader correction through the scroll-settle window", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const timeline = createTimeline(rowsOf(10), { deferWrites: true });
    timeline.userScrollTo(600);
    vi.advanceTimersByTime(40);
    const before = timeline.topOf("row-3");
    const scrollTopBefore = timeline.layout.scrollTop;
    const setter = vi.spyOn(timeline.scrollElement, "scrollTop", "set");

    timeline.resize("row-1", 240);
    timeline.keeper.reconcile();

    expect(setter).not.toHaveBeenCalled();
    expect(timeline.layout.scrollTop).toBe(scrollTopBefore);
    expect(timeline.topOf("row-3")).toBe(before);
  });

  it("keeps a touch drag that delivered no scroll events as the reader's movement", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const timeline = createTimeline(rowsOf(10), { deferWrites: true });
    timeline.userScrollTo(600);
    vi.advanceTimersByTime(500);

    timeline.scrollElement.dispatchEvent(new TouchEvent("touchstart"));
    timeline.layout.bounceTo(400);
    const after = timeline.topOf("row-3");
    timeline.scrollElement.dispatchEvent(new TouchEvent("touchend"));
    vi.advanceTimersByTime(400);
    timeline.keeper.reconcile();

    expect(timeline.layout.scrollTop).toBe(400);
    expect(timeline.topOf("row-3")).toBe(after);
  });

  it("keeps fling momentum as the reader's movement after a long frame, while correcting layout that changed with it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const timeline = createTimeline(rowsOf(10));
    timeline.userScrollTo(600);
    vi.advanceTimersByTime(500);
    timeline.scrollElement.dispatchEvent(new TouchEvent("touchstart"));
    timeline.layout.layoutScrollTo(560);
    timeline.scrollElement.dispatchEvent(new TouchEvent("touchend"));
    const before = timeline.topOf("row-3");
    vi.advanceTimersByTime(400);

    timeline.resize("row-0", 150);
    timeline.layout.layoutScrollTo(timeline.layout.scrollTop - 30);

    expect(timeline.topOf("row-3")).toBe(before + 30);
  });

  it("ends a tap whose target left the document on pointerup, so content arriving after a send keeps the reader attached", () => {
    const timeline = createTimeline(rowsOf(10), { attached: true });
    const send = document.createElement("button");
    timeline.content.append(send);
    const pointer = (type: string) =>
      Object.assign(new Event(type, { bubbles: true }), {
        pointerType: "touch",
        pointerId: 7,
      });
    send.dispatchEvent(pointer("pointerdown"));
    send.dispatchEvent(new TouchEvent("touchstart", { bubbles: true }));
    send.remove();
    window.dispatchEvent(pointer("pointerup"));

    timeline.setRows(rowsOf(12));
    timeline.keeper.reconcile();
    timeline.layout.layoutScrollTo(timeline.layout.scrollTop - 120);

    expect(timeline.keeper.isAttached()).toBe(true);
    expect(timeline.layout.scrollTop).toBe(timeline.layout.maxScrollTop());
  });

  it("ends the reader's fling session when the app scrolls to the bottom, so a send right after a fling stays attached", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const timeline = createTimeline(rowsOf(10), { attached: true });
    timeline.scrollElement.dispatchEvent(new TouchEvent("touchstart"));
    timeline.layout.layoutScrollTo(timeline.layout.scrollTop - 600);
    timeline.scrollElement.dispatchEvent(new TouchEvent("touchend"));
    vi.advanceTimersByTime(1_000);
    expect(timeline.keeper.isAttached()).toBe(false);

    timeline.keeper.scrollToBottom();
    timeline.setRows(rowsOf(12));
    timeline.keeper.reconcile();
    timeline.layout.layoutScrollTo(timeline.layout.scrollTop - 120);

    expect(timeline.keeper.isAttached()).toBe(true);
    expect(timeline.layout.scrollTop).toBe(timeline.layout.maxScrollTop());
  });

  it("does not count a send button's jump to the end as the reader's gesture when the button handles pointerup itself", () => {
    const timeline = createTimeline(rowsOf(10));
    timeline.userScrollTo(200);
    expect(timeline.keeper.isAttached()).toBe(false);
    const send = document.createElement("button");
    timeline.content.append(send);
    const pointer = (type: string) =>
      Object.assign(new Event(type, { bubbles: true }), {
        pointerType: "touch",
        pointerId: 9,
      });
    send.addEventListener("pointerup", (event) => {
      event.stopPropagation();
      timeline.keeper.scrollToBottom();
      send.remove();
    });
    send.dispatchEvent(pointer("pointerdown"));
    send.dispatchEvent(new TouchEvent("touchstart", { bubbles: true }));
    send.dispatchEvent(pointer("pointerup"));
    timeline.scrollElement.dispatchEvent(new TouchEvent("touchend"));

    timeline.setRows(rowsOf(12));
    timeline.keeper.reconcile();
    timeline.layout.layoutScrollTo(timeline.layout.scrollTop - 120);

    expect(timeline.keeper.isAttached()).toBe(true);
    expect(timeline.layout.scrollTop).toBe(timeline.layout.maxScrollTop());
  });

  it("leaves an iOS edge bounce alone instead of holding it with a transform", () => {
    const timeline = createTimeline(rowsOf(10), { deferWrites: true });
    timeline.userScrollTo(300);
    const before = timeline.topOf("row-1");

    timeline.scrollElement.dispatchEvent(new TouchEvent("touchstart"));
    timeline.layout.bounceTo(-40);
    timeline.keeper.reconcile();

    expect(timeline.content.style.transform).toBe("");
    expect(timeline.topOf("row-1")).toBe(before + 340);
  });

  it("restores a saved row at its saved offset once it mounts, and stays at the end until then", () => {
    const rows = rowsOf(10);
    const timeline = createTimeline(rows.slice(5), { attached: true });

    timeline.keeper.restore({
      rowId: "row-3",
      offsetWithinRow: 40,
      atBottom: false,
    });
    expect(timeline.layout.scrollTop).toBe(timeline.layout.maxScrollTop());

    timeline.setRows(rows);
    timeline.keeper.reconcile();

    expect(timeline.topOf("row-3")).toBe(-40);
    expect(timeline.keeper.isAttached()).toBe(false);
    expect(timeline.keeper.savedPosition()).toEqual({
      rowId: "row-4",
      offsetWithinRow: -160,
      atBottom: false,
    });
  });

  it("restores a saved row where it stays visible when the viewport is now shorter than its offset", () => {
    const timeline = createTimeline(rowsOf(10), { footerTop: 120 });

    timeline.keeper.restore({
      rowId: "row-4",
      offsetWithinRow: -300,
      atBottom: false,
    });

    expect(timeline.topOf("row-4")).toBe(72);
  });

  it("restores the exact view when the first row starting in it is too close to the bottom to restore there", () => {
    const rows = rowsOf(10).map((row) =>
      row.id === "row-2" ? { ...row, height: 480 } : row,
    );
    const first = createTimeline(rows);
    first.userScrollTo(410);
    expect(first.topOf("row-3")).toBe(470);
    const saved = first.keeper.savedPosition();
    if (saved === null) throw new Error("No saved position");
    restoreLayout?.();
    document.body.replaceChildren();

    const second = createTimeline(rows);
    second.keeper.restore(saved);

    expect(second.topOf("row-2")).toBe(-10);
    expect(second.topOf("row-3")).toBe(470);
  });

  it("keeps the reading row when every row reflows at a new width", () => {
    const timeline = createTimeline(rowsOf(10));
    timeline.userScrollTo(450);
    const before = timeline.topOf("row-3");

    for (let index = 0; index < 10; index += 1) {
      timeline.resize(`row-${index}`, 320);
    }
    timeline.keeper.reconcile();

    expect(timeline.topOf("row-3")).toBe(before);
  });
});
