// @vitest-environment jsdom

import { useState } from "react";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PluginProvidersState,
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useSidebarSortable,
  type SidebarSortableDragBindings,
} from "@/components/ui/sortable-motion";
import { useSidebarReorderDnd } from "@/components/ui/use-sidebar-reorder-dnd";
import { SidebarTouchSensor } from "../dnd/sidebarTouchSensor.js";
import {
  makePluginProject,
  makeSidebarEnvironment,
  makeSidebarThread,
} from "../model/fixtures.js";
import { SidebarProjectNamesContext } from "../model/use-sidebar-data.js";
import { SidebarRowMetadataExperiment } from "../list/SidebarRowMetadataExperiment.js";
import {
  CustomizeRowActionsContext,
  ThreadRowActionsCustomizingContext,
} from "../list/customizeRowActionsContext.js";
import {
  threadListPullRequestRpcContract,
  type ThreadListPullRequest,
} from "./pull-request-query.js";
import { SidebarRenameProvider } from "./SidebarInlineRename.js";
import type { ThreadRowOptions } from "./ThreadRow.js";

installTestPluginRuntime();

const { SidebarDraftPresenceSync } =
  await import("../list/sidebarDraftPresence.js");
const { ThreadRowNavigationProvider } =
  await import("./threadRowNavigation.js");
const { ThreadSelectionProvider } =
  await import("../selection/threadSelection.js");
const { SidebarProvidersContext, ThreadRow } = await import("./ThreadRow.js");
const { TopLevelSidebarSection } =
  await import("../list/TopLevelSidebarSection.js");
const { SidebarSectionRow } = await import("../list/SidebarSectionRow.js");

const INTERACTIVE_SELECTOR =
  'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [tabindex]:not([tabindex="-1"])';

function findNestedInteractivePairs(root: ParentNode): Array<{
  outer: Element;
  inner: Element;
}> {
  const pairs: Array<{ outer: Element; inner: Element }> = [];
  for (const element of root.querySelectorAll(INTERACTIVE_SELECTOR)) {
    for (const descendant of element.querySelectorAll(INTERACTIVE_SELECTOR)) {
      if (descendant !== element) {
        pairs.push({ outer: element, inner: descendant });
      }
    }
  }
  return pairs;
}

function makeDragBindings(
  overrides: Partial<SidebarSortableDragBindings> = {},
): SidebarSortableDragBindings {
  return {
    attributes: {
      role: "button",
      tabIndex: 0,
      "aria-disabled": false,
      "aria-pressed": undefined,
      "aria-roledescription": "sortable",
      "aria-describedby": "dnd-sortable-item",
    },
    disabled: false,
    isDragging: false,
    listeners: {
      onMouseDown: vi.fn(),
      onTouchStart: vi.fn(),
    },
    setActivatorNodeRef: vi.fn(),
    ...overrides,
  };
}

function stubVerticalRects(elements: readonly HTMLElement[], rowHeight = 32) {
  elements.forEach((element, index) => {
    const top = index * rowHeight;
    const rect = {
      x: 0,
      y: top,
      left: 0,
      top,
      right: 240,
      bottom: top + rowHeight,
      width: 240,
      height: rowHeight,
      toJSON: () => ({}),
    } satisfies DOMRect;
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
  });
}

const DEFAULT_OPTIONS: ThreadRowOptions = {
  kind: "default",
  depth: 0,
  isCompact: false,
};

const TEST_PROVIDER: PluginProvidersState["providers"][number] = {
  id: "claude",
  pluginId: "provider-claude-code",
  displayName: "Claude",
  logoUrl: "/claude.svg",
  available: true,
  maintenance: { health: false, usage: false, installation: false },
  capabilities: {
    supportsThreadArchive: true,
    supportsThreadRename: true,
    supportsServiceTier: false,
    supportsNativeUserQuestion: false,
    supportsFork: true,
    supportsSessionRewind: false,
    modelCatalogScope: "workspace",
    permissionModes: ["accept-edits", "auto", "full"],
  },
  composerActions: [],
  completedTurnDisplay: "collapse",
};

