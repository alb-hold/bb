// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollapsibleHeader, ExpandablePanel } from "./disclosure";
import { layoutAnimationInFlightCountAtom } from "./layoutAnimationAtoms.js";

class ResizeObserverStub implements ResizeObserver {
  static instances: ResizeObserverStub[] = [];

  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this);
  }

  observe: ResizeObserver["observe"] = vi.fn();
  unobserve: ResizeObserver["unobserve"] = vi.fn();
  disconnect: ResizeObserver["disconnect"] = vi.fn();
}

afterEach(() => {
  ResizeObserverStub.instances.length = 0;
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function renderPanel(isExpanded: boolean) {
  return render(
    <ExpandablePanel
      isExpanded={isExpanded}
      summaryContent="Tool call"
      headerToneClass="text-foreground"
      collapsedContent={<span>Collapsed summary</span>}
    >
      <span>Expanded body</span>
    </ExpandablePanel>,
  );
}

function fireResize(entries: ResizeObserverEntry[] = []): void {
  const observer = ResizeObserverStub.instances.at(-1);
  if (!observer) {
    throw new Error("No ResizeObserver was installed");
  }
  act(() => {
    observer.callback(entries, observer);
  });
}

describe("ExpandablePanel body height", () => {
  it("lets resize observation measure mounting and streaming content without synchronous layout reads", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const readHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get");
    const view = renderPanel(true);
    view.rerender(
      <ExpandablePanel
        isExpanded
        summaryContent="Tool call"
        headerToneClass="text-foreground"
        collapsedContent={<span>Collapsed summary</span>}
      >
        <span>Streaming body update</span>
      </ExpandablePanel>,
    );
    expect(readHeight).not.toHaveBeenCalled();
    const target = screen.getByText("Streaming body update").parentElement
      ?.parentElement;
    if (!target) throw new Error("Panel content was not rendered");
    fireResize([
      {
        target,
        borderBoxSize: [{ blockSize: 120, inlineSize: 320 }],
        contentBoxSize: [{ blockSize: 120, inlineSize: 320 }],
        devicePixelContentBoxSize: [],
        contentRect: new DOMRect(0, 0, 320, 120),
      },
    ]);
    expect(target.parentElement?.style.height).toBe("120px");
    expect(readHeight).not.toHaveBeenCalled();
  });

  it("snaps content growth inside an open body but eases the toggle", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const view = renderPanel(true);
    const region =
      view.getByText("Expanded body").parentElement?.parentElement
        ?.parentElement;
    if (!region) {
      throw new Error("Panel body region was not rendered");
    }

    expect(region.style.transitionDuration).toBe("0s");

    fireResize();
    expect(region.style.transitionDuration).toBe("0s");

    view.rerender(
      <ExpandablePanel
        isExpanded={false}
        summaryContent="Tool call"
        headerToneClass="text-foreground"
        collapsedContent={<span>Collapsed summary</span>}
      >
        <span>Expanded body</span>
      </ExpandablePanel>,
    );
    expect(region.style.transitionDuration).toBe("");
    fireResize();
    expect(region.style.transitionDuration).toBe("");

    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 10_000);
    fireResize();
    expect(region.style.transitionDuration).toBe("0s");
  });
});

