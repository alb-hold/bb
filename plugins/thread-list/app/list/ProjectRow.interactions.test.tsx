// @vitest-environment jsdom

import { ThreadRowNavigationProvider } from "../rows/threadRowNavigation.js";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ReactNode } from "react";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarRenameProvider } from "../rows/SidebarInlineRename.js";
import { Provider, createStore } from "jotai";
import {
  installTestPluginRuntime,
  renderSlot,
  type PluginSdkTestFakes,
  type RenderedSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type { SectionThreadDndState } from "../dnd/useSectionThreadDnd.js";
import type { ProjectThreadListState } from "./ProjectRow.js";
import { buildPinnedSidebarState } from "../model/pinned-sidebar-threads.js";
import { buildSidebarEntitySectionId } from "../model/sidebar-section-order.js";
import {
  makeSidebarEnvironment,
  makeSidebarProject,
  makeSidebarThread,
  sdkResult,
  type SidebarThreadOverrides,
} from "../model/fixtures.js";
import {
  sidebarHiddenGroupsAtom,
  sidebarManualSectionOrderAtom,
  sidebarOrganizationModeAtom,
} from "../preferences/atoms.js";

installTestPluginRuntime();
const {
  ChronologicalSectionThreadSections,
  ProjectRow,
  PinnedEnvironmentThreadGroupRow,
  ThreadTreeNodeRow,
} = await import("./ProjectRow.js");
const { ThreadCreationPlacementScope } =
  await import("./ThreadCreationPlacement.js");
const { useSidebarModeSectionOrder } =
  await import("./useSidebarModeSectionOrder.js");
const { SidebarHeaderControls } = await import("./SidebarHeaderControls.js");
const { SidebarDraftPresenceSync } = await import("./sidebarDraftPresence.js");
const { ThreadListVisibilityMenuItems } =
  await import("./ThreadListVisibility.js");

function makeThread(overrides: SidebarThreadOverrides = {}): SidebarThread {
  return makeSidebarThread({
    id: "thr_test",
    title: "Test thread",
    titleFallback: "Test thread",
    lastReadAt: 100,
    latestAttentionAt: 100,
    createdAt: 0,
    updatedAt: 100,
    ...overrides,
  });
}

function makeSectionDnd(
  overrides: Partial<SectionThreadDndState> = {},
): SectionThreadDndState {
  return {
    activeItemId: null,
    draggedThreadIds: null,
    activeThread: makeThread({
      id: "thr_dragged",
      title: "Dragged",
      titleFallback: "Dragged",
    }),
    consumeClickSuppression: () => false,
    dndContextProps: {},
    dragOverParentKey: null,
    unchangedParentKey: null,
    itemIdsByParentKey: new Map(),
    nestTarget: null,
    nestPreviewBeforeKey: null,
    onClickCapture: () => undefined,
    pinnedItemIds: [],
    pinnedReorderPending: false,
    reorderTarget: null,
    ...overrides,
  };
}

interface HarnessProps {
  children: ReactNode;
  store: ReturnType<typeof createStore>;
}

function Harness({ children, store }: HarnessProps) {
  return (
    <TooltipProvider>
      <SidebarDraftPresenceSync />
      <Provider store={store}>
        <ThreadRowNavigationProvider>
          <SidebarRenameProvider>{children}</SidebarRenameProvider>
        </ThreadRowNavigationProvider>
      </Provider>
    </TooltipProvider>
  );
}

interface RenderTreeOptions {
  threads?: readonly SidebarThread[];
  draftThreadIds?: readonly string[];
  sdk?: PluginSdkTestFakes;
  store?: ReturnType<typeof createStore>;
}

function renderTree(
  children: ReactNode,
  { threads = [], draftThreadIds = [], sdk, store }: RenderTreeOptions = {},
): RenderedSlot {
  return renderSlot(
    { component: Harness },
    { children, store: store ?? createStore() },
    {
      sidebarThreads: {
        threads,
        projects: [makeSidebarProject()],
      },
      sidebarDraftThreadIds: draftThreadIds,
      sdk,
    },
  );
}

function renderPinnedParentWithChild({
  isCollapsed,
  sectionDnd,
}: {
  isCollapsed: boolean;
  sectionDnd: SectionThreadDndState;
}) {
  const parent = makeThread({
    id: "thr_parent",
    title: "Parent",
    titleFallback: "Parent",
    pinnedAt: 1,
  });
  const child = makeThread({
    id: "thr_child",
    title: "Child",
    titleFallback: "Child",
    parentThreadId: "thr_parent",
  });
  const node = buildPinnedSidebarState({ threads: [parent, child] })
    .rootNodes[0];
  const { container } = renderTree(
    <ThreadTreeNodeRow
      projectId="proj_test"
      node={node}
      depthOffset={0}
      isEnvGrouped={false}
      collapsedThreadIds={isCollapsed ? new Set(["thr_parent"]) : new Set()}
      collapsedEnvironmentIds={new Set()}
      onToggleThreadCollapsed={vi.fn()}
      onToggleEnvironmentCollapsed={vi.fn()}
      sectionDnd={sectionDnd}
      sortableRef={() => undefined}
    />,
    { threads: [parent, child] },
  );
  return container;
}

function renderProjectRow(
  onToggleProjectCollapsed = vi.fn(),
  threadListState: ProjectThreadListState = { status: "ready", threads: [] },
  isActive = false,
  collapsedEnvironmentIds: Set<string> = new Set(),
  isCollapsed = false,
  options: Omit<RenderTreeOptions, "threads"> = {},
) {
  const onToggleEnvironmentCollapsed = vi.fn();
  const store = createStore();
  store.set(sidebarOrganizationModeAtom, "project");
  const result = renderTree(
    <ProjectRow
      project={makeSidebarProject()}
      threadListState={threadListState}
      isActive={isActive}
      isCollapsed={isCollapsed}
      compareThreads={() => 0}
      collapsedThreadIds={new Set()}
      collapsedEnvironmentIds={collapsedEnvironmentIds}
      onToggleProjectCollapsed={onToggleProjectCollapsed}
      onToggleThreadCollapsed={vi.fn()}
      onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
    />,
    {
      threads:
        threadListState.status === "ready" ? threadListState.threads : [],
      store,
      ...options,
    },
  );
  return { ...result, onToggleEnvironmentCollapsed, onToggleProjectCollapsed };
}

function renderedIndicators(): Array<string | null> {
  return Array.from(
    document.querySelectorAll("[data-thread-status-glyph]"),
    (glyph) => glyph.getAttribute("data-thread-status-glyph"),
  );
}

function expectCollapsedActivityAtSidebarEdge(indicator: string) {
  const edgeSlot = Array.from(
    document.querySelectorAll(`[data-thread-status-glyph="${indicator}"]`),
  )
    .map((indicator) =>
      indicator.closest("[data-sidebar-collapsed-activity-edge]"),
    )
    .find((slot) => slot !== null);

  expect(edgeSlot).toBeInstanceOf(HTMLElement);
}

function CustomSectionsVisibilityProbe({
  threads,
  onProjectSelect,
}: {
  threads: SidebarThread[];
  onProjectSelect: () => void;
}) {
  const { order, persistedOrder, onOrderChange } = useSidebarModeSectionOrder({
    mode: "chronological",
    entitySectionIds: ["section:sec_building", "section:sec_review"],
    showPinnedSection: false,
  });

  return (
    <ChronologicalSectionThreadSections
      threadListState={{ status: "ready", threads }}
      compareThreads={() => 0}
      sections={[
        { id: "sec_building", name: "Building" },
        { id: "sec_review", name: "Review" },
      ]}
      collapsedThreadIds={new Set()}
      collapsedEnvironmentIds={new Set()}
      onProjectSelect={onProjectSelect}
      onToggleThreadCollapsed={vi.fn()}
      onToggleEnvironmentCollapsed={vi.fn()}
      topLevelSectionOrder={order}
      fullSectionOrder={persistedOrder}
      onTopLevelSectionOrderChange={onOrderChange}
      pinnedReorderPending={false}
      pinnedThreads={[]}
      onReorderPinnedThread={vi.fn()}
      builtInSections={{
        collapsedSectionIds: new Set(),
        onToggleCollapsed: vi.fn(),
        pinned: { label: "Pinned", content: null },
        threads: {
          label: "Threads",
          actions: (
            <SidebarHeaderControls label="Threads" showNewThread={false}>
              <ThreadListVisibilityMenuItems />
            </SidebarHeaderControls>
          ),
        },
      }}
    />
  );
}

function renderCollapsedSection(
  sectionId: string,
  name: string,
  thread: SidebarThread,
  draftThreadIds: readonly string[] = [],
) {
  renderTree(
    <ChronologicalSectionThreadSections
      threadListState={{ status: "ready", threads: [thread] }}
      compareThreads={() => 0}
      sections={[{ id: sectionId, name }]}
      collapsedThreadIds={new Set()}
      collapsedEnvironmentIds={new Set()}
      onToggleThreadCollapsed={vi.fn()}
      onToggleEnvironmentCollapsed={vi.fn()}
      topLevelSectionOrder={[buildSidebarEntitySectionId("section", sectionId)]}
      fullSectionOrder={[buildSidebarEntitySectionId("section", sectionId)]}
      onTopLevelSectionOrderChange={vi.fn()}
      pinnedReorderPending={false}
      pinnedThreads={[]}
      onReorderPinnedThread={vi.fn()}
      builtInSections={{
        collapsedSectionIds: new Set(),
        onToggleCollapsed: vi.fn(),
        pinned: { label: "Pinned", content: null },
        threads: { label: "Threads" },
      }}
    />,
    { threads: [thread], draftThreadIds },
  );
  fireEvent.click(
    screen.getByRole("button", { name: `Collapse ${name} section` }),
  );
}

const ENVIRONMENT_THREADS = [
  makeThread({
    id: "thr_worktree_a",
    environment: makeSidebarEnvironment({
      id: "env_test",
      name: "Feature workspace",
      branchName: "feat/menu-close",
      providerId: "git-worktree",
      isWorktree: true,
    }),
    queuedWork: "none",
  }),
  makeThread({
    id: "thr_worktree_b",
    environment: makeSidebarEnvironment({
      id: "env_test",
      name: "Feature workspace",
      branchName: "feat/menu-close",
      providerId: "git-worktree",
      isWorktree: true,
    }),
    queuedWork: "none",
  }),
];

describe("ProjectRow interactions", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("previews the dragged thread as a child of a valid nest target", () => {
    const container = renderPinnedParentWithChild({
      isCollapsed: false,
      sectionDnd: makeSectionDnd({
        nestTarget: { threadId: "thr_parent", state: "valid" },
        nestPreviewBeforeKey: "thread:thr_child",
      }),
    });

    const rows = [
      ...container.querySelectorAll(
        "[data-sidebar-thread-id], [data-sidebar-nest-drop-preview]",
      ),
    ];
    expect(
      rows.map(
        (row) => row.getAttribute("data-sidebar-thread-id") ?? row.textContent,
      ),
    ).toEqual(["thr_parent", "Dragged", "thr_child"]);
  });

  it("previews the dragged thread after the last child when it sorts last", () => {
    const container = renderPinnedParentWithChild({
      isCollapsed: false,
      sectionDnd: makeSectionDnd({
        nestTarget: { threadId: "thr_parent", state: "valid" },
        nestPreviewBeforeKey: null,
      }),
    });

    const rows = [
      ...container.querySelectorAll(
        "[data-sidebar-thread-id], [data-sidebar-nest-drop-preview]",
      ),
    ];
    expect(
      rows.map(
        (row) => row.getAttribute("data-sidebar-thread-id") ?? row.textContent,
      ),
    ).toEqual(["thr_parent", "thr_child", "Dragged"]);
  });

  it("leaves a blocked nest target without a child preview", () => {
    const container = renderPinnedParentWithChild({
      isCollapsed: false,
      sectionDnd: makeSectionDnd({
        nestTarget: { threadId: "thr_parent", state: "blocked" },
        nestPreviewBeforeKey: null,
      }),
    });

    expect(
      container.querySelector("[data-sidebar-nest-drop-preview]"),
    ).toBeNull();
  });

  it("anchors a pinned insert line below the subtree, not between parent and child", () => {
    const container = renderPinnedParentWithChild({
      isCollapsed: false,
      sectionDnd: makeSectionDnd({
        reorderTarget: { threadId: "thr_parent", placement: "after" },
      }),
    });

    expect(screen.getByText("Child")).not.toBeNull();
    expect(
      container.querySelector("[data-sidebar-reorder-placement]"),
    ).toBeNull();
    const group = container.querySelector<HTMLElement>(
      "[data-sidebar-sticky-group]",
    );
    expect(group?.className).toContain("after:-bottom-px");
    expect(group?.contains(screen.getByText("Child"))).toBe(true);
  });

  it("anchors a pinned insert line on the row when the subtree is collapsed", () => {
    const container = renderPinnedParentWithChild({
      isCollapsed: true,
      sectionDnd: makeSectionDnd({
        reorderTarget: { threadId: "thr_parent", placement: "after" },
      }),
    });

    expect(screen.queryByText("Child")).toBeNull();
    expect(
      container
        .querySelector("[data-sidebar-reorder-placement]")
        ?.getAttribute("data-sidebar-reorder-placement"),
    ).toBe("after");
  });

  it("keeps project header controls touch-accessible when their menu opens and closes", async () => {
    renderProjectRow();
    const trigger = screen.getByRole("button", {
      name: /^Test project actions(?:;|$)/,
    });
    const actions = trigger.closest(".bb-sidebar-hover-actions");
    expect(actions?.getAttribute("data-sidebar-hover-actions-mobile")).toBe(
      "always",
    );
    expect(actions?.getAttribute("data-sidebar-hover-actions-open")).toBeNull();

    fireEvent.pointerDown(trigger, { button: 0 });
    const menu = await screen.findByRole("menu");
    expect(actions?.getAttribute("data-sidebar-hover-actions-mobile")).toBe(
      "always",
    );
    expect(actions?.getAttribute("data-sidebar-hover-actions-open")).toBe(
      "true",
    );

    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(actions?.getAttribute("data-sidebar-hover-actions-mobile")).toBe(
      "always",
    );
    expect(actions?.getAttribute("data-sidebar-hover-actions-open")).toBeNull();
  });

  it("renames a project from its menu without collapsing its threads", async () => {
    const update = vi.fn(sdkResult({ ok: true }));
    const { onToggleProjectCollapsed, sdkCalls } = renderProjectRow(
      vi.fn(),
      { status: "ready", threads: [] },
      false,
      new Set(),
      false,
      { sdk: { projects: { update } } },
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Test project actions" }),
      { button: 0 },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByRole("textbox", { name: "Project name" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: "  Renamed project  " } });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(input);
    expect(update).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(sdkCalls).toContainEqual({
        method: "projects.update",
        args: [{ projectId: "proj_test", name: "Renamed project" }],
      }),
    );
    expect(onToggleProjectCollapsed).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("links project settings and confirms removal through the SDK", async () => {
    const remove = vi.fn(sdkResult({ ok: true }));
    const { sdkCalls } = renderProjectRow(
      vi.fn(),
      { status: "ready", threads: [] },
      false,
      new Set(),
      false,
      { sdk: { projects: { delete: remove } } },
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Test project actions" }),
      { button: 0 },
    );
    const settings = await screen.findByRole("menuitem", {
      name: "Project settings",
    });
    expect(settings.getAttribute("href")).toBe("/settings/projects/proj_test");
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove project" }),
    );
    await waitFor(() =>
      expect(sdkCalls).toContainEqual({
        method: "projects.delete",
        args: [{ projectId: "proj_test" }],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("places the project disclosure after its label and keeps root threads flush", () => {
    const result = renderProjectRow(vi.fn(), {
      status: "ready",
      threads: [makeThread()],
    });

    const disclosure = screen.getByRole("button", {
      name: "Collapse Test project section",
    });
    const label = screen.getByTitle("Test project");
    const threadLink = result.container.querySelector(
      '[data-sidebar-thread-id="thr_test"]',
    );
    const projectGroup = result.container.querySelector(
      "[data-sidebar-sticky-project-item]",
    );

    expect(
      label.compareDocumentPosition(disclosure) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      threadLink?.closest<HTMLElement>(".bb-sidebar-hover-actions-row")?.style
        .paddingLeft,
    ).toBe("8px");
    expect(projectGroup?.getAttribute("data-sidebar-project-id")).toBe(
      "proj_test",
    );
    expect(projectGroup?.hasAttribute("data-sidebar-section-id")).toBe(false);
  });

  it("indents a nested environment group one level below its parent", () => {
    const environment = makeSidebarEnvironment({
      id: "env_nested",
      name: "Nested workspace",
      providerId: "git-worktree",
      isWorktree: true,
    });
    const { container } = renderProjectRow(vi.fn(), {
      status: "ready",
      threads: [
        makeThread({ id: "thr_parent", title: "Parent" }),
        makeThread({
          id: "thr_child_a",
          parentThreadId: "thr_parent",
          environment,
        }),
        makeThread({
          id: "thr_child_b",
          parentThreadId: "thr_parent",
          environment,
        }),
      ],
    });

    const group = screen
      .getByRole("button", { name: "Collapse Nested workspace threads" })
      .closest("[data-sidebar-sticky-group]");
    const header = group?.querySelector<HTMLElement>(
      ".bb-sidebar-hover-actions-row",
    );
    const child = group?.querySelector<HTMLElement>(
      '[data-sidebar-thread-id="thr_child_a"]',
    );
    const guide = group?.querySelector<HTMLElement>(
      ":scope > div.relative > span.bg-border-hairline",
    );

    expect(
      container.querySelector('[data-sidebar-thread-id="thr_parent"]'),
    ).not.toBeNull();
    expect(header?.style.paddingLeft).toBe("22px");
    expect(guide?.style.left).toBe("30px");
    expect(
      child?.closest<HTMLElement>(".bb-sidebar-hover-actions-row")?.style
        .paddingLeft,
    ).toBe("36px");
  });

  it("shows generic runtime activity before a named workflow rollup", () => {
    renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({
            id: "thr_worktree_workflow",
            status: "active",
            environment: makeSidebarEnvironment({
              id: "env_test",
              name: "Feature workspace",
              branchName: "feat/menu-close",
              providerId: "git-worktree",
              isWorktree: true,
            }),
            queuedWork: "none",
            activity: {
              workflows: 1,
              backgroundAgents: 0,
              backgroundCommands: 0,
              planMode: 0,
              goals: 0,
            },
            runtimeStatus: "active",
          }),
          makeThread({
            id: "thr_worktree_sibling",
            environment: makeSidebarEnvironment({
              id: "env_test",
              name: "Feature workspace",
              branchName: "feat/menu-close",
              providerId: "git-worktree",
              isWorktree: true,
            }),
            queuedWork: "none",
          }),
        ],
      },
      false,
      new Set(["env_test"]),
    );

    expect(
      screen.getByRole("button", {
        name: "Expand Feature workspace threads",
      }),
    ).not.toBeNull();
    expect(renderedIndicators()).toEqual(["working"]);
  });

  it.each([
    { isCollapsed: true, expectedHoverReveal: false },
    { isCollapsed: false, expectedHoverReveal: true },
  ])(
    "sets environment disclosure hover reveal to $expectedHoverReveal when collapsed is $isCollapsed",
    ({ expectedHoverReveal, isCollapsed }) => {
      const environment = makeSidebarEnvironment({
        id: "env_disclosure",
        name: "Disclosure workspace",
        providerId: "git-worktree",
        isWorktree: true,
      });
      renderProjectRow(
        vi.fn(),
        {
          status: "ready",
          threads: [
            makeThread({ id: "thr_disclosure_one", environment }),
            makeThread({ id: "thr_disclosure_two", environment }),
          ],
        },
        false,
        new Set(isCollapsed ? ["env_disclosure"] : []),
      );

      const toggle = screen.getByRole("button", {
        name: `${isCollapsed ? "Expand" : "Collapse"} Disclosure workspace threads`,
      });
      expect(toggle.classList.contains("bb-sidebar-hover-actions")).toBe(
        expectedHoverReveal,
      );
    },
  );

  it("shows a working draft before named work for a collapsed environment", () => {
    renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({
            id: "thr_worktree_plan",
            environment: makeSidebarEnvironment({
              id: "env_draft",
              name: "Draft workspace",
              providerId: "git-worktree",
              isWorktree: true,
            }),
            queuedWork: "none",
            activity: {
              workflows: 0,
              backgroundAgents: 0,
              backgroundCommands: 0,
              planMode: 1,
              goals: 0,
            },
          }),
          makeThread({
            id: "thr_worktree_draft",
            environment: makeSidebarEnvironment({
              id: "env_draft",
              name: "Draft workspace",
              providerId: "git-worktree",
              isWorktree: true,
            }),
            queuedWork: "none",
          }),
        ],
      },
      false,
      new Set(["env_draft"]),
      false,
      { draftThreadIds: ["thr_worktree_draft"] },
    );

    expect(renderedIndicators()).toEqual(["working"]);
  });

  it("uses shared runtime precedence when a top-level section is collapsed", () => {
    const sectionId = "sec_active";
    renderCollapsedSection(
      sectionId,
      "Active work",
      makeThread({
        id: "thr_section_active",
        sectionId,
        status: "active",
        runtimeStatus: "active",
        activity: {
          workflows: 0,
          backgroundAgents: 0,
          backgroundCommands: 0,
          planMode: 1,
          goals: 1,
        },
      }),
    );

    expect(
      screen
        .getByTitle("Active work")
        .closest("[data-sidebar-sticky-group]")
        ?.getAttribute("data-sidebar-section-id"),
    ).toBe(sectionId);

    expect(screen.queryByText("Test thread")).toBeNull();
    expect(renderedIndicators()).toEqual(["working"]);
    expectCollapsedActivityAtSidebarEdge("working");
  });

  it("shows a working draft before Plan for a collapsed section", () => {
    const sectionId = "sec_draft";
    renderCollapsedSection(
      sectionId,
      "Draft work",
      makeThread({
        id: "thr_section_draft",
        sectionId,
        activity: {
          workflows: 0,
          backgroundAgents: 0,
          backgroundCommands: 0,
          planMode: 1,
          goals: 1,
        },
      }),
      ["thr_section_draft"],
    );

    expect(renderedIndicators()).toEqual(["working"]);
  });

  it("hides loose Threads in More and restores them", async () => {
    const store = createStore();
    const savedOrder = ["section:sec_building", "pinned", "threads"];
    store.set(sidebarOrganizationModeAtom, "chronological");
    store.set(sidebarManualSectionOrderAtom, savedOrder);
    const threads = [
      makeThread({
        id: "thr_loose",
        title: "Loose thread",
        titleFallback: "Loose thread",
        sectionId: null,
      }),
    ];
    renderTree(
      <CustomSectionsVisibilityProbe
        threads={threads}
        onProjectSelect={vi.fn()}
      />,
      { threads, store },
    );

    expect(screen.getByText("Loose thread")).not.toBeNull();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Threads actions" }),
      { button: 0 },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Hide from list" }),
    );

    expect(screen.queryByText("Loose thread")).toBeNull();
    expect(store.get(sidebarHiddenGroupsAtom)).toEqual(["threads"]);
    expect(store.get(sidebarManualSectionOrderAtom)).toEqual(savedOrder);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "More sections" }),
      ),
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "More sections" }), {
      key: "Enter",
    });
    const threadsGroup = await screen.findByRole("menuitem", {
      name: "Threads",
    });
    fireEvent.keyDown(threadsGroup, { key: "ArrowRight" });
    expect(await screen.findByText("Loose thread")).not.toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Add to list" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "More sections" }),
      ).toBeNull(),
    );
    expect(screen.getByText("Loose thread")).not.toBeNull();
    expect(store.get(sidebarHiddenGroupsAtom)).toEqual([]);
    expect(store.get(sidebarManualSectionOrderAtom)).toEqual(savedOrder);
  });

  it("hides a section with inherited descendants and restores its saved position", async () => {
    const store = createStore();
    const savedOrder = [
      "section:sec_review",
      "section:sec_building",
      "pinned",
      "threads",
    ];
    store.set(sidebarOrganizationModeAtom, "chronological");
    store.set(sidebarManualSectionOrderAtom, savedOrder);
    const onProjectSelect = vi.fn();
    const threads = [
      makeThread({
        id: "thr_review_parent",
        title: "Review parent",
        titleFallback: "Review parent",
        sectionId: "sec_review",
      }),
      makeThread({
        id: "thr_inherited_child",
        title: "Inherited child",
        titleFallback: "Inherited child",
        parentThreadId: "thr_review_parent",
        sectionId: null,
      }),
    ];
    const { container } = renderTree(
      <CustomSectionsVisibilityProbe
        threads={threads}
        onProjectSelect={onProjectSelect}
      />,
      { threads, store },
    );

    expect(screen.getByText("Review parent")).not.toBeNull();
    expect(screen.getByText("Inherited child")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "More sections" })).toBeNull();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Review section actions" }),
      { button: 0 },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Hide from list" }),
    );

    expect(screen.queryByText("Review parent")).toBeNull();
    expect(screen.queryByText("Inherited child")).toBeNull();
    expect(store.get(sidebarHiddenGroupsAtom)).toEqual(["section:sec_review"]);
    expect(store.get(sidebarManualSectionOrderAtom)).toEqual(savedOrder);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "More sections" }),
      ),
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "More sections" }), {
      key: "Enter",
    });
    const section = await screen.findByRole("menuitem", { name: "Review" });
    expect(screen.queryByText("Review parent")).toBeNull();
    fireEvent.keyDown(section, { key: "ArrowRight" });
    expect(await screen.findByText("Review parent")).not.toBeNull();
    fireEvent.click(
      await screen.findByRole("link", { name: "Open Inherited child" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: "Hidden sections" }),
      ).toBeNull(),
    );
    expect(onProjectSelect).toHaveBeenCalledOnce();
    expect(store.get(sidebarHiddenGroupsAtom)).toEqual(["section:sec_review"]);

    fireEvent.keyDown(screen.getByRole("button", { name: "More sections" }), {
      key: "Enter",
    });
    const reopenedSection = await screen.findByRole("menuitem", {
      name: "Review",
    });
    expect(screen.queryByText("Review parent")).toBeNull();
    fireEvent.keyDown(reopenedSection, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("button", { name: "Add to list" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "More sections" }),
      ).toBeNull(),
    );
    expect(screen.getByText("Inherited child")).not.toBeNull();
    expect(store.get(sidebarHiddenGroupsAtom)).toEqual([]);
    expect(store.get(sidebarManualSectionOrderAtom)).toEqual(savedOrder);
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>(
          "[data-sidebar-visibility-group]",
        ),
        (element) => element.dataset.sidebarVisibilityGroup,
      ),
    ).toEqual(["section:sec_review", "section:sec_building", "threads"]);
  });

  it("surfaces named activity when the project is collapsed", () => {
    renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({
            activity: {
              workflows: 0,
              backgroundAgents: 0,
              backgroundCommands: 0,
              planMode: 0,
              goals: 1,
            },
          }),
        ],
      },
      false,
      new Set(),
      true,
    );

    expect(screen.queryByText("Test thread")).toBeNull();
    expect(renderedIndicators()).toEqual(["working"]);
    expectCollapsedActivityAtSidebarEdge("working");
  });

  it("shows unread success before an idle draft for a collapsed project", () => {
    renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({
            id: "thr_project_draft",
            lastReadAt: 100,
            latestAttentionAt: 200,
          }),
        ],
      },
      false,
      new Set(),
      true,
      { draftThreadIds: ["thr_project_draft"] },
    );

    expect(renderedIndicators()).toEqual(["done-unread"]);
  });

  it("excludes hidden side-chat activity from a collapsed project", () => {
    renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({
            id: "thr_side_chat",
            isHidden: true,
            activity: {
              workflows: 0,
              backgroundAgents: 0,
              backgroundCommands: 0,
              planMode: 1,
              goals: 0,
            },
          }),
        ],
      },
      false,
      new Set(),
      true,
      { draftThreadIds: ["thr_side_chat"] },
    );

    expect(renderedIndicators()).toEqual([]);
  });

  it.each([false, true])(
    "keeps environment actions touch-accessible when collapsed=%s",
    async (isCollapsed) => {
      const update = vi.fn(sdkResult({ ok: true }));
      const { navigateCalls, sdkCalls } = renderProjectRow(
        vi.fn(),
        { status: "ready", threads: ENVIRONMENT_THREADS },
        false,
        isCollapsed ? new Set(["env_test"]) : new Set(),
        false,
        { sdk: { environments: { update } } },
      );

      const createButton = screen.getByRole("button", {
        name: "New thread in environment",
      });
      const actions = createButton.closest(".bb-sidebar-hover-actions");
      expect(actions?.getAttribute("data-sidebar-hover-actions-mobile")).toBe(
        "always",
      );
      expect(
        actions?.contains(
          screen.getByRole("button", { name: "Environment actions" }),
        ),
      ).toBe(true);
      fireEvent.click(createButton);
      expect(navigateCalls).toEqual([
        {
          method: "toCompose",
          options: {
            projectId: "proj_test",
            environmentId: "env_test",
            placement: { sectionId: null, pinned: false },
            focusPrompt: true,
          },
        },
      ]);

      fireEvent.pointerDown(
        screen.getByRole("button", { name: "Environment actions" }),
        { button: 0 },
      );
      const rename = await screen.findByRole("menuitem", { name: "Rename" });
      expect(
        screen.getAllByRole("menuitem").map((item) => item.textContent),
      ).toEqual(["Rename", "Archive"]);
      fireEvent.click(rename);

      const input = await screen.findByRole("textbox", {
        name: "Environment name",
      });
      expect(input.getAttribute("placeholder")).toBe("feat/menu-close");
      expect(input).toHaveProperty("value", "Feature workspace");
      await waitFor(() => expect(document.activeElement).toBe(input));
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => {
        expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
      });
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(sdkCalls).toContainEqual({
          method: "environments.update",
          args: [{ environmentId: "env_test", name: null }],
        }),
      );
    },
  );

  it("leaves threads sharing the project checkout ungrouped", () => {
    renderProjectRow(vi.fn(), {
      status: "ready",
      threads: [
        makeThread({
          id: "thr_checkout_a",
          environment: makeSidebarEnvironment({
            id: "env_checkout",
            branchName: "main",
            providerId: null,
          }),
          queuedWork: "none",
        }),
        makeThread({
          id: "thr_checkout_b",
          environment: makeSidebarEnvironment({
            id: "env_checkout",
            branchName: "main",
            providerId: null,
          }),
          queuedWork: "none",
        }),
      ],
    });

    expect(
      screen.queryByRole("button", { name: "Collapse main threads" }),
    ).toBeNull();
  });

  it("archives and renames an environment group from any provider", async () => {
    const archiveThreads = vi.fn(
      sdkResult({ ok: true, archivedThreadIds: [] }),
    );
    const update = vi.fn(sdkResult({ ok: true }));
    const { sdkCalls, experimental_environmentArchiveCalls } = renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({
            id: "thr_plain_a",
            environment: makeSidebarEnvironment({
              id: "env_plain",
              branchName: "main",
              providerId: "personal-workspace",
              isWorktree: true,
            }),
            queuedWork: "none",
          }),
          makeThread({
            id: "thr_plain_b",
            environment: makeSidebarEnvironment({
              id: "env_plain",
              branchName: "main",
              providerId: "personal-workspace",
              isWorktree: true,
            }),
            queuedWork: "none",
          }),
        ],
      },
      false,
      new Set(),
      false,
      { sdk: { environments: { archiveThreads, update } } },
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Environment actions" }),
      { button: 0 },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    expect(experimental_environmentArchiveCalls).toEqual(["env_plain"]);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Environment actions" }),
      { button: 0 },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByRole("textbox", {
      name: "Environment name",
    });
    fireEvent.change(input, { target: { value: "  Release workspace  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(sdkCalls).toContainEqual({
        method: "environments.update",
        args: [{ environmentId: "env_plain", name: "Release workspace" }],
      }),
    );
  });
});