function renderThreadRowA11y({
  thread = makeSidebarThread(),
  projects = [],
  providers = [TEST_PROVIDER],
  isCompactViewport = false,
  options = DEFAULT_OPTIONS,
  pullRequest,
}: {
  thread?: PluginSidebarThread;
  projects?: PluginSidebarProject[];
  providers?: PluginProvidersState["providers"];
  isCompactViewport?: boolean;
  options?: ThreadRowOptions;
  pullRequest?: ThreadListPullRequest;
} = {}) {
  function Harness() {
    return (
      <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
        <SidebarRowMetadataExperiment>
          <SidebarProjectNamesContext.Provider
            value={new Map(projects.map((p) => [p.id, p.name]))}
          >
            <SidebarProvidersContext.Provider value={providers}>
              <TooltipProvider>
                <SidebarDraftPresenceSync />
                <ThreadRowNavigationProvider>
                  <ThreadSelectionProvider activeThreadId={null}>
                    <SidebarRenameProvider>
                      <CustomizeRowActionsContext.Provider value={null}>
                        <ThreadRowActionsCustomizingContext.Provider
                          value={null}
                        >
                          <ThreadRow
                            thread={thread}
                            crossProjectId={null}
                            isActive={false}
                            options={options}
                          />
                        </ThreadRowActionsCustomizingContext.Provider>
                      </CustomizeRowActionsContext.Provider>
                    </SidebarRenameProvider>
                  </ThreadSelectionProvider>
                </ThreadRowNavigationProvider>
              </TooltipProvider>
            </SidebarProvidersContext.Provider>
          </SidebarProjectNamesContext.Provider>
        </SidebarRowMetadataExperiment>
      </CompactViewportOverrideProvider>
    );
  }

  return renderSlot(
    { component: Harness },
    {},
    {
      sidebarThreads: { threads: [thread], projects },
      providers: { providers },
      experimental_rpcContract: threadListPullRequestRpcContract,
      rpc: {
        pullRequests: (input) => {
          const { keys } =
            threadListPullRequestRpcContract.pullRequests.input.parse(input);
          return Object.fromEntries(
            keys.flatMap((key) =>
              pullRequest && key === thread.environment?.id
                ? [[key, { outcome: "available", pullRequest }]]
                : [],
            ),
          );
        },
      },
    },
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("sidebar and drawer row accessibility", () => {
  it("renders ThreadRow with drag bindings, PR chip, and child toggle without nested interactive controls", async () => {
    const onMouseDown = vi.fn();
    const onTouchStart = vi.fn();
    const dragBindings = makeDragBindings({
      listeners: { onMouseDown, onTouchStart },
    });
    const thread = makeSidebarThread({
      providerId: "claude",
      indicator: "needs-input",
      environment: makeSidebarEnvironment({ id: "env_1", isWorktree: true }),
    });
    const slot = renderThreadRowA11y({
      thread,
      pullRequest: {
        number: 23,
        title: "Fix drawer layout",
        url: "https://github.com/alb-hold/bb/pull/23",
        state: "closed",
      },
      options: {
        kind: "parent",
        depth: 0,
        isCompact: false,
        dragBindings,
        childCount: 1,
        isCollapsed: false,
        onToggleCollapsed: vi.fn(),
      },
    });

    await slot.findByRole("link", { name: /Pull request #23/ });

    expect(findNestedInteractivePairs(slot.container)).toEqual([]);

    const link = screen.getByRole("link", { name: "Open Thread" });
    fireEvent.touchStart(link);
    expect(onTouchStart).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(link);
    expect(onMouseDown).toHaveBeenCalledTimes(1);
  });

  it("renders TopLevelSidebarSection and SidebarSectionRow with drag bindings without nested interactive controls", () => {
    const dragBindings = makeDragBindings();
    function Harness() {
      return (
        <TooltipProvider>
          <TopLevelSidebarSection
            label="Pinned"
            dragBindings={dragBindings}
            collapseControl={{
              isCollapsed: false,
              onToggleCollapsed: vi.fn(),
            }}
            actions={
              <button type="button" aria-label="Pinned actions">
                Actions
              </button>
            }
          >
            <div>Item</div>
          </TopLevelSidebarSection>
          <SidebarSectionRow
            name="Planning"
            label="Planning"
            depth={0}
            collapsedThreads={[]}
            isCollapsed={false}
            onToggleCollapsed={vi.fn()}
            dragBindings={dragBindings}
            onCreateThread={vi.fn()}
          />
        </TooltipProvider>
      );
    }

    const slot = renderSlot({ component: Harness }, {});
    expect(findNestedInteractivePairs(slot.container)).toEqual([]);
  });

  it("reorders sortable ThreadRow items with keyboard Space, ArrowDown, and Space without nested interactive controls", async () => {
    const initialThreads = [
      makeSidebarThread({ id: "thr_alpha", title: "Alpha", displayTitle: "Alpha" }),
      makeSidebarThread({ id: "thr_beta", title: "Beta", displayTitle: "Beta" }),
      makeSidebarThread({ id: "thr_gamma", title: "Gamma", displayTitle: "Gamma" }),
    ];

    function SortableThreadItem({ thread }: { thread: PluginSidebarThread }) {
      const { dragBindings, setNodeRef, style } = useSidebarSortable({
        id: thread.id,
        disabled: false,
      });
      return (
        <div ref={setNodeRef} style={style} data-sortable-thread-item={thread.id}>
          <ThreadRow
            thread={thread}
            crossProjectId={null}
            isActive={false}
            options={{
              ...DEFAULT_OPTIONS,
              dragBindings,
            }}
          />
        </div>
      );
    }

    function Harness() {
      const [threads, setThreads] = useState(initialThreads);
      const handleDragEnd = (event: DragEndEvent) => {
        if (!event.over || event.active.id === event.over.id) {
          return;
        }
        setThreads((current) => {
          const oldIndex = current.findIndex((item) => item.id === event.active.id);
          const newIndex = current.findIndex((item) => item.id === event.over?.id);
          if (oldIndex < 0 || newIndex < 0) {
            return current;
          }
          return arrayMove(current, oldIndex, newIndex);
        });
      };
      const { dndContextProps } = useSidebarReorderDnd({
        onDragEnd: handleDragEnd,
        touchSensor: SidebarTouchSensor,
      });

      return (
        <CompactViewportOverrideProvider isCompactViewport={false}>
          <SidebarRowMetadataExperiment>
            <SidebarProjectNamesContext.Provider value={new Map()}>
              <SidebarProvidersContext.Provider value={[TEST_PROVIDER]}>
                <TooltipProvider>
                  <SidebarDraftPresenceSync />
                  <ThreadRowNavigationProvider>
                    <ThreadSelectionProvider activeThreadId={null}>
                      <SidebarRenameProvider>
                        <CustomizeRowActionsContext.Provider value={null}>
                          <ThreadRowActionsCustomizingContext.Provider value={null}>
                            <DndContext {...dndContextProps}>
                              <SortableContext
                                items={threads.map((thread) => thread.id)}
                                strategy={verticalListSortingStrategy}
                              >
                                {threads.map((thread) => (
                                  <SortableThreadItem
                                    key={thread.id}
                                    thread={thread}
                                  />
                                ))}
                              </SortableContext>
                            </DndContext>
                          </ThreadRowActionsCustomizingContext.Provider>
                        </CustomizeRowActionsContext.Provider>
                      </SidebarRenameProvider>
                    </ThreadSelectionProvider>
                  </ThreadRowNavigationProvider>
                </TooltipProvider>
              </SidebarProvidersContext.Provider>
            </SidebarProjectNamesContext.Provider>
          </SidebarRowMetadataExperiment>
        </CompactViewportOverrideProvider>
      );
    }

    const slot = renderSlot(
      { component: Harness },
      {},
      {
        sidebarThreads: { threads: initialThreads, projects: [] },
        providers: { providers: [TEST_PROVIDER] },
      },
    );

    expect(findNestedInteractivePairs(slot.container)).toEqual([]);

    const sortableItems = Array.from(
      slot.container.querySelectorAll<HTMLElement>("[data-sortable-thread-item]"),
    );
    stubVerticalRects(sortableItems, 32);

    const handle = screen.getByRole("button", { name: "Move Alpha" });
    expect(handle.getAttribute("role")).toBe("button");
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-roledescription")).toBe("sortable");

    act(() => {
      handle.focus();
    });
    expect(document.activeElement).toBe(handle);

    fireEvent.keyDown(handle, { key: " ", code: "Space" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.keyDown(document, { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.keyDown(document, { key: " ", code: "Space" });

    const orderedLinks = screen
      .getAllByRole("link", { name: /^Open / })
      .map((element) => element.getAttribute("aria-label"));
    expect(orderedLinks).toEqual(["Open Beta", "Open Alpha", "Open Gamma"]);
  });

  it("reorders sortable TopLevelSidebarSection headers with keyboard Space, ArrowDown, and Space", async () => {
    const initialSections = [
      { id: "pinned", label: "Pinned" },
      { id: "recents", label: "Recents" },
    ];

    function SortableSectionItem({
      id,
      label,
    }: {
      id: string;
      label: string;
    }) {
      const { dragBindings, setNodeRef, style } = useSidebarSortable({
        id,
        disabled: false,
      });
      return (
        <div ref={setNodeRef} style={style} data-sortable-section-item={id}>
          <TopLevelSidebarSection
            label={label}
            dragBindings={dragBindings}
            collapseControl={{
              isCollapsed: false,
              onToggleCollapsed: vi.fn(),
            }}
          >
            <div>{`${label} body`}</div>
          </TopLevelSidebarSection>
        </div>
      );
    }

    function Harness() {
      const [sections, setSections] = useState(initialSections);
      const handleDragEnd = (event: DragEndEvent) => {
        if (!event.over || event.active.id === event.over.id) {
          return;
        }
        setSections((current) => {
          const oldIndex = current.findIndex((item) => item.id === event.active.id);
          const newIndex = current.findIndex((item) => item.id === event.over?.id);
          if (oldIndex < 0 || newIndex < 0) {
            return current;
          }
          return arrayMove(current, oldIndex, newIndex);
        });
      };
      const { dndContextProps } = useSidebarReorderDnd({
        onDragEnd: handleDragEnd,
        touchSensor: SidebarTouchSensor,
      });

      return (
        <TooltipProvider>
          <DndContext {...dndContextProps}>
            <SortableContext
              items={sections.map((section) => section.id)}
              strategy={verticalListSortingStrategy}
            >
              {sections.map((section) => (
                <SortableSectionItem
                  key={section.id}
                  id={section.id}
                  label={section.label}
                />
              ))}
            </SortableContext>
          </DndContext>
        </TooltipProvider>
      );
    }

    const slot = renderSlot({ component: Harness }, {});
    expect(findNestedInteractivePairs(slot.container)).toEqual([]);

    const sortableItems = Array.from(
      slot.container.querySelectorAll<HTMLElement>("[data-sortable-section-item]"),
    );
    stubVerticalRects(sortableItems, 48);

    const handle = screen.getByRole("button", { name: "Move Pinned section" });
    expect(handle.getAttribute("role")).toBe("button");
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-roledescription")).toBe("sortable");

    act(() => {
      handle.focus();
    });
    expect(document.activeElement).toBe(handle);

    fireEvent.keyDown(handle, { key: " ", code: "Space" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.keyDown(document, { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.keyDown(document, { key: " ", code: "Space" });

    const orderedSections = Array.from(
      slot.container.querySelectorAll<HTMLElement>("[data-sortable-section-item]"),
    ).map((element) => element.dataset.sortableSectionItem);
    expect(orderedSections).toEqual(["recents", "pinned"]);
  });

  it("keeps the PR badge and child toggle chevron at or above the 24px touch target floor", async () => {
    const thread = makeSidebarThread({
      indicator: "needs-input",
      environment: makeSidebarEnvironment({ id: "env_target" }),
    });
    const slot = renderThreadRowA11y({
      thread,
      pullRequest: {
        number: 23,
        title: "Closed PR",
        url: "https://github.com/alb-hold/bb/pull/23",
        state: "closed",
      },
      options: {
        kind: "parent",
        depth: 0,
        isCompact: false,
        childCount: 1,
        isCollapsed: false,
        onToggleCollapsed: vi.fn(),
      },
    });

    const prChip = await slot.findByRole("link", {
      name: /Pull request #23/,
    });
    expect(prChip.classList.contains("min-h-6")).toBe(true);
    expect(prChip.classList.contains("min-w-6")).toBe(true);

    const chevron = screen.getByRole("button", {
      name: "Collapse Thread threads",
    });
    expect(chevron.classList.contains("size-6")).toBe(true);
    expect(chevron.classList.contains("size-5")).toBe(false);
    expect(chevron.classList.contains("size-4")).toBe(false);
  });

  it("uses the AA-contrast destructive-text token on closed PR badges", async () => {
    const thread = makeSidebarThread({
      environment: makeSidebarEnvironment({ id: "env_closed_pr" }),
    });
    const slot = renderThreadRowA11y({
      thread,
      pullRequest: {
        number: 23,
        title: "Closed PR",
        url: "https://github.com/alb-hold/bb/pull/23",
        state: "closed",
      },
    });

    const prChip = await slot.findByRole("link", {
      name: /Pull request #23/,
    });
    expect(prChip.classList.contains("text-destructive-text")).toBe(true);
    expect(prChip.classList.contains("text-destructive")).toBe(false);
  });

  it("keeps phone drawer rows to two lines with a top-aligned provider icon and row spacing", () => {
    const project = makePluginProject({ id: "proj_seahaven", name: "seahaven" });
    const thread = makeSidebarThread({
      projectId: project.id,
      providerId: "claude",
      title: "Review the Clarified implementation details across services",
      displayTitle: "Review the Clarified implementation details across services",
      updatedAt: Date.now() - 600_000,
      environment: makeSidebarEnvironment({
        id: "env_phone",
        name: null,
        branchName: "bb/serves-p3-identical-prefix-thr_zzu7nae7rh",
        isWorktree: true,
      }),
    });
    const slot = renderThreadRowA11y({
      thread,
      projects: [project],
      isCompactViewport: true,
    });

    const row = slot.container.querySelector("[data-sidebar-rename-row]");
    const leading = slot.container.querySelector("[data-sidebar-thread-leading]");
    const title = slot.container.querySelector(".bb-thread-title");
    const context = slot.container.querySelector("[data-sidebar-thread-context]");
    const branch = slot.container.querySelector(
      "[data-sidebar-thread-phone-context]",
    );

    expect(row).not.toBeNull();
    expect(row?.classList.contains("py-1")).toBe(true);
    expect(leading?.classList.contains("self-start")).toBe(true);
    expect(leading?.classList.contains("mt-0.5")).toBe(true);
    expect(title?.classList.contains("truncate")).toBe(true);
    expect(context?.classList.contains("max-md:flex-col")).toBe(false);
    expect(context?.classList.contains("max-md:items-stretch")).toBe(false);
    expect(context?.classList.contains("flex")).toBe(true);
    expect(branch).not.toBeNull();
    expect(branch?.firstElementChild?.classList.contains("truncate")).toBe(true);
    expect(branch?.lastElementChild?.classList.contains("shrink-0")).toBe(true);
  });
});
