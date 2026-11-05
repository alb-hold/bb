// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_COLLAPSED_CHILD_ACTIVITY } from "../model/thread-activity.js";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type { BuiltInSidebarSectionOptionsById } from "./BuiltInSidebarSection.js";

installTestPluginRuntime();
const { renderBuiltInSidebarSection } =
  await import("./BuiltInSidebarSection.js");

const SECTIONS: BuiltInSidebarSectionOptionsById = {
  pinned: {
    label: "Pinned",
    content: <div>Pinned content</div>,
  },
  threads: {
    label: "Threads",
    content: <div>Threads content</div>,
  },
};

function Slot({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function renderSections(children: ReactNode) {
  return renderSlot({ component: Slot }, { children });
}

function BuiltInSectionsProbe({ showPinned }: { showPinned: boolean }) {
  const sharedProps = {
    sections: SECTIONS,
    disabled: true,
    collapsedSectionIds: new Set<"pinned" | "threads">(),
    onToggleCollapsed: vi.fn(),
    showPinnedSection: showPinned,
  };

  return (
    <>
      {renderBuiltInSidebarSection({
        ...sharedProps,
        sectionId: "pinned",
      })}
      {renderBuiltInSidebarSection({
        ...sharedProps,
        sectionId: "threads",
      })}
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("built-in sidebar section renderer", () => {
  it("waits for observed layout before measuring the pinned overflow cue", () => {
    const callbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
      observe() {}
      disconnect() {}
    });
    const height = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(224);
    const scrollHeight = vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(400);
    renderSections(<BuiltInSectionsProbe showPinned />);
    expect(height).not.toHaveBeenCalled();
    expect(scrollHeight).not.toHaveBeenCalled();
    const content = screen.getByText("Pinned content").parentElement!;
    act(() => callbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    expect(content.hasAttribute("data-more-below")).toBe(true);
    content.scrollTop = 176;
    fireEvent.scroll(content);
    expect(content.hasAttribute("data-more-below")).toBe(false);
  });

  it("keeps clipped pinned rows opaque while preserving scrolling", () => {
    renderSections(<BuiltInSectionsProbe showPinned />);
    const content = screen.getByText("Pinned content").parentElement;
    if (!content) throw new Error("Expected pinned content viewport");
    Object.defineProperties(content, {
      clientHeight: { value: 224 },
      scrollHeight: { value: 400 },
    });
    fireEvent.scroll(content);
    expect(content.hasAttribute("data-more-below")).toBe(true);
    expect(content.className).not.toContain("mask-image");
    expect(content.className).toContain("md:max-h-[calc(7*2.5rem_+_0.75rem)]");
    content.scrollTop = 176;
    fireEvent.scroll(content);
    expect(content.hasAttribute("data-more-below")).toBe(false);
    expect(
      screen.getByText("Threads content").parentElement?.hasAttribute("data-sidebar-section-scroll"),
    ).toBe(false);
  });

  it.each([false, true])(
    "keeps Pinned in normal flow without changing Threads stickiness (collapsed: %s)",
    (collapsed) => {
      renderSections(
        <>
          {(["pinned", "threads"] as const).map((sectionId) =>
            renderBuiltInSidebarSection({
              sections: SECTIONS,
              disabled: true,
              collapsedSectionIds: new Set(collapsed ? [sectionId] : []),
              onToggleCollapsed: vi.fn(),
              sectionId,
              showPinnedSection: true,
            }),
          )}
        </>,
      );

      const header = (label: string) =>
        screen.getByTitle(label).closest('[data-sidebar-sticky-tier="label"]');

      const group = (label: string) =>
        screen.getByTitle(label).closest("[data-sidebar-sticky-group]");

      expect(header("Pinned")?.classList.contains("relative")).toBe(true);
      expect(header("Pinned")?.classList.contains("top-auto")).toBe(true);
      expect(header("Threads")?.classList.contains("relative")).toBe(false);
      expect(group("Pinned")?.getAttribute("data-sidebar-sticky-header")).toBe(
        "false",
      );
      expect(group("Threads")?.hasAttribute("data-sidebar-sticky-header")).toBe(
        false,
      );
      expect(screen.queryByText("Pinned content") !== null).toBe(!collapsed);
      if (!collapsed) {
        expect(
          screen.getByText("Pinned content").parentElement?.className,
        ).toContain("max-h-[calc(7*var(--bb-sidebar-row-height)_+_0.75rem)]");
        expect(
          screen.getByText("Pinned content").parentElement?.className,
        ).toContain("overflow-y-auto");
      }
    },
  );

  it("hides Pinned without hiding Threads, then restores Pinned", () => {
    const result = renderSections(<BuiltInSectionsProbe showPinned={false} />);

    expect(screen.queryByText("Pinned content")).toBeNull();
    expect(screen.getByText("Threads content")).not.toBeNull();

    result.rerender(
      <Slot>
        <BuiltInSectionsProbe showPinned />
      </Slot>,
    );

    expect(screen.getByText("Pinned content")).not.toBeNull();
    expect(screen.getByText("Threads content")).not.toBeNull();
    expect(result.container.querySelector('[data-icon="Pin"]')).toBeNull();
  });

  it("surfaces shared activity when Threads is collapsed", () => {
    renderSections(
      renderBuiltInSidebarSection({
        collapsedSectionIds: new Set(["threads"]),
        disabled: true,
        onToggleCollapsed: vi.fn(),
        sectionId: "threads",
        sections: {
          ...SECTIONS,
          threads: {
            ...SECTIONS.threads,
            activity: {
              ...NO_COLLAPSED_CHILD_ACTIVITY,
              goal: true,
              working: true,
            },
          },
        },
        showPinnedSection: false,
      }),
    );

    expect(screen.queryByText("Threads content")).toBeNull();
    expect(
      Array.from(
        document.querySelectorAll("[data-thread-status-glyph]"),
        (glyph) => glyph.getAttribute("data-thread-status-glyph"),
      ),
    ).toEqual(["working"]);
  });
});