describe("environment creation placement", () => {
  afterEach(cleanup);
  it.each([
    ["pinned", "sec_managers", true],
    ["pinned-mixed", null, true],
    ["section:sec_visible", "sec_visible", false],
    ["project:proj_test", null, false],
    ["machine:host_test", null, false],
    ["threads", null, false],
  ] as const)(
    "creates in the containing %s group",
    (groupId, sectionId, pinned) => {
      const threads = ENVIRONMENT_THREADS.map((thread) => ({
        ...thread,
        sectionId:
          groupId === "pinned-mixed" && thread.id === ENVIRONMENT_THREADS[0].id
            ? "sec_other"
            : "sec_managers",
        pinnedAt: 1,
      }));
      const group = buildPinnedSidebarState({
        threads,
        groupEnvironmentThreads: true,
      }).rootItems[0];
      if (group.kind !== "environment")
        throw new Error("Expected environment group");
      const { navigateCalls } = renderTree(
        <ThreadCreationPlacementScope
          group={groupId === "pinned-mixed" ? "pinned" : groupId}
        >
          <PinnedEnvironmentThreadGroupRow
            group={group.group}
            collapsedThreadIds={new Set()}
            collapsedEnvironmentIds={new Set()}
            onToggleThreadCollapsed={vi.fn()}
            onToggleEnvironmentCollapsed={vi.fn()}
          />
        </ThreadCreationPlacementScope>,
        { threads },
      );
      fireEvent.click(
        screen.getByRole("button", { name: "New thread in environment" }),
      );
      expect(navigateCalls).toEqual([
        {
          method: "toCompose",
          options: {
            projectId: "proj_test",
            environmentId: "env_test",
            focusPrompt: true,
            placement: { sectionId, pinned },
          },
        },
      ]);
    },
  );
});