function TogglablePanel({
  collapsedContent,
}: {
  collapsedContent?: ReactNode;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  return (
    <ExpandablePanel
      isExpanded={isExpanded}
      summaryContent="Tool call"
      headerToneClass="text-foreground"
      onToggle={() => setIsExpanded((expanded) => !expanded)}
      collapsedContent={collapsedContent}
    >
      <span>Expanded body</span>
    </ExpandablePanel>
  );
}

describe("ExpandablePanel deferred body realization", () => {
  it("flips the caret in the tap's commit and mounts the body in a deferred one", () => {
    render(<TogglablePanel />);
    const header = screen.getByRole("button", { name: "Tool call" });

    let bodyMountedInToggleCommit: boolean | null = null;
    let headerExpandedInToggleCommit: string | null = null;
    act(() => {
      flushSync(() => {
        header.click();
      });
      bodyMountedInToggleCommit = screen.queryByText("Expanded body") !== null;
      headerExpandedInToggleCommit = header.getAttribute("aria-expanded");
    });

    expect(headerExpandedInToggleCommit).toBe("true");
    expect(bodyMountedInToggleCommit).toBe(false);
    expect(screen.getByText("Expanded body")).toBeTruthy();
  });

  it("keeps the closing body mounted through the collapse animation", () => {
    vi.useFakeTimers();
    render(<TogglablePanel />);
    const header = screen.getByRole("button", { name: "Tool call" });
    fireEvent.click(header);
    const body = screen.getByText("Expanded body");

    fireEvent.click(header);

    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Expanded body")).toBe(body);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("Expanded body")).toBeNull();
  });

  it("keeps the preview, its height and the in-flight window until the body's commit", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.textContent?.length ?? 0;
      },
    );
    vi.useFakeTimers();
    const store = createStore();
    render(
      <Provider store={store}>
        <TogglablePanel collapsedContent={<span>Collapsed summary</span>} />
      </Provider>,
    );
    const header = screen.getByRole("button", { name: "Tool call" });
    const preview = screen.getByText("Collapsed summary");
    const region = preview.parentElement?.parentElement;
    if (!region) {
      throw new Error("Panel body region was not rendered");
    }
    fireResize();
    const previewHeight = `${"Collapsed summary".length}px`;
    const bodyHeight = `${"Expanded body".length}px`;
    expect(region.style.height).toBe(previewHeight);

    let toggleCommit: {
      ariaExpanded: string | null;
      previewMounted: boolean;
      height: string;
      transitionDuration: string;
      inFlight: number;
    } | null = null;
    act(() => {
      flushSync(() => {
        header.click();
      });
      toggleCommit = {
        ariaExpanded: header.getAttribute("aria-expanded"),
        previewMounted: preview.isConnected,
        height: region.style.height,
        transitionDuration: region.style.transitionDuration,
        inFlight: store.get(layoutAnimationInFlightCountAtom),
      };
    });

    expect(toggleCommit).toEqual({
      ariaExpanded: "true",
      previewMounted: true,
      height: previewHeight,
      transitionDuration: "0s",
      inFlight: 0,
    });

    expect(screen.queryByText("Collapsed summary")).toBeNull();
    expect(screen.getByText("Expanded body")).toBeTruthy();
    expect(region.style.height).toBe(bodyHeight);
    expect(region.style.transitionDuration).toBe("");
    expect(store.get(layoutAnimationInFlightCountAtom)).toBe(1);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(store.get(layoutAnimationInFlightCountAtom)).toBe(0);
  });

  it("reuses the retained body when a reopen lands inside the close window", () => {
    vi.useFakeTimers();
    render(<TogglablePanel />);
    const header = screen.getByRole("button", { name: "Tool call" });
    fireEvent.click(header);
    const region = screen.getByText("Expanded body").closest("[aria-hidden]");
    if (!region) {
      throw new Error("Panel body region was not rendered");
    }

    fireEvent.click(header);
    expect(region.getAttribute("aria-hidden")).toBe("true");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const body = screen.getByText("Expanded body");

    let reopenCommitBody: Element | null = null;
    let reopenCommitAriaHidden: string | null = null;
    act(() => {
      flushSync(() => {
        header.click();
      });
      reopenCommitBody = screen.queryByText("Expanded body");
      reopenCommitAriaHidden = region.getAttribute("aria-hidden");
    });

    expect(reopenCommitBody).toBe(body);
    expect(reopenCommitAriaHidden).toBe("false");
    expect(screen.getByText("Expanded body")).toBe(body);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByText("Expanded body")).toBe(body);
  });
});

it.each(["Ran 1 command", "Ran 1 tool"])(
  "reserves an unclipped touch extension for %s between adjacent panels",
  (summary) => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const { container } = render(
      <div data-timeline-items="">
        {[summary, "Next tool"].map((label) => (
          <div data-timeline-row-id={label} key={label}>
            <ExpandablePanel
              isExpanded={false}
              summaryContent={label}
              headerToneClass="text-muted-foreground"
              onToggle={vi.fn()}
            >
              Expanded body
            </ExpandablePanel>
          </div>
        ))}
      </div>,
    );
    const header = screen.getByRole("button", { name: summary });
    expect(header.hasAttribute("data-compact-touch-summary")).toBe(true);
    expect(header.classList.contains("overflow-visible")).toBe(true);
    expect(
      header.parentElement?.hasAttribute("data-timeline-disclosure-header"),
    ).toBe(true);
    for (
      let node: HTMLElement | null = header;
      node && node !== container;
      node = node.parentElement
    ) {
      expect(node.className).not.toMatch(
        /(?:^| )overflow-(?:hidden|clip)(?: |$)/,
      );
      expect(node.style.overflow).not.toMatch(/hidden|clip/);
      expect(node.style.clipPath).toBe("");
    }
  },
);

it.each(["Ran 1 command", "Ran 1 tool", "Worked for 1s"])(
  "shows a secondary-ink chevron at rest for %s and rotates it when opened",
  (summary) => {
    const onToggle = vi.fn();
    const view = render(
      <CollapsibleHeader
        summaryContent={summary}
        toneClassName="text-muted-foreground"
        onToggle={onToggle}
      />,
    );
    const header = screen.getByRole("button", { name: summary });
    expect(header.hasAttribute("data-compact-touch-summary")).toBe(true);
    const chevron = header.querySelector("svg");
    expect(chevron?.classList.contains("opacity-100")).toBe(true);
    expect(chevron?.classList.contains("text-muted-foreground")).toBe(true);
    fireEvent.click(header);
    expect(onToggle).toHaveBeenCalledOnce();
    view.rerender(
      <CollapsibleHeader
        summaryContent={summary}
        toneClassName="text-foreground"
        onToggle={onToggle}
        isExpanded
      />,
    );
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(chevron?.classList.contains("rotate-90")).toBe(true);
  },
);
