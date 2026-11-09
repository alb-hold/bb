// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AutoHeightContainer } from "@/components/ui/height-transition";
import { ScrollPositionKeeper } from "@/components/ui/scroll-position-keeper";
import { TimelineWindowedItems } from "./TimelineWindowedItems.js";

class ResizeObserverStub implements ResizeObserver {
  static instances: ResizeObserverStub[] = [];
  readonly targets = new Set<Element>();

  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  ResizeObserverStub.instances = [];
  document.body.replaceChildren();
});

it.each([
  { attached: true, widthDriven: true },
  { attached: false, widthDriven: true },
  { attached: true, widthDriven: false },
  { attached: false, widthDriven: false },
])(
  "holds the reading position during a width change before the enclosing height observer runs ($attached, $widthDriven)",
  ({ attached, widthDriven }) => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const area = document.createElement("div");
    const content = document.createElement("div");
    area.append(content);
    document.body.append(area);
    let width = 960;
    let growth = 0;
    let scrollTop = 0;
    const height = (element: Element): number => {
      if (!(element instanceof HTMLElement)) return 0;
      if (element.dataset.timelineRowId !== undefined) {
        const child = element.firstElementChild;
        const effectiveWidth =
          child instanceof HTMLElement
            ? Number.parseFloat(child.style.width) || width
            : width;
        return (
          69 +
          (element.dataset.timelineRowId === "row-67" &&
          (!widthDriven || effectiveWidth <= 480)
            ? growth
            : 0)
        );
      }
      const fixed = Number.parseFloat(element.style.height);
      if (Number.isFinite(fixed)) return fixed;
      const children = [...element.children];
      const gap = Number.parseFloat(element.style.gap) || 0;
      return (
        children.reduce((sum, child) => sum + height(child), 0) +
        Math.max(0, children.length - 1) * gap
      );
    };
    Object.defineProperties(area, {
      clientHeight: { get: () => 752 },
      clientWidth: { get: () => width },
      scrollHeight: { get: () => height(content) },
      scrollTop: {
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, height(content) - 752));
        },
      },
    });
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(
      () => width,
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return height(this);
      },
    );
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        if (this === area) return new DOMRect(0, 0, width, 752);
        let top = -scrollTop;
        let current: Element | null = this;
        while (current !== null && current !== area) {
          const siblings: HTMLCollection | undefined =
            current.parentElement?.children;
          const gap =
            Number.parseFloat(current.parentElement?.style.gap ?? "") || 0;
          for (const sibling of siblings ?? []) {
            if (sibling === current) break;
            top += height(sibling) + gap;
          }
          current = current.parentElement;
        }
        const effectiveWidth =
          this instanceof HTMLElement
            ? Number.parseFloat(this.style.width) || width
            : width;
        return new DOMRect(0, top, effectiveWidth, height(this));
      },
    );
    const keeper = new ScrollPositionKeeper({
      bottomThresholdPx: 4,
      deferWritesWhileScrolling: false,
      getContentElement: () => content,
      getFloorElement: () => null,
      getFooterElement: () => null,
      getScrollElement: () => area,
      getTopLevelRows: () =>
        content.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
      initiallyAttached: true,
    });
    const itemKeys = Array.from({ length: 80 }, (_, index) => `row-${index}`);
    render(
      <AutoHeightContainer animateGrowth={false}>
        <TimelineWindowedItems
          itemKeys={itemKeys}
          measurements={new Map()}
          estimateItemHeight={() => 69}
          gap={4}
          positionKeeper={keeper}
          pinnedToEnd
          renderItem={(index, state) => (
            <div
              key={itemKeys[index]}
              ref={state.itemRef}
              data-timeline-row-id={itemKeys[index]}
              data-timeline-window-key={itemKeys[index]}
            />
          )}
        />
      </AutoHeightContainer>,
      { container: content },
    );
    const disconnect = keeper.connect(area);
    try {
      const above = content.querySelector<HTMLElement>(
        '[data-timeline-row-id="row-67"]',
      );
      const anchor = content.querySelector<HTMLElement>(
        '[data-timeline-row-id="row-73"]',
      );
      if (above === null || anchor === null)
        throw new Error("Windowed rows missing");
      const observer = ResizeObserverStub.instances.find((candidate) =>
        candidate.targets.has(above),
      );
      if (observer === undefined) throw new Error("Row observer missing");
      const emit = () =>
        observer.callback(
          [
            {
              target: above,
              borderBoxSize: [{ inlineSize: width, blockSize: height(above) }],
              contentBoxSize: [{ inlineSize: width, blockSize: height(above) }],
              devicePixelContentBoxSize: [
                { inlineSize: width, blockSize: height(above) },
              ],
              contentRect: new DOMRect(0, 0, width, height(above)),
            },
          ],
          observer,
        );
      act(emit);
      if (!attached)
        act(() => keeper.scrollTo(area.scrollTop - 100, "instant"));
      expect(keeper.isAttached()).toBe(attached);
      expect(above.getBoundingClientRect().bottom).toBeLessThan(0);
      const before = {
        scrollTop: area.scrollTop,
        top: anchor.getBoundingClientRect().top,
      };
      const wrapper = content.querySelector<HTMLElement>(
        "[data-compact-touch-height]",
      );
      const priorHeight = wrapper?.style.height;
      width = 480;
      growth = 24;

      emit();

      const expectedGrowth = widthDriven ? 0 : 24;
      expect(wrapper?.style.height).toBe(
        `${Number.parseFloat(priorHeight ?? "") + expectedGrowth}px`,
      );
      expect(area.scrollTop).toBe(before.scrollTop + expectedGrowth);
      expect(anchor.getBoundingClientRect().top).toBe(before.top);
      expect(keeper.isAttached()).toBe(attached);
      if (widthDriven) {
        expect(above.getBoundingClientRect().height).toBe(69);
        expect(above.getBoundingClientRect().width).toBe(480);
        expect(anchor.getBoundingClientRect().width).toBe(480);
        const retainedContent = above.firstElementChild;

        for (const nextWidth of [960, 640, 480]) {
          width = nextWidth;
          emit();
          expect(above.getBoundingClientRect().width).toBe(nextWidth);
          expect(above.getBoundingClientRect().height).toBe(69);
          expect(anchor.getBoundingClientRect().top).toBe(before.top);
        }

        act(() => keeper.scrollTo(area.scrollTop - 500, "instant"));

        expect(above.firstElementChild).toBe(retainedContent);
        expect(above.getBoundingClientRect().top).toBeGreaterThan(0);
        expect(above.getBoundingClientRect().width).toBe(480);
        expect(above.getBoundingClientRect().height).toBe(93);
      }
    } finally {
      disconnect();
    }
  },
);