describe("nested sticky parents with row state", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("offsets a nested sticky parent by the height of its ancestors' row state", () => {
    const growingRowHeight = 110;
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const rect = realRect.call(this);
        if (
          !this.hasAttribute("data-sidebar-rename-row") ||
          this.querySelector("[data-sidebar-thread-row-state]") === null
        ) {
          return rect;
        }
        return new DOMRect(rect.x, rect.y, rect.width, growingRowHeight);
      },
    );
    const grandparent = makeThread({
      id: "thr_grandparent",
      title: "Grandparent",
      titleFallback: "Grandparent",
      pinnedAt: 1,
      experimental_rowState: {
        statuses: { task: { value: "Running" } },
        progress: { value: 0.5, label: "Merging" },
      },
    });
    const parent = makeThread({
      id: "thr_parent",
      title: "Parent",
      titleFallback: "Parent",
      parentThreadId: "thr_grandparent",
    });
    const child = makeThread({
      id: "thr_child",
      title: "Child",
      titleFallback: "Child",
      parentThreadId: "thr_parent",
    });
    const node = buildPinnedSidebarState({
      threads: [grandparent, parent, child],
    }).rootNodes[0];
    const { container } = renderTree(
      <ThreadTreeNodeRow
        projectId="proj_test"
        node={node}
        depthOffset={0}
        isEnvGrouped={false}
        collapsedThreadIds={new Set()}
        collapsedEnvironmentIds={new Set()}
        onToggleThreadCollapsed={vi.fn()}
        onToggleEnvironmentCollapsed={vi.fn()}
        sectionDnd={makeSectionDnd()}
        sortableRef={() => undefined}
      />,
      { threads: [grandparent, parent, child] },
    );

    const tiers = container.querySelectorAll<HTMLElement>(
      '[data-sidebar-sticky-tier="parent"]',
    );
    expect(tiers).toHaveLength(2);
    expect(
      tiers[0]?.style.getPropertyValue("--bb-sidebar-sticky-parent-offset"),
    ).toBe("0px");
    expect(
      tiers[1]?.style.getPropertyValue("--bb-sidebar-sticky-parent-offset"),
    ).toBe(
      `calc(${growingRowHeight}px - 1 * var(--bb-sidebar-sticky-row-height))`,
    );
  });
});

const execFileAsync = promisify(execFile);
const chromiumPath = inject("threadListChromiumPath");
const pluginCss = inject("threadListPluginCss");
const CHROMIUM_LAUNCH_TIMEOUT_MS = 60_000;
const NESTED_PIN_TEST_TIMEOUT_MS = 120_000;

interface NestedPinMeasurement {
  tierCount: number;
  rowHeight: number | null;
  tier0: { top: number; bottom: number };
  tier1: { top: number; bottom: number } | null;
  tier1Visible: boolean;
}

interface NestedPinSnapshot {
  html: string;
  width: number;
}

const NESTED_PIN_MEASURE_SCRIPT = `
const results = [];
for (const section of document.querySelectorAll("section.snapshot")) {
  section.style.display = "block";
  const scroller = section.querySelector(".scroller");
  scroller.scrollTop = 400;
  const origin = scroller.getBoundingClientRect().top;
  const tiers = Array.from(section.querySelectorAll('[data-sidebar-sticky-tier="parent"]'));
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top - origin, bottom: rect.bottom - origin };
  };
  const rowState = tiers[0].querySelector("[data-sidebar-thread-row-state]");
  const growingRow = rowState ? rowState.closest("[data-sidebar-rename-row]") : null;
  let tier1Visible = false;
  if (tiers[1]) {
    const rect = tiers[1].getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + 40, rect.top + rect.height / 2);
    tier1Visible = hit !== null && tiers[1].contains(hit);
  }
  results.push({
    tierCount: tiers.length,
    rowHeight: growingRow ? growingRow.getBoundingClientRect().height : null,
    tier0: box(tiers[0]),
    tier1: tiers[1] ? box(tiers[1]) : null,
    tier1Visible,
  });
  section.style.display = "none";
}
document.getElementById("layout").textContent = JSON.stringify(results);
`;

async function measureNestedPins(
  snapshots: readonly NestedPinSnapshot[],
): Promise<NestedPinMeasurement[]> {
  const dir = await mkdtemp(join(tmpdir(), "bb-nested-dynamic-"));
  try {
    const page = join(dir, "nested.html");
    const themeCss = await readFile(
      join(process.cwd(), "../../apps/app/src/components/ui/theme.css"),
      "utf8",
    );
    const sections = snapshots
      .map(
        ({ html, width }) => `<section class="snapshot" style="display:none">
<div data-bb-plugin-root style="width:${width}px">
<div class="scroller" style="height:240px;overflow:auto">
<div data-sidebar-sticky-stack style="--bb-sidebar-sticky-parent-base-top:0px">${html}</div>
</div></div></section>`,
      )
      .join("\n");
    await writeFile(
      page,
      `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>
@layer theme, base, components, utilities;
:root{--bb-sidebar-row-height:1.75rem;--bb-sidebar-row-height-coarse:2.5rem;--sidebar:#fafafa;--sidebar-accent:#e4e4e7;--timeline-accent:#2563eb}
*,::before,::after{box-sizing:border-box}
body{margin:0}
${pluginCss ?? ""}
${themeCss}
</style></head><body>
${sections}
<pre id="layout"></pre>
<script>${NESTED_PIN_MEASURE_SCRIPT}</script>
</body></html>`,
    );
    const windowWidth = Math.max(...snapshots.map(({ width }) => width));
    const { stdout } = await execFileAsync(
      chromiumPath ?? "",
      [
        "--headless",
        `--user-data-dir=${join(dir, "profile")}`,
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-background-networking",
        "--no-first-run",
        "--hide-scrollbars",
        `--window-size=${windowWidth},400`,
        "--virtual-time-budget=2000",
        "--dump-dom",
        `file://${page}`,
      ],
      { timeout: CHROMIUM_LAUNCH_TIMEOUT_MS },
    );
    const match = /<pre id="layout">([^<]*)<\/pre>/.exec(stdout);
    if (match?.[1] === undefined) throw new Error(stdout.slice(0, 500));
    return JSON.parse(
      match[1].replaceAll("&quot;", '"'),
    ) as NestedPinMeasurement[];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

class ResizeObserverStub {
  static live = new Set<ResizeObserverStub>();
  constructor(private readonly callback: () => void) {}
  observe() {
    ResizeObserverStub.live.add(this);
  }
  unobserve() {}
  disconnect() {
    ResizeObserverStub.live.delete(this);
  }
  static fireAll() {
    act(() => {
      for (const observer of [...ResizeObserverStub.live]) {
        observer.callback();
      }
    });
  }
}

describe.skipIf(
  pluginCss === null || (chromiumPath === null && !process.env.CI),
)(
  "nested sticky pins in real Chromium, driven through ThreadTreeNodeRow",
  () => {
    const VIEWPORTS = [
      { name: "desktop", width: 280, isCompact: false },
      { name: "compact 390px", width: 390, isCompact: true },
    ];
    const ONE_STATUS = {
      task: { value: "WT-GUARD preserve recoverable work" },
    };
    const TWO_STATUSES = {
      ...ONE_STATUS,
      build: { value: "#138 f49bb0e9 OPEN: chain138.out:unit EXIT=0" },
    };
    let layoutRowHeight = 0;

    afterEach(() => {
      cleanup();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      ResizeObserverStub.live.clear();
      layoutRowHeight = 0;
    });

    function installLayoutDoubles() {
      vi.stubGlobal("ResizeObserver", ResizeObserverStub);
      const realRect = HTMLElement.prototype.getBoundingClientRect;
      vi.spyOn(
        HTMLElement.prototype,
        "getBoundingClientRect",
      ).mockImplementation(function (this: HTMLElement) {
        const rect = realRect.call(this);
        if (
          !this.hasAttribute("data-sidebar-rename-row") ||
          this.querySelector("[data-sidebar-thread-row-state]") === null
        ) {
          return rect;
        }
        return new DOMRect(rect.x, rect.y, rect.width, layoutRowHeight);
      });
    }

    function buildNode(statuses: Record<string, { value: string }> | null): {
      node: ReturnType<typeof buildPinnedSidebarState>["rootNodes"][number];
      threads: SidebarThread[];
    } {
      const grandparent = makeThread({
        id: "thr_grandparent",
        title: "Grandparent",
        titleFallback: "Grandparent",
        pinnedAt: 1,
        experimental_rowState:
          statuses === null
            ? undefined
            : {
                statuses,
                progress: { value: 0.6, label: "#138 merge pipeline" },
              },
      });
      const parent = makeThread({
        id: "thr_parent",
        title: "Parent",
        titleFallback: "Parent",
        parentThreadId: "thr_grandparent",
      });
      const children = Array.from({ length: 20 }, (_, index) =>
        makeThread({
          id: `thr_child_${index}`,
          title: `Child ${index}`,
          titleFallback: `Child ${index}`,
          parentThreadId: "thr_parent",
        }),
      );
      const threads = [grandparent, parent, ...children];
      return {
        node: buildPinnedSidebarState({ threads }).rootNodes[0],
        threads,
      };
    }

    function tree(
      node: ReturnType<typeof buildNode>["node"],
      viewport: (typeof VIEWPORTS)[number],
      collapsed: boolean,
    ) {
      return (
        <CompactViewportOverrideProvider isCompactViewport={viewport.isCompact}>
          <ThreadTreeNodeRow
            projectId="proj_test"
            node={node}
            depthOffset={0}
            isEnvGrouped={false}
            collapsedThreadIds={
              collapsed ? new Set(["thr_grandparent"]) : new Set()
            }
            collapsedEnvironmentIds={new Set()}
            onToggleThreadCollapsed={vi.fn()}
            onToggleEnvironmentCollapsed={vi.fn()}
            sectionDnd={makeSectionDnd()}
            sortableRef={() => undefined}
          />
        </CompactViewportOverrideProvider>
      );
    }

    function expectPinnedBelow(measured: NestedPinMeasurement | undefined) {
      expect(measured?.tier1).toBeTruthy();
      const tier1 = measured?.tier1 ?? {
        top: Number.NaN,
        bottom: Number.NaN,
      };
      const tier0Bottom = measured?.tier0.bottom ?? Number.NaN;
      expect(tier1.top).toBeGreaterThanOrEqual(tier0Bottom - 0.5);
      expect(tier1.top).toBeLessThanOrEqual(tier0Bottom + 4);
      expect(measured?.tier1Visible).toBe(true);
    }

    it.each(VIEWPORTS)(
      "keeps level 1 pinned at the bottom of level 0 through first render, growth, removal and collapse on $name",
      { timeout: NESTED_PIN_TEST_TIMEOUT_MS },
      async (viewport) => {
        installLayoutDoubles();
        const store = createStore();
        const one = buildNode(ONE_STATUS);
        const two = buildNode(TWO_STATUSES);
        const none = buildNode(null);
        const snapshot = (container: HTMLElement): NestedPinSnapshot => ({
          html: container.innerHTML,
          width: viewport.width,
        });

        const oneCalibration = renderTree(tree(one.node, viewport, false), {
          threads: one.threads,
          store,
        });
        const oneCalibrationSnapshot = snapshot(oneCalibration.container);
        cleanup();
        const twoCalibration = renderTree(tree(two.node, viewport, false), {
          threads: two.threads,
          store,
        });
        const twoCalibrationSnapshot = snapshot(twoCalibration.container);
        cleanup();
        const [oneCalibrated, twoCalibrated] = await measureNestedPins([
          oneCalibrationSnapshot,
          twoCalibrationSnapshot,
        ]);
        const oneHeight = oneCalibrated?.rowHeight ?? 0;
        const twoHeight = twoCalibrated?.rowHeight ?? 0;
        expect(oneHeight).toBeGreaterThan(40);
        expect(twoHeight).toBeGreaterThan(oneHeight);

        layoutRowHeight = oneHeight;
        const rendered = renderTree(tree(one.node, viewport, false), {
          threads: one.threads,
          store,
        });
        const rerenderTree = (
          node: ReturnType<typeof buildNode>["node"],
          collapsed: boolean,
        ) =>
          rendered.lifecycle.rerender(
            <Harness store={store}>{tree(node, viewport, collapsed)}</Harness>,
          );
        const firstSnapshot = snapshot(rendered.container);

        rerenderTree(two.node, false);
        layoutRowHeight = twoHeight;
        ResizeObserverStub.fireAll();
        const growthSnapshot = snapshot(rendered.container);

        rerenderTree(none.node, false);
        const removalSnapshot = snapshot(rendered.container);

        rerenderTree(one.node, false);
        layoutRowHeight = oneHeight;
        ResizeObserverStub.fireAll();
        const restoredSnapshot = snapshot(rendered.container);

        rerenderTree(one.node, true);
        const collapsedSnapshot = snapshot(rendered.container);

        rerenderTree(one.node, false);
        ResizeObserverStub.fireAll();
        const expandedSnapshot = snapshot(rendered.container);

        const [
          first,
          afterGrowth,
          afterRemoval,
          restored,
          collapsed,
          expanded,
        ] = await measureNestedPins([
          firstSnapshot,
          growthSnapshot,
          removalSnapshot,
          restoredSnapshot,
          collapsedSnapshot,
          expandedSnapshot,
        ]);

        expect(first?.rowHeight).toBe(oneHeight);
        expectPinnedBelow(first);

        expect(afterGrowth?.rowHeight).toBe(twoHeight);
        expect(afterGrowth?.tier0.bottom ?? 0).toBeGreaterThan(
          first?.tier0.bottom ?? Number.POSITIVE_INFINITY,
        );
        expectPinnedBelow(afterGrowth);

        expect(
          (afterRemoval?.tier0.bottom ?? Number.NaN) -
            (afterRemoval?.tier0.top ?? Number.NaN),
        ).toBeLessThan(45);
        expectPinnedBelow(afterRemoval);

        expect(restored?.rowHeight).toBe(oneHeight);
        expectPinnedBelow(restored);

        expect(collapsed?.tierCount).toBe(1);

        expect(expanded?.rowHeight).toBe(oneHeight);
        expectPinnedBelow(expanded);
      },
    );
  },
);
