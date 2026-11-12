// @vitest-environment jsdom

import { SidebarRowMetadataExperiment } from "../list/SidebarRowMetadataExperiment.js";
import { ThreadListVisibilityGroupScope } from "../list/ThreadListVisibility.js";
import * as pluginSdk from "@get-bb/plugin-sdk/app";

import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { getDefaultStore } from "jotai";
import { DndContext, useDraggable } from "@dnd-kit/core";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import { useSidebarReorderDnd } from "@/components/ui/use-sidebar-reorder-dnd";
import { SidebarTouchSensor } from "../dnd/sidebarTouchSensor.js";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarRenameProvider } from "./SidebarInlineRename.js";
import {
  RENAME_PRESENTATION_CASES,
  type RenamePresentationOutcome,
} from "@/components/ui/inline-rename-presentation-cases";
import type {
  PluginSidebarProject,
  PluginSidebarSplitLayout,
  PluginSidebarThread,
  PluginSidebarThreadRowStatus,
  PluginProvidersState,
  PluginBrowserBbSdk,
  PluginThreadActionEntry,
} from "@get-bb/plugin-sdk/app";
import {
  installTestPluginRuntime,
  renderSlot,
  type PluginSdkTestFakes,
  type RenderedSlot,
  type TestThreadActionsResolver,
  type TestThreadBulkActionsResolver,
} from "@get-bb/plugin-sdk/testing/app";
import {
  NO_COLLAPSED_CHILD_ACTIVITY,
  getCollapsedChildActivity,
} from "../model/thread-activity.js";
import {
  threadListPullRequestRpcContract,
  type ThreadListPullRequest,
} from "./pull-request-query.js";
import { useAutomationWokeAt } from "../model/automation-woke.js";
import {
  makeSidebarEnvironment,
  makeSidebarThread,
  makePluginProject,
} from "../model/fixtures.js";
import {
  sidebarShowProviderIconsAtom,
  sidebarShowRowMetadataAtom,
  THREAD_ROW_METADATA_EXPERIMENT,
} from "../preferences/atoms.js";
import { SidebarProjectsContext } from "../model/use-sidebar-data.js";
import { StickyRowStateReportProvider } from "../ui/stickyOffset.js";
import type { ThreadRowOptions } from "./ThreadRow.js";
import {
  preferenceValueAtom,
  resetPreferencesSyncForTest,
} from "../preferences/preferences-sync.js";
import {
  CustomizeRowActionsContext,
  ThreadRowActionsCustomizingContext,
} from "../list/customizeRowActionsContext.js";

installTestPluginRuntime();
const { SidebarDraftPresenceSync } =
  await import("../list/sidebarDraftPresence.js");
const { ThreadRowNavigationProvider } =
  await import("./threadRowNavigation.js");
const { ThreadSelectionProvider } =
  await import("../selection/threadSelection.js");
const {
  resetSidebarTitleDoubleClickForTest,
  SidebarProvidersContext,
  ThreadRow,
} = await import("./ThreadRow.js");

const DEFAULT_OPTIONS: ThreadRowOptions = {
  kind: "default",
  depth: 1,
  isCompact: false,
};

function expectPersistentRowMetadata(element: HTMLElement) {
  expect(element.isConnected).toBe(true);
  for (
    let ancestor: HTMLElement | null = element;
    ancestor !== null;
    ancestor = ancestor.parentElement
  ) {
    const style = getComputedStyle(ancestor);
    expect(style.display).not.toBe("none");
    expect(style.visibility).not.toBe("hidden");
    expect(style.opacity).not.toBe("0");
    expect(ancestor.hidden).toBe(false);
    for (const utility of ancestor.classList) {
      expect(utility).not.toMatch(
        /^(?:(?:max-md|pointer-coarse|\[@media\(hover:none\)\]):)*(?:hidden|invisible|opacity-0|[wh]-0|size-0|scale-0)$/,
      );
    }
  }
}

function createThread(
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return makeSidebarThread(overrides);
}

function createPullRequest(
  state: ThreadListPullRequest["state"],
  number = 10843,
  title = `${state} pull request`,
): ThreadListPullRequest {
  return {
    number,
    title,
    url: `https://github.com/albrand/bb/pull/${number}`,
    state,
  };
}

function activity(
  overrides: Partial<PluginSidebarThread["activity"]>,
): PluginSidebarThread["activity"] {
  return {
    workflows: 0,
    backgroundAgents: 0,
    backgroundCommands: 0,
    planMode: 0,
    goals: 0,
    ...overrides,
  };
}

interface HarnessProps {
  thread: PluginSidebarThread;
  projects?: PluginSidebarProject[];
  providers?: PluginProvidersState["providers"];
  isCompactViewport?: boolean;
  crossProjectId?: string | null;
  visibilityGroup?: string;
  isActive?: boolean;
  options?: ThreadRowOptions;
  onRowEvent?: () => void;
  onCustomizeRowActions?: (threadId: string) => void;
  onFinishCustomizingRowActions?: (restoreFocus: boolean) => void;
  siblings?: PluginSidebarThread[];
  onStickyRowHeight?: (height: number) => void;
}

function ThreadRowHarness({
  thread,
  siblings = [],
  projects = [],
  providers = [],
  isCompactViewport,
  crossProjectId = null,
  visibilityGroup,
  isActive = false,
  options = DEFAULT_OPTIONS,
  onRowEvent,
  onCustomizeRowActions,
  onFinishCustomizingRowActions,
  onStickyRowHeight,
}: HarnessProps) {
  const threadRow = (
      <ThreadRow
        thread={thread}
        crossProjectId={crossProjectId}
        isActive={isActive}
        options={options}
      />
  );
  const row = visibilityGroup ? (
    <ThreadListVisibilityGroupScope id={visibilityGroup}>{threadRow}</ThreadListVisibilityGroupScope>
  ) : threadRow;
  const content = (
    <SidebarRowMetadataExperiment>
      <SidebarProjectsContext.Provider value={projects}>
        <SidebarProvidersContext.Provider value={providers}>
          <TooltipProvider>
            <SidebarDraftPresenceSync />
            <ThreadRowNavigationProvider>
              <ThreadSelectionProvider activeThreadId={null}>
                <SidebarRenameProvider>
                  <CustomizeRowActionsContext.Provider
                    value={onCustomizeRowActions ?? null}
                  >
                    <ThreadRowActionsCustomizingContext.Provider
                      value={
                        onFinishCustomizingRowActions
                          ? {
                              threadId: thread.id,
                              onDone: onFinishCustomizingRowActions,
                            }
                          : null
                      }
                    >
                      <div
                        onPointerDown={onRowEvent}
                        onKeyDown={onRowEvent}
                        onClick={onRowEvent}
                      >
                        {row}
                        {siblings.map((sibling) => (
                          <ThreadRow
                            key={sibling.id}
                            thread={sibling}
                            crossProjectId={crossProjectId}
                            isActive={false}
                            options={options}
                          />
                        ))}
                      </div>
                    </ThreadRowActionsCustomizingContext.Provider>
                  </CustomizeRowActionsContext.Provider>
                </SidebarRenameProvider>
              </ThreadSelectionProvider>
            </ThreadRowNavigationProvider>
          </TooltipProvider>
        </SidebarProvidersContext.Provider>
      </SidebarProjectsContext.Provider>
    </SidebarRowMetadataExperiment>
  );
  const reportedContent = onStickyRowHeight ? (
    <StickyRowStateReportProvider value={onStickyRowHeight}>
      {content}
    </StickyRowStateReportProvider>
  ) : content;
  return isCompactViewport === undefined ? reportedContent : (
    <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
      {reportedContent}
    </CompactViewportOverrideProvider>
  );
}

function ThreadRowGalleryHarness({
  threads,
}: {
  threads: PluginSidebarThread[];
}) {
  return (
    <>
      {threads.map((thread) => (
        <ThreadRowHarness key={thread.id} thread={thread} />
      ))}
    </>
  );
}

function renderThreadRows(
  threads: PluginSidebarThread[],
  callRpc: PluginBrowserBbSdk["plugins"]["callRpc"],
): RenderedSlot {
  return renderSlot(
    { component: ThreadRowGalleryHarness },
    { threads },
    {
      sidebarThreads: { threads, projects: [] },
      sdk: { plugins: { callRpc } },
    },
  );
}

interface RenderThreadRowArgs extends Omit<HarnessProps, "thread"> {
  thread?: PluginSidebarThread;
  hasComposerDraft?: boolean;
  hiddenDraftThreadIds?: string[];
  shortcutKey?: string;
  pluginStatus?: PluginSidebarThreadRowStatus;
  splitLayout?: PluginSidebarSplitLayout;
  projects?: PluginSidebarProject[];
  providers?: PluginProvidersState["providers"];
  sidebarPullRequest?: ThreadListPullRequest;
  openUrl?: (url: string) => boolean;
  sdk?: PluginSdkTestFakes;
  threadActions?: TestThreadActionsResolver;
  threadBulkActions?: TestThreadBulkActionsResolver;
  experiments?: string[];
}

function renderThreadRow({
  thread = createThread(),
  hasComposerDraft = false,
  hiddenDraftThreadIds = [],
  shortcutKey,
  pluginStatus,
  splitLayout,
  projects = [],
  providers = [],
  sidebarPullRequest,
  openUrl,
  sdk,
  threadActions = hostThreadActions(),
  threadBulkActions,
  experiments,
  ...harness
}: RenderThreadRowArgs = {}): RenderedSlot & {
  rerenderThreadRow(nextThread: PluginSidebarThread): void;
} {
  const rowThread = sidebarPullRequest
    ? {
        ...thread,
        environment: thread.environment ?? {
          id: `environment-${thread.id}`,
          name: null,
          branchName: null,
          path: null,
          isWorktree: null,
          providerId: null,
          workspaceDisplayKind: null,
        },
      }
    : thread;
  const slot = renderSlot(
    { component: ThreadRowHarness },
    { thread: rowThread, projects, providers, ...harness },
    {
      sidebarThreads: {
        threads: [rowThread, ...(harness.siblings ?? [])],
        projects,
      },
      providers: { providers },
      sidebarDraftThreadIds: [
        ...(hasComposerDraft ? [thread.id] : []),
        ...hiddenDraftThreadIds,
      ],
      sidebarRowStatuses: pluginStatus ? { [thread.id]: pluginStatus } : {},
      experimental_rpcContract: threadListPullRequestRpcContract,
      rpc: {
        pullRequests: (input) => {
          const { keys } =
            threadListPullRequestRpcContract.pullRequests.input.parse(input);
          return Object.fromEntries(
            keys.flatMap((key) =>
              sidebarPullRequest && key === rowThread.environment?.id
                ? [
                    [
                      key,
                      { outcome: "available", pullRequest: sidebarPullRequest },
                    ],
                  ]
                : [],
            ),
          );
        },
      },
      sidebarShortcuts: shortcutKey
        ? {
            [thread.id]: {
              label: `⌘${shortcutKey}`,
              ariaKeyshortcuts: `Meta+${shortcutKey}`,
            },
          }
        : {},
      sidebarSplitLayout: splitLayout,
      openUrl,
      sdk,
      threadActions,
      threadBulkActions,
      experiments,
    },
  );
  return Object.assign(slot, {
    rerenderThreadRow(nextThread: PluginSidebarThread) {
      slot.lifecycle.rerender(
        <ThreadRowHarness
          thread={nextThread}
          projects={projects}
          providers={providers}
          {...harness}
        />,
      );
    },
  });
}

function twoPaneLayout(threadId: string): PluginSidebarSplitLayout {
  return {
    panes: [
      {
        paneId: "pane-thread",
        rect: { x: 0, y: 0, width: 0.5, height: 1 },
        threadId,
        isFocused: true,
      },
      {
        paneId: "pane-compose",
        rect: { x: 0.5, y: 0, width: 0.5, height: 1 },
        threadId: null,
        isFocused: false,
      },
    ],
  };
}

function getIndicatorIcon(label: string, iconName: string): Element | null {
  screen.getByLabelText(label);
  return document.querySelector(`[data-icon="${iconName}"]`);
}

function renderSplitThreadRow(args: RenderThreadRowArgs = {}) {
  const thread = args.thread ?? createThread();
  return renderThreadRow({
    ...args,
    thread,
    splitLayout: twoPaneLayout(thread.id),
  });
}

function renderedIndicators(): Array<string | null> {
  return Array.from(
    document.querySelectorAll("[data-thread-status-glyph]"),
    (glyph) => glyph.getAttribute("data-thread-status-glyph"),
  );
}

function statusGlyph(): HTMLElement {
  const glyph = document.querySelector<HTMLElement>(
    "[data-thread-status-glyph]",
  );
  if (!glyph) {
    throw new Error("Expected a thread status glyph");
  }
  return glyph;
}

function openActionsMenu() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Thread actions" }),
    {
      button: 0,
    },
  );
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

interface RanThreadAction {
  key: string;
  threadId: string;
}

function hostThreadActions({
  ran = [],
  archiveRun,
}: {
  ran?: RanThreadAction[];
  archiveRun?: () => Promise<void>;
} = {}): TestThreadActionsResolver {
  return (thread, { requestRename }) => {
    const entry = (
      key: string,
      label: string,
      icon: string,
      run: () => Promise<void> = async () => {
        ran.push({ key, threadId: thread.id });
      },
    ): PluginThreadActionEntry => ({
      key,
      pluginId: key.split("/")[0] ?? "bb--core",
      group: "2_organize",
      action: {
        label,
        icon,
        run: () => run().catch(() => undefined),
      },
    });
    const isArchived = thread.archivedAt !== null;
    return [
      entry("bb--core/copyLink", "Copy link", "Copy"),
      entry(
        "bb--core/pin",
        thread.pinnedAt === null ? "Pin" : "Unpin",
        thread.pinnedAt === null ? "Pin" : "PinOff",
      ),
      ...(thread.parentThreadId === null && !isArchived
        ? [entry("thread-list/move", "Move to section", "SectionMove")]
        : []),
      entry("bb--core/rename", "Rename", "Edit", async () => {
        requestRename(thread.id);
      }),
      entry(
        "bb--core/archive",
        isArchived ? "Unarchive" : "Archive",
        isArchived ? "ArchiveRestore" : "Archive",
        archiveRun,
      ),
    ];
  };
}

const pointerState = vi.hoisted(() => ({ coarse: false }));
vi.mock("@/components/ui/hooks/use-pointer-coarse", () => ({
  usePointerCoarse: () => pointerState.coarse,
}));

async function expectRenamePresentation(outcome: RenamePresentationOutcome) {
  if (outcome === "none") {
    expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull();
    return;
  }
  const input = await screen.findByRole("textbox", { name: "Thread name" });
  expect(input).toHaveProperty("value", "Thread");
  expect(input.closest('[role="dialog"]') === null ? "inline" : "dialog").toBe(
    outcome,
  );
  fireEvent.keyDown(input, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull(),
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  pointerState.coarse = false;
  vi.restoreAllMocks();
  resetSidebarTitleDoubleClickForTest();
  resetPreferencesSyncForTest();
});

const sdkExportsAreSpyable =
  Object.getOwnPropertyDescriptor(pluginSdk, "experimental_useExperiment")
    ?.configurable === true;

describe("ThreadRow", () => {
  it("reports the actual height of a sticky parent without row state", () => {
    const reportHeight = vi.fn();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 280, 34),
    );
    renderThreadRow({
      options: {
        kind: "parent",
        depth: 1,
        isCompact: false,
        stickyLevel: 0,
      },
      onStickyRowHeight: reportHeight,
    });

    expect(reportHeight).toHaveBeenCalledWith(34);
  });

  it("uses one leading mode column without a blank title slot", () => {
    const view = renderThreadRow({ thread: createThread({ experimental_nativeTerminal: true }) });
    expect(view.container.querySelectorAll('[data-icon="Terminal"]')).toHaveLength(1);
    expect(view.container.querySelector('.bb-thread-title [role="img"]')).toBeNull();
    expect(view.container.querySelector('[data-thread-title-mode]')).toBeNull();
  });

  it("emphasizes desktop titles while keeping context secondary", () => {
    const view = renderThreadRow();
    expect(view.container.querySelector(".bb-thread-title")?.classList.contains("md:data-[emphasized=true]:font-medium")).toBe(true);
    expect(view.container.querySelector("[data-sidebar-thread-context]")?.classList.contains("text-muted-foreground")).toBe(true);
  });
  it("shows Terminal for an idle native thread without live activity", () => {
    renderThreadRow({ thread: createThread({ experimental_nativeTerminal: true }) });
    const glyph = screen.getByRole("img", { name: "Native terminal" });
    expect(glyph.querySelector('[data-icon="Terminal"]')).not.toBeNull();
    expect(glyph.classList.contains("md:hidden")).toBe(false);
  });

  it.each([false, true])(
    "renders terminal attention and input on compact=%s and clears them with state",
    (isCompactViewport) => {
      const view = renderThreadRow({
        isCompactViewport,
        thread: createThread({
          status: "active",
          runtimeStatus: "active",
          experimental_nativeTerminal: true,
          experimental_nativeActivity: {
            lastEvidenceAt: Date.now(),
            freshForMs: 90_000,
            confirmation: "confirmed",
            evidenceKind: "holder-report",
          },
        }),
      });
      expect(screen.getByRole("img", { name: /^Working/ })).toBeTruthy();
      expect(renderedIndicators()).toEqual(["working"]);
      view.rerenderThreadRow(
        createThread({
          status: "active",
          runtimeStatus: "active",
          indicator: "check-terminal",
          experimental_nativeTerminal: true,
        }),
      );
      expect(screen.getByRole("img", { name: "Check terminal" })).toBeTruthy();
      expect(
        view.container.querySelector(
          '[data-thread-status-glyph="check-terminal"]',
        ),
      ).not.toBeNull();
      view.unmount();
      const inputView = renderThreadRow({
        isCompactViewport,
        thread: createThread({
          indicator: "check-terminal",
          hasPendingInteraction: true,
          experimental_nativeTerminal: true,
        }),
      });
      expect(screen.getByRole("img", { name: "Needs input" })).toBeTruthy();
      expect(screen.queryByRole("img", { name: "Check terminal" })).toBeNull();
      inputView.unmount();
      renderThreadRow({
        isCompactViewport,
        thread: createThread({ indicator: "none" }),
      });
      expect(screen.queryByRole("img", { name: "Check terminal" })).toBeNull();
    },
  );

  it.each([
    ["Workspace", createThread({ environment: null })],
    ["Workspace", createThread({ environment: makeSidebarEnvironment({ isWorktree: false }) })],
    ["Worktree", createThread({ environment: makeSidebarEnvironment({ isWorktree: true }) })],
    ["Native terminal", createThread({ experimental_nativeTerminal: true, experimental_nativeActivity: { lastEvidenceAt: null, freshForMs: 90_000, confirmation: "unconfirmed", evidenceKind: "unknown" } })],
  ] as const)("reserves one title glyph slot and no metadata glyph slot for %s", (label, thread) => {
    const view = renderThreadRow({ thread });
    const context = view.container.querySelector("[data-sidebar-thread-context]");
    const slot = view.container.querySelector("[data-sidebar-thread-leading]");
    expect(slot?.classList.contains("size-4") ?? false).toBe(label !== "Workspace");
    expect(context?.querySelector('[role="img"]')).toBeNull();
    expect(context?.classList.contains("pl-5")).toBe(false);
    if (label !== "Workspace") {
      expect(screen.getByRole("img", { name: label }).closest("[data-sidebar-thread-leading]")).toBe(slot);
    } else {
      expect(slot).toBeNull();
    }
    expect(context?.classList.contains("md:text-sm")).toBe(true);
  });

  it.each([
    ["project:proj_context", "2m"],
    ["project:proj_other", "Orbital · 2m"],
    ["threads", "Orbital · 2m"],
    ["pinned", "Orbital · 2m"],
    ["section:custom", "Orbital · 2m"],
  ])("shows project context only outside its own project group (%s)", (group, expected) => {
    const updatedAt = Date.now() - 120_000;
    const view = renderThreadRow({
      visibilityGroup: group,
      thread: createThread({ projectId: "proj_context", updatedAt, archivedAt: 1 }),
      projects: [{ id: "proj_context", name: "Orbital", isPersonal: false, href: "/", settingsHref: "/" }],
    });
    expect(view.container.querySelector("[data-sidebar-thread-context]")?.textContent).toBe(expected);
  });

  it("shows project and age context without requiring plugin metadata", () => {
    const updatedAt = Date.now() - 120_000;
    const view = renderThreadRow({
      thread: createThread({ projectId: "proj_context", updatedAt, archivedAt: 1 }),
      projects: [{ id: "proj_context", name: "Orbital", isPersonal: false, href: "/", settingsHref: "/" }],
    });
    const context = view.container.querySelector("[data-sidebar-thread-context]");
    expect(context?.textContent).toBe("Orbital · 2m");
    expect(context?.querySelector("time")?.dateTime).toBe(new Date(updatedAt).toISOString());
    expect(view.container.querySelector("[data-thread-row-metadata]")).toBeNull();
    expect(screen.queryByRole("img", { name: "Native terminal", hidden: true })).toBeNull();
  });

  it("keeps age context when the project is unavailable", () => {
    const view = renderThreadRow({ thread: createThread({ updatedAt: Date.now(), archivedAt: 1 }) });
    expect(view.container.querySelector("[data-sidebar-thread-context]")?.textContent).toBe("now");
  });

  it.each([true, false])(
    "identifies destinations for same-title phone worktrees (native: %s)",
    (nativeTerminal) => {
      const project = makePluginProject({ id: "proj_atlas", name: "Atlas" });
      const threads = ["alpha", "beta"].map((branch) =>
        createThread({
          id: `thr_${branch}`,
          projectId: project.id,
          title: "Investigate timeout",
          displayTitle: "Investigate timeout",
          href: `/threads/thr_${branch}`,
          experimental_nativeTerminal: nativeTerminal,
          environment: makeSidebarEnvironment({
            name: null,
            branchName: `fix/phone-identical-prefix-timeout-${branch}`,
            isWorktree: true,
          }),
        }),
      );
      renderThreadRow({
        isCompactViewport: true,
        projects: [project],
        thread: threads[0]!,
        siblings: [threads[1]!],
      });
      for (const branch of ["alpha", "beta"]) {
        const link = screen.getByRole("link", {
          name: `Open Investigate timeout · Atlas · fix/phone-identical-prefix-timeout-${branch}`,
        });
        expect(link.getAttribute("href")).toBe(`/threads/thr_${branch}`);
      }
    },
  );

  it("keeps grouped phone project context in its heading and omits absent branch identity", () => {
    const view = renderThreadRow({
      isCompactViewport: true,
      visibilityGroup: "project:proj_atlas",
      projects: [makePluginProject({ id: "proj_atlas", name: "Atlas" })],
      thread: createThread({
        projectId: "proj_atlas",
        environment: null,
        updatedAt: Date.now() - 120_000,
      }),
    });
    expect(
      view.container.querySelector("[data-sidebar-thread-context]")
        ?.textContent,
    ).toBe("2m");
    expect(
      screen
        .getByRole("link", { name: "Open Thread · Atlas" })
        .getAttribute("aria-label"),
    ).not.toContain("null");
  });

  it.skipIf(!sdkExportsAreSpyable)("shares the metadata experiment subscription with sibling rows", () => {
    const subscribe = vi.spyOn(pluginSdk, "experimental_useExperiment");
    renderThreadRow({
      thread: createThread({ archivedAt: 1 }),
      siblings: Array.from({ length: 20 }, (_, index) =>
        createThread({ id: `sibling-${index}`, archivedAt: 1 }),
      ),
    });
    expect(
      subscribe.mock.calls.filter(
        ([key]) => key === THREAD_ROW_METADATA_EXPERIMENT,
      ),
    ).toHaveLength(1);
  });
  it("preserves nesting indentation while keeping compact title spacing", () => {
    const view = renderThreadRow({ thread: createThread({ archivedAt: 1 }) });
    const row = view.container.querySelector<HTMLElement>(
      "[data-sidebar-rename-row]",
    );
    expect(row?.style.paddingLeft).toBe("22px");
    expect(row?.classList.contains("gap-1")).toBe(true);
  });
  it("renders bounded status chips and progress on the row", () => {
    const statuses = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `status-${index}`,
        { value: `A long status value ${index}`, priority: 8 - index },
      ]),
    );
    renderThreadRow({
      thread: createThread({
        archivedAt: Date.now(),
        experimental_rowState: {
          statuses,
          progress: { value: 0.4, label: "Implementation" },
        },
      }),
    });

    expect(
      document.querySelectorAll("[data-sidebar-thread-status-chip]"),
    ).toHaveLength(2);
    expect(screen.getByText("+6 more")).toBeTruthy();
    expect(
      screen
        .getByRole("progressbar", { name: "Implementation" })
        .getAttribute("aria-valuenow"),
    ).toBe("40");
    expect(
      screen.getByText("A long status value 0").classList.contains("truncate"),
    ).toBe(true);
  });

  it("renders cleared status and progress without stale row indicators", () => {
    const { rerenderThreadRow } = renderThreadRow({
      thread: createThread({
        archivedAt: Date.now(),
        experimental_rowState: {
          statuses: {
            removed: { value: "Cleared status" },
            remaining: { value: "Still active" },
          },
          progress: { value: 0.4, label: "In progress" },
        },
      }),
    });

    expect(screen.getByText("Cleared status")).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "In progress" }),
    ).toBeTruthy();

    rerenderThreadRow(
      createThread({
        archivedAt: Date.now(),
        experimental_rowState: {
          statuses: { remaining: { value: "Still active" } },
          progress: null,
        },
      }),
    );

    expect(screen.getByText("Still active")).toBeTruthy();
    expect(screen.queryByText("Cleared status")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("renders Needs input, Working, Woke 3m elapsed, and Done labels", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 20_001);
    const callRpc = vi.fn().mockResolvedValue({
      automations: [
        {
          automation: {
            lastRunStatus: "running",
            lastRunThreadId: "thr_woke",
            lastRunAt: Date.now() - (3 * 60_000 + 30_000),
          },
        },
      ],
    }) as PluginBrowserBbSdk["plugins"]["callRpc"];
    const threads = [
      createThread({
        id: "thr_input",
        hasPendingInteraction: true,
      }),
      createThread({
        id: "thr_working",
        status: "active",
        runtimeStatus: "active",
      }),
      createThread({
        id: "thr_woke",
        experimental_rowState: {
          statuses: { task: { value: "Running" } },
          progress: { value: 0.3, label: "Writing tests" },
        },
      }),
      createThread({ id: "thr_done", isUnread: true }),
    ];
    renderThreadRows(threads, callRpc);
    await waitFor(() =>
      expect(screen.getByLabelText("Needs input")).toBeTruthy(),
    );
    expect(screen.getByLabelText("Working")).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText("Woke 3m")).toBeTruthy());
    expect(screen.getByText("Running")).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "Writing tests" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Done")).toBeTruthy();
    expect(callRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "automations",
        method: "automations_overview",
      }),
    );
  });

  it("reserves a compact status slot with full accessible status text", async () => {
    const callRpc = vi.fn().mockResolvedValue({
      automations: [],
    }) as PluginBrowserBbSdk["plugins"]["callRpc"];
    const { container } = renderThreadRows(
      [createThread({ id: "thr_done", isUnread: true })],
      callRpc,
    );

    await waitFor(() =>
      expect(
        container.querySelector("[data-sidebar-status-slot]"),
      ).not.toBeNull(),
    );
    expect(
      container.querySelector('[data-sidebar-status-slot][aria-label="Done"]'),
    ).not.toBeNull();
    const statusSlot = container.querySelector("[data-sidebar-status-slot]");
    expect(statusSlot?.classList.contains("whitespace-nowrap")).toBe(true);
    expect(
      statusSlot?.closest("[data-sidebar-thread-trailing]"),
    ).not.toBeNull();
    expect(
      statusSlot?.parentElement?.getAttribute("style") ?? "",
    ).not.toContain("overflow: hidden");
  });

  it("updates only rows whose automation status or elapsed minute changed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
    const startedAt = Date.now() - 60_000;
    const callRpc = vi.fn().mockResolvedValue({
      automations: [
        {
          automation: {
            lastRunStatus: "running",
            lastRunThreadId: "thr_automation_active",
            lastRunAt: startedAt,
          },
        },
      ],
    }) as PluginBrowserBbSdk["plugins"]["callRpc"];
    const renders: Record<string, number> = {};
    const Probe = ({ threadId }: { threadId: string }) => {
      const snapshot = useAutomationWokeAt(threadId);
      renders[threadId] = (renders[threadId] ?? 0) + 1;
      return <span>{snapshot.elapsedMinutes ?? "none"}</span>;
    };
    const Probes = () => (
      <>
        <Probe threadId="thr_automation_active" />
        <Probe threadId="thr_automation_idle" />
      </>
    );
    renderSlot({ component: Probes }, {}, { sdk: { plugins: { callRpc } } });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(callRpc).toHaveBeenCalledTimes(1);
    const beforeRefresh = { ...renders };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(renders).toEqual(beforeRefresh);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(renders["thr_automation_active"]).toBe(
      beforeRefresh["thr_automation_active"] + 1,
    );
    expect(renders["thr_automation_idle"]).toBe(
      beforeRefresh["thr_automation_idle"],
    );
  });

  it("renders open, draft, merged, and closed PR rows together", async () => {
    const states = ["open", "draft", "merged", "closed"] as const;
    const threads = states.map((state) =>
      createThread({
        id: `thread-${state}`,
        title: `${state} thread`,
        environment: {
          id: `environment-${state}`,
          name: null,
          branchName: null,
          path: null,
          isWorktree: null,
          providerId: null,
          workspaceDisplayKind: null,
        },
      }),
    );
    const pullRequests = Object.fromEntries(
      states.map((state, index) => [
        threads[index].environment!.id!,
        {
          outcome: "available",
          pullRequest: createPullRequest(state, 10843 + index),
        },
      ]),
    );
    const slot = renderSlot(
      { component: ThreadRowGalleryHarness },
      { threads },
      {
        experimental_rpcContract: threadListPullRequestRpcContract,
        sidebarThreads: { threads },
        rpc: { pullRequests: () => pullRequests },
      },
    );

    for (const [index, state] of states.entries()) {
      expect(
        await slot.findByRole("link", {
          name: new RegExp(`Pull request #${10843 + index}`),
        }),
      ).toBeTruthy();
      expect(slot.getByText(`${state} thread`)).toBeTruthy();
    }
  });

  it("keeps the PR chip in the trailing row while status is visible", async () => {
    renderThreadRow({
      thread: createThread({ isUnread: true }),
      sidebarPullRequest: createPullRequest("open"),
    });
    const pullRequest = await screen.findByRole("link", {
      name: /Pull request #10843/,
    });

    expect(pullRequest.closest(".bb-sidebar-hover-actions")).toBeNull();
    expect(
      pullRequest.closest("[data-sidebar-thread-trailing]"),
    ).not.toBeNull();
  });

  it("keeps the PR badge and row actions in the row's trailing layout lane", async () => {
    const { container } = renderThreadRow({
      sidebarPullRequest: createPullRequest("open"),
    });
    const trailing = container.querySelector<HTMLElement>(
      "[data-sidebar-thread-trailing]",
    );
    const controls = container.querySelector<HTMLElement>(
      "[data-sidebar-row-controls]",
    );
    const actionSlot = controls?.parentElement;
    const pullRequest = await screen.findByRole("link", {
      name: /Pull request #10843/,
    });

    expect(trailing?.contains(pullRequest)).toBe(true);
    expectPersistentRowMetadata(pullRequest);
    expect(trailing?.contains(controls)).toBe(true);
    expect(actionSlot?.classList.contains("absolute")).toBe(false);
  });

  it("reserves no permanent trailing space for hover actions on hover-capable pointers", () => {
    const { container } = renderThreadRow({
      thread: createThread({ status: "active", runtimeStatus: "active" }),
      sidebarPullRequest: createPullRequest("open"),
    });
    const controls = container.querySelector<HTMLElement>(
      "[data-sidebar-row-controls]",
    );
    const actionSlot = controls?.parentElement;
    const badges = container.querySelector<HTMLElement>(
      "[data-sidebar-thread-trailing-badges]",
    );
    const titleLane = screen.getByRole("link", {
      name: "Open Thread",
    }).parentElement;

    expect(actionSlot?.className).toContain("[@media(hover:hover)]:absolute");
    expect(actionSlot?.className).not.toMatch(/(^|\s)(w-|min-w-)\S+/);
    expect(badges?.className).toContain("bb-sidebar-hover-actions-fade");
    expect(badges?.contains(screen.getByLabelText("Working"))).toBe(true);
    expect(titleLane?.className).toContain("bb-sidebar-hover-actions-inset");
    expect(
      titleLane?.style.getPropertyValue("--bb-sidebar-hover-actions-inset"),
    ).not.toBe("");
  });

  it("fades the trailing badges while the actions menu is open so they never draw under the actions", async () => {
    const { container } = renderThreadRow({
      sidebarPullRequest: createPullRequest("open"),
    });
    const badges = container.querySelector<HTMLElement>(
      "[data-sidebar-thread-trailing-badges]",
    )!;
    expect(badges.hasAttribute("data-sidebar-hover-actions-open")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    await screen.findByRole("menuitem", { name: "Rename" });

    expect(badges.getAttribute("data-sidebar-hover-actions-open")).toBe("true");
    expect(badges.className).toContain("bb-sidebar-hover-actions-fade");
    expect(badges.className).toContain("[@media(hover:none)]:opacity-100!");
  });

  it("keeps working status, PR badge, and actions in the trailing layout lane", async () => {
    const { container } = renderThreadRow({
      thread: createThread({ status: "active", runtimeStatus: "active" }),
      sidebarPullRequest: createPullRequest("open"),
    });
    const trailing = container.querySelector<HTMLElement>(
      "[data-sidebar-thread-trailing]",
    );
    const status = screen.getByLabelText("Working");
    const controls = container.querySelector<HTMLElement>(
      "[data-sidebar-row-controls]",
    );
    const actionSlot = controls?.parentElement;
    const pullRequest = await screen.findByRole("link", {
      name: /Pull request #10843/,
    });

    expect(trailing?.contains(status)).toBe(true);
    expectPersistentRowMetadata(status);
    expectPersistentRowMetadata(pullRequest);
    expect(trailing?.contains(pullRequest)).toBe(true);
    expect(trailing?.contains(controls)).toBe(true);
    expect(actionSlot?.classList.contains("absolute")).toBe(false);
  });

  it("keeps undelivered queued messages visible and does not repeat the native activity state beside them", () => {
    const { container } = renderThreadRow({
      thread: createThread({
        status: "active",
        runtimeStatus: "active",
        queuedWork: "failed",
        experimental_queuedFailedCount: 4,
        experimental_nativeTerminal: true,
        experimental_nativeActivity: {
          lastEvidenceAt: null,
          freshForMs: 90_000,
          confirmation: "unconfirmed",
          evidenceKind: "unknown",
        },
      }),
    });

    const queued = container.querySelector(
      '[data-thread-status-glyph="queued-failed"]',
    );
    expect(screen.getByRole("img", { name: "Native terminal", hidden: true })).toBeTruthy();
    expect(queued?.getAttribute("data-queued-failed-count")).toBe("4");
    expect(
      container.querySelector("[data-sidebar-native-activity-warning]"),
    ).toBeNull();
    expect(container.querySelector('[aria-label="Working"]')).toBeNull();
    const slot = container.querySelector(
      "[data-sidebar-thread-trailing-indicator]",
    );
    expect(slot?.classList.contains("px-0")).toBe(true);
    expect(slot?.classList.contains("px-1.5")).toBe(false);
  });

  it("keeps the activity warning screen-reader only beside a queued clock, which has no status text", () => {
    const { container } = renderThreadRow({
      thread: createThread({
        lastReadAt: 1,
        latestAttentionAt: 1,
        queuedWork: "waiting",
        experimental_nativeActivity: {
          lastEvidenceAt: null,
          freshForMs: 90_000,
          confirmation: "unconfirmed",
          evidenceKind: "unknown",
        },
      }),
    });

    expect(renderedIndicators()).toEqual(["queued-waiting"]);
    const warning = container.querySelector(
      "[data-sidebar-native-activity-warning]",
    );
    expect(warning?.textContent).toBe("Activity not reported");
    expect(warning?.classList.contains("sr-only")).toBe(true);
    expect(warning?.classList.contains("text-muted-foreground")).toBe(false);
  });

  describe("recovery guidance for an activity that is not reported", () => {
    const unconfirmed = (
      evidenceKind: "tool-call" | "unknown" = "unknown",
    ) => ({
      ...(evidenceKind === "tool-call" ? { lastToolCallAt: Date.now() } : {}),
      lastEvidenceAt: null,
      freshForMs: 90_000,
      confirmation: "unconfirmed" as const,
      evidenceKind,
    });
    const guidanceOf = (container: HTMLElement) =>
      container.querySelector("[data-sidebar-native-activity-guidance]");

    it("keeps the short label, and carries the host-aware guidance in the accessible description", () => {
      const { container } = renderThreadRow({
        thread: createThread({
          id: "thr_native",
          status: "active",
          runtimeStatus: "active",
          host: { id: "host_1", name: "Build box" },
          experimental_nativeActivity: unconfirmed(),
        }),
      });
      const label = screen.getByRole("img", { name: "Activity not reported" });
      expect(label.textContent).toContain("Activity not reported");
      expect(label.getAttribute("aria-describedby")).toBe(
        guidanceOf(container)?.id,
      );
      expect(guidanceOf(container)?.textContent).toBe(
        "If this session started before bb was updated, update bb on Build box, save your work, type /exit in the terminal, then reopen with bb thread native thr_native. A pending question will need to be asked again.",
      );
      expect(
        label.querySelector("[data-sidebar-status-full]")?.textContent,
      ).toBe("Activity not reported");
    });

    it("falls back to this thread's machine when the host is unknown", () => {
      const { container } = renderThreadRow({
        thread: createThread({
          status: "active",
          runtimeStatus: "active",
          host: null,
          experimental_nativeActivity: unconfirmed(),
        }),
      });
      expect(guidanceOf(container)?.textContent).toContain(
        "update bb on this thread's machine, save your work",
      );
    });

    it("shows the guidance for tool-call-only evidence and does not turn it into Working", () => {
      const { container } = renderThreadRow({
        thread: createThread({
          status: "active",
          runtimeStatus: "active",
          experimental_nativeActivity: unconfirmed("tool-call"),
        }),
      });
      expect(guidanceOf(container)).not.toBeNull();
      expect(
        screen.getByRole("img", { name: /Agent tool call seen/u }),
      ).toBeTruthy();
      expect(container.querySelector('[aria-label="Working"]')).toBeNull();
    });

    it("shows no guidance for confirmed activity", () => {
      const { container } = renderThreadRow({
        thread: createThread({
          status: "active",
          runtimeStatus: "active",
          experimental_nativeActivity: {
            lastEvidenceAt: Date.now(),
            freshForMs: 90_000,
            confirmation: "confirmed",
            evidenceKind: "holder-report",
          },
        }),
      });
      expect(guidanceOf(container)).toBeNull();
      expect(
        container
          .querySelector("[data-sidebar-thread-trailing-indicator]")
          ?.getAttribute("aria-describedby") ?? null,
      ).toBeNull();
    });

    it("offers no action: the description is plain text", () => {
      const { container } = renderThreadRow({
        thread: createThread({
          status: "active",
          runtimeStatus: "active",
          experimental_nativeActivity: unconfirmed(),
        }),
      });
      expect(
        guidanceOf(container)?.querySelectorAll("button, a, input"),
      ).toHaveLength(0);
    });

    it("shows no guidance, no lead and no description next to a pending question", async () => {
      const { container } = renderThreadRow({
        thread: createThread({
          status: "active",
          runtimeStatus: "active",
          hasPendingInteraction: true,
          experimental_nativeActivity: unconfirmed(),
        }),
      });
      const indicator = screen.getByRole("img", { name: "Needs input" });
      expect(indicator.getAttribute("aria-describedby")).toBeNull();
      expect(guidanceOf(container)).toBeNull();
      expect(
        container.querySelector("[data-sidebar-native-activity-warning]"),
      ).toBeNull();
      expect(container.textContent).not.toContain("Activity not reported");
      fireEvent.pointerMove(indicator);
      expect((await screen.findByRole("tooltip")).textContent).toBe(
        "Needs input",
      );
    });

    it("shows no guidance, no lead and no description next to undelivered queued messages", async () => {
      const { container } = renderThreadRow({
        thread: createThread({
          status: "active",
          runtimeStatus: "active",
          queuedWork: "failed",
          experimental_queuedFailedCount: 2,
          experimental_nativeActivity: unconfirmed(),
        }),
      });
      const indicator = container.querySelector(
        "[data-sidebar-thread-trailing-indicator]",
      );
      expect(
        container.querySelector('[data-thread-status-glyph="queued-failed"]'),
      ).not.toBeNull();
      expect(indicator?.getAttribute("aria-describedby")).toBeNull();
      expect(indicator?.getAttribute("title")).toBeNull();
      expect(guidanceOf(container)).toBeNull();
      expect(
        container.querySelector("[data-sidebar-native-activity-warning]"),
      ).toBeNull();
      expect(container.textContent).not.toContain("Activity not reported");
    });

    it("leaves a pending question as Needs input", () => {
      renderThreadRow({
        thread: createThread({
          status: "active",
          runtimeStatus: "active",
          hasPendingInteraction: true,
          experimental_nativeActivity: unconfirmed(),
        }),
      });
      expect(screen.getByRole("img", { name: "Needs input" })).toBeTruthy();
      expect(screen.queryByRole("img", { name: "Working" })).toBeNull();
    });
  });

  it("shows native activity uncertainty without a runtime Working label", () => {
    const { container } = renderThreadRow({
      thread: createThread({
        status: "active",
        runtimeStatus: "active",
        experimental_nativeActivity: {
          lastEvidenceAt: null,
          freshForMs: 90_000,
          confirmation: "unconfirmed",
          evidenceKind: "unknown",
        },
      }),
    });
    const warning = screen.getByRole("img", { name: "Activity not reported" });

    expect(warning.textContent).toContain("Activity not reported");
    expect(container.querySelector('[aria-label="Working"]')).toBeNull();
  });

  it.each([
    { label: "Working", state: { status: "active", runtimeStatus: "active" } },
    { label: "Needs input", state: { hasPendingInteraction: true } },
    {
      label: "Check terminal",
      state: { indicator: "check-terminal", experimental_nativeTerminal: true },
    },
  ] as const)(
    "keeps $label visible with one compact action and reachable Archive",
    async ({ label, state }) => {
      const ran: RanThreadAction[] = [];
      const { container } = renderThreadRow({
        isCompactViewport: true,
        thread: createThread(state),
        threadActions: hostThreadActions({ ran }),
      });
      expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
      const controls = container.querySelector("[data-sidebar-row-controls]")!;
      expect(controls.querySelectorAll("button")).toHaveLength(1);
      expectPersistentRowMetadata(screen.getByRole("img", { name: label }));
      fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
      await waitFor(() =>
        expect(ran).toEqual([
          { key: "bb--core/archive", threadId: "thr_test" },
        ]),
      );
      expectPersistentRowMetadata(screen.getByRole("img", { name: label }));
    },
  );

  it.each(
    [false, true].flatMap((isCompactViewport) =>
      (["Working", "Done"] as const).flatMap((statusLabel) =>
        (["resting", "hover", "focus", "menu-open"] as const).flatMap((state) =>
          [undefined, "3"].map((shortcutKey) => ({
            isCompactViewport,
            statusLabel,
            state,
            shortcutKey,
          })),
        ),
      ),
    ),
  )(
    "keeps $statusLabel and the PR visible in $state (mobile=$isCompactViewport, shortcut=$shortcutKey)",
    async ({ isCompactViewport, statusLabel, state, shortcutKey }) => {
      const { container } = renderThreadRow({
        thread: createThread(
          statusLabel === "Working"
            ? { status: "active", runtimeStatus: "active" }
            : { isUnread: true },
        ),
        isCompactViewport,
        shortcutKey,
        sidebarPullRequest: createPullRequest("open"),
      });
      const row = container.querySelector<HTMLElement>(
        "[data-sidebar-rename-row]",
      )!;
      const archive = screen.queryByRole("button", { name: "Archive" });
      expect(archive === null).toBe(isCompactViewport);
      const menu = screen.getByRole("button", { name: "Thread actions" });
      if (state === "hover") {
        fireEvent.pointerEnter(row, { pointerType: "mouse" });
        fireEvent.mouseOver(row);
      } else if (state === "focus") {
        const target = archive ?? menu;
        act(() => target.focus());
        expect(document.activeElement).toBe(target);
      } else if (state === "menu-open") {
        fireEvent.click(menu);
        await screen.findByRole("menuitem", { name: "Rename" });
        expect(
          menu.closest('[data-sidebar-hover-actions-open="true"]'),
        ).not.toBeNull();
      }
      const status = screen.getByLabelText(statusLabel);
      expect(screen.getByRole("img", { name: statusLabel })).toBe(status);
      expectPersistentRowMetadata(status);
      expectPersistentRowMetadata(
        await screen.findByRole("link", { name: /Pull request #10843/ }),
      );
      const glyph = status.querySelector<HTMLElement>(
        "[data-thread-status-glyph]",
      )!;
      expect(glyph.getAttribute("data-thread-status-glyph")).toBe(
        statusLabel === "Working" ? "working" : "done-unread",
      );
      expectPersistentRowMetadata(glyph);
      if (shortcutKey) {
        expect(
          screen
            .getByRole("link", { name: "Open Thread" })
            .getAttribute("aria-keyshortcuts"),
        ).toBe("Meta+3");
        expect(
          screen.getByText("⌘3").closest("[data-sidebar-shortcut-secondary]"),
        ).not.toBeNull();
      }
      expect(status.classList.contains("shrink-0")).toBe(true);
      expect(row.querySelector(".bb-thread-title")?.classList).toContain(
        "flex-1",
      );
      expect(row.querySelector(".bb-thread-title")?.classList).toContain(
        "truncate",
      );
      expect(
        menu.closest(".bb-sidebar-hover-actions")?.classList,
      ).not.toContain("absolute");
      if (isCompactViewport) {
        expect(
          menu
            .closest("[data-sidebar-hover-actions-mobile]")
            ?.getAttribute("data-sidebar-hover-actions-mobile"),
        ).toBe("always");
      }
    },
  );

  it.each([
    ["open", "text-success-foreground"],
    ["draft", "text-muted-foreground"],
    ["merged", "text-accent-foreground"],
    ["closed", "text-destructive"],
  ] as const)(
    "shows a %s pull request chip with its state color",
    async (state, tone) => {
      const stateLabel = state[0].toUpperCase() + state.slice(1);
      const slot = renderThreadRow({
        sidebarPullRequest: createPullRequest(
          state,
          10843,
          "Add sidebar PR status",
        ),
      });

      const chip = await slot.findByRole("link", {
        name: `Pull request #10843: Add sidebar PR status, ${stateLabel}, albrand/bb`,
      });
      expect(chip.textContent).toBe("#10843");
      expect(chip.classList.contains(tone)).toBe(true);
    },
  );

  it("shows the PR title, state, and repository in its hover tooltip", async () => {
    const slot = renderThreadRow({
      sidebarPullRequest: createPullRequest(
        "open",
        10843,
        "Add sidebar PR status",
      ),
    });

    fireEvent.pointerMove(
      await slot.findByRole("link", { name: /Pull request #10843/ }),
    );

    expect((await slot.findByRole("tooltip")).textContent).toBe(
      "Add sidebar PR status · Open · albrand/bb",
    );
  });

  it("omits the PR chip when current-branch PR data is unavailable", () => {
    const slot = renderThreadRow();

    expect(slot.queryByRole("link", { name: /Pull request/ })).toBeNull();
  });

  it("does not select the row when the PR chip is clicked", async () => {
    const onRowEvent = vi.fn();
    const openUrl = vi.fn(() => true);
    const slot = renderThreadRow({
      onRowEvent,
      openUrl,
      sidebarPullRequest: createPullRequest(
        "open",
        10843,
        "Add sidebar PR status",
      ),
    });

    fireEvent.click(
      await slot.findByRole("link", { name: /Pull request #10843/ }),
    );

    expect(onRowEvent).not.toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledWith(
      "https://github.com/albrand/bb/pull/10843",
    );
  });

  it("shows the registered provider icon by default and keeps it visible during inline rename", async () => {
    const provider: PluginProvidersState["providers"][number] = {
      id: "provider-test",
      pluginId: "provider-test",
      displayName: "Test Provider",
      logoUrl: "/provider-test.svg",
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
    const slot = renderThreadRow({ providers: [provider] });
    expect(screen.getByRole("img", { name: "Test Provider" })).toBeTruthy();
    expect(
      slot.container.querySelector('[data-provider-logo="/provider-test.svg"]'),
    ).toBeTruthy();

    fireEvent.doubleClick(screen.getByText("Thread"));
    const input = await screen.findByRole("textbox", { name: "Thread name" });
    expect(screen.getByRole("img", { name: "Test Provider" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "Scratch name" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull();
    expect(screen.getByRole("img", { name: "Test Provider" })).toBeTruthy();
    expect(slot.inspection.navigateCalls).toEqual([]);

    slot.rerenderThreadRow(createThread({ providerId: "missing" }));
    expect(screen.queryByRole("img", { name: "Test Provider" })).toBeNull();
    expect(
      slot.container.querySelector("[data-sidebar-thread-provider]"),
    ).toBeNull();

    slot.rerenderThreadRow(createThread());
    act(() => getDefaultStore().set(sidebarShowProviderIconsAtom, false));
    expect(
      slot.container.querySelector("[data-sidebar-thread-provider]"),
    ).toBeNull();
  });

  it.each([
    ["native terminal", { experimental_nativeTerminal: true }, "Test Provider, native terminal", "native-terminal"],
    ["worktree", { environment: makeSidebarEnvironment({ isWorktree: true }) }, "Test Provider, worktree", "worktree"],
  ] as const)(
    "keeps the provider mark in the leading column and badges the %s mode",
    (_label, overrides, name, badge) => {
      const provider: PluginProvidersState["providers"][number] = {
        id: "provider-test",
        pluginId: "provider-test",
        displayName: "Test Provider",
        logoUrl: "/provider-test.svg",
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
      const slot = renderThreadRow({
        thread: createThread({ providerId: "provider-test", ...overrides }),
        providers: [provider],
      });
      const mark = screen.getByRole("img", { name });
      const leading = slot.container.querySelector("[data-sidebar-thread-leading]")!;
      expect(leading.contains(mark)).toBe(true);
      expect(
        leading.querySelectorAll('[data-provider-logo="/provider-test.svg"]'),
      ).toHaveLength(1);
      expect(
        leading.querySelectorAll(`[data-thread-mode-badge="${badge}"]`),
      ).toHaveLength(1);
      expect(leading.querySelectorAll('[data-icon="Terminal"], [data-icon="FolderGit"]')).toHaveLength(1);
      slot.rerenderThreadRow(createThread({ providerId: "provider-test" }));
      expect(
        slot.container.querySelector("[data-thread-mode-badge]"),
      ).toBeNull();
      expect(screen.getByRole("img", { name: "Test Provider" })).toBeTruthy();
    },
  );

  it("links the row to the thread href and leaves a plain click to the host", () => {
    const slot = renderThreadRow({
      thread: createThread({ href: "/projects/proj_test/threads/thr_test" }),
    });
    const link = screen.getByRole("link", { name: "Open Thread" });
    expect(link.getAttribute("href")).toBe(
      "/projects/proj_test/threads/thr_test",
    );
    expect(link.getAttribute("data-sidebar-thread-shortcut-target")).toBe("");
    expect(link.getAttribute("data-sidebar-thread-id")).toBe("thr_test");
    expect(link.getAttribute("data-sidebar-project-id")).toBe("proj_test");
    expect(link.getAttribute("data-sidebar-rename-anchor")).toBe("");
    expect(link.closest("[data-sidebar-rename-row]")).not.toBeNull();
    fireEvent.click(link);
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it.each([
    ["meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
  ])("opens the thread in a split on %s-click", (_label, modifier) => {
    const slot = renderThreadRow();
    const link = screen.getByRole("link", { name: "Open Thread" });
    const event = fireEvent.click(link, modifier);
    expect(event).toBe(false);
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_test", options: { split: true } },
    ]);
  });

  it.each([
    ["meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
  ])(
    "selects the row on %s-shift-click and still splits without shift with multi-select on",
    (_label, modifier) => {
      const slot = renderThreadRow({ experiments: ["sidebarMultiSelect"] });
      const link = screen.getByRole("link", { name: "Open Thread" });
      const row = link.closest("[data-sidebar-rename-row]");
      expect(row?.hasAttribute("data-sidebar-thread-selected")).toBe(false);
      expect(fireEvent.click(link, { ...modifier, shiftKey: true })).toBe(
        false,
      );
      expect(row?.hasAttribute("data-sidebar-thread-selected")).toBe(true);
      expect(slot.inspection.navigateCalls).toEqual([]);
      expect(fireEvent.click(link, modifier)).toBe(false);
      expect(row?.hasAttribute("data-sidebar-thread-selected")).toBe(false);
      expect(slot.inspection.navigateCalls).toEqual([
        { method: "toThread", threadId: "thr_test", options: { split: true } },
      ]);
    },
  );

  it("opens the bulk menu for a selected row and its own menu for an unselected one", async () => {
    const first = createThread({ id: "thr_first", title: "First" });
    const second = createThread({ id: "thr_second", title: "Second" });
    const third = createThread({ id: "thr_third", title: "Third" });
    const bulkTargets: string[][] = [];
    renderThreadRow({
      thread: first,
      siblings: [second, third],
      projects: [makePluginProject()],
      experiments: ["sidebarMultiSelect"],
      threadBulkActions: (threads) => {
        bulkTargets.push(threads.map((target) => target.id));
        return [];
      },
    });
    for (const title of ["First", "Second"]) {
      fireEvent.click(screen.getByRole("link", { name: `Open ${title}` }), {
        metaKey: true,
        shiftKey: true,
      });
    }
    fireEvent.contextMenu(screen.getByRole("link", { name: "Open Second" }));
    await screen.findByRole("menu", { name: "Actions for 2 threads" });
    expect(bulkTargets.at(-1)).toEqual(["thr_first", "thr_second"]);
    expect(
      screen.getByRole("menuitem", { name: "Clear selection" }),
    ).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(screen.getByRole("link", { name: "Open First" }), {
      metaKey: true,
      shiftKey: true,
    });
    fireEvent.click(screen.getByRole("link", { name: "Open Second" }), {
      metaKey: true,
      shiftKey: true,
    });
    fireEvent.contextMenu(screen.getByRole("link", { name: "Open Third" }));
    expect(
      await screen.findByRole("menu", { name: "Thread actions" }),
    ).toBeTruthy();
  });

  it.each(["sidebar", "outside"])(
    "clears selection on empty %s space but keeps it for rows and menus",
    (target) => {
      const { container } = renderThreadRow({
        experiments: ["sidebarMultiSelect"],
      });
      container.setAttribute("data-sidebar", "sidebar");
      const link = screen.getByRole("link", { name: "Open Thread" });
      const row = link.closest("[data-sidebar-rename-row]")!;
      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      document.body.append(menu);
      try {
        fireEvent.click(link, { metaKey: true, shiftKey: true });
        for (const keepingTarget of [
          row,
          link,
          screen.getByRole("button", { name: "Thread actions" }),
          menu,
        ]) {
          fireEvent.pointerDown(keepingTarget);
          expect(row.hasAttribute("data-sidebar-thread-selected")).toBe(true);
        }
        fireEvent.pointerDown(target === "sidebar" ? container : document.body);
        expect(row.hasAttribute("data-sidebar-thread-selected")).toBe(false);
      } finally {
        menu.remove();
      }
    },
  );

  it("keeps desktop restore available, hides it on mobile, and blocks row event propagation", async () => {
    const thread = createThread({ archivedAt: 1, isArchived: true });
    const rowEvent = vi.fn();
    const ran: RanThreadAction[] = [];
    renderThreadRow({
      thread,
      onRowEvent: rowEvent,
      threadActions: hostThreadActions({ ran }),
    });
    const restore = screen.getByRole("button", { name: "Unarchive" });
    expect(restore.querySelector('[data-icon="ArchiveRestore"]')).toBeTruthy();
    expect(restore.closest("[data-sidebar-hover-actions-open]")).toBeNull();
    expect(
      restore.closest(".\\[\\@media\\(hover\\:none\\)\\]\\:hidden"),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    fireEvent.pointerDown(restore, { pointerType: "touch", button: 0 });
    fireEvent.keyDown(restore, { key: "Enter" });
    fireEvent.click(restore);
    await waitFor(() =>
      expect(ran).toEqual([{ key: "bb--core/archive", threadId: "thr_test" }]),
    );
    expect(rowEvent).not.toHaveBeenCalled();
  });

  it("disables a row action button while its run is in flight and recovers when it fails", async () => {
    const pending = deferred();
    const archiveRun = vi.fn(() => pending.promise);
    renderThreadRow({
      thread: createThread({ archivedAt: 1, isArchived: true }),
      threadActions: hostThreadActions({ archiveRun }),
    });
    const restore = screen.getByRole<HTMLButtonElement>("button", {
      name: "Unarchive",
    });
    expect(restore.disabled).toBe(false);
    fireEvent.click(restore);
    await waitFor(() => expect(restore.disabled).toBe(true));
    fireEvent.click(restore);
    expect(archiveRun).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.reject(new Error("Unarchive failed"));
      await pending.promise.catch(() => undefined);
    });
    await waitFor(() => expect(restore.disabled).toBe(false));
  });

  it("names a choice row action with its current value", () => {
    getDefaultStore().set(preferenceValueAtom("rowActions"), [
      "push-notifications/notifications",
    ]);
    renderThreadRow({
      threadActions: () => [
        {
          key: "push-notifications/notifications",
          pluginId: "push-notifications",
          group: "1_state",
          action: {
            label: "Notifications",
            detail: "Muted",
            icon: "Notification",
            choices: {
              items: [{ id: "muted", label: "Muted", selected: true }],
            },
            run: async () => undefined,
          },
        },
      ],
    });
    expect(
      screen.getByRole("button", { name: "Notifications, Muted" }),
    ).not.toBeNull();
  });

  it("shows configured row actions in order in the trailing layout lane", async () => {
    getDefaultStore().set(preferenceValueAtom("rowActions"), [
      "bb--core/pin",
      "bb--core/copyLink",
      "bb--core/archive",
    ]);
    const ran: RanThreadAction[] = [];
    renderThreadRow({ threadActions: hostThreadActions({ ran }) });
    const controls = document.querySelector("[data-sidebar-row-controls]");
    expect(
      Array.from(controls?.querySelectorAll("button") ?? []).map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual(["Pin", "Copy link", "Archive", "Thread actions"]);
    expect(
      document
        .querySelector("[data-sidebar-thread-trailing]")
        ?.contains(controls ?? null),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    await waitFor(() =>
      expect(ran).toEqual([{ key: "bb--core/pin", threadId: "thr_test" }]),
    );
  });

  it("skips row action keys that have no action for the thread", () => {
    getDefaultStore().set(preferenceValueAtom("rowActions"), [
      "thread-list/move",
      "plugin-gone/action",
      "bb--core/archive",
    ]);
    renderThreadRow({
      thread: createThread({ parentThreadId: "thr_parent" }),
    });
    expect(
      screen.queryByRole("button", { name: "Move to section" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
    expect(
      document
        .querySelector("[data-sidebar-thread-trailing]")
        ?.contains(document.querySelector("[data-sidebar-row-controls]")),
    ).toBe(true);
  });

  it("shows only the actions menu when every row action is turned off", () => {
    getDefaultStore().set(preferenceValueAtom("rowActions"), []);
    renderThreadRow();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.getByRole("button", { name: "Thread actions" })).toBeTruthy();
    expect(
      document
        .querySelector("[data-sidebar-thread-trailing]")
        ?.contains(document.querySelector("[data-sidebar-row-controls]")),
    ).toBe(true);
  });

  it.each([
    [[]],
    [["bb--core/pin", "bb--core/copyLink", "bb--core/archive"]],
  ] as const)(
    "reserves one action for an archived row whatever the row actions (%j)",
    (rowActions) => {
      getDefaultStore().set(preferenceValueAtom("rowActions"), [...rowActions]);
      renderThreadRow({
        thread: createThread({ archivedAt: 1, isArchived: true }),
      });
      expect(screen.getByRole("button", { name: "Unarchive" })).toBeTruthy();
    },
  );

  it("starts the inline rename directly from a Rename row action", async () => {
    getDefaultStore().set(preferenceValueAtom("rowActions"), [
      "bb--core/rename",
    ]);
    renderThreadRow();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(
      await screen.findByRole("textbox", { name: "Thread name" }),
    ).toHaveProperty("value", "Thread");
  });

  it.each(["dropdown", "context"] as const)(
    "adds Customize row actions to the %s menu",
    async (surface) => {
      const customize = vi.fn();
      renderThreadRow({ onCustomizeRowActions: customize });
      if (surface === "dropdown") {
        fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
      } else {
        fireEvent.contextMenu(
          screen.getByRole("link", { name: "Open Thread" }),
        );
      }
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Customize row actions" }),
      );
      expect(customize).toHaveBeenCalledWith("thr_test");
    },
  );

  it("leaves Customize row actions out when the list cannot customize", async () => {
    renderThreadRow();
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    await screen.findByRole("menuitem", { name: "Rename" });
    expect(
      screen.queryByRole("menuitem", { name: "Customize row actions" }),
    ).toBeNull();
  });

  it("customizes row actions on the real row until Done", () => {
    const finish = vi.fn();
    renderThreadRow({ onFinishCustomizingRowActions: finish });
    expect(screen.getByRole("link", { name: "Open Thread" })).toBeTruthy();
    expect(
      document
        .querySelector("[data-sidebar-thread-trailing]")
        ?.classList.contains("hidden"),
    ).toBe(true);
    expect(screen.getByRole("group", { name: "Row actions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(finish).toHaveBeenCalledWith(true);
  });

  it.each(["dropdown", "context"] as const)(
    "starts an inline rename once the %s menu has closed",
    async (surface) => {
      renderThreadRow();
      if (surface === "dropdown") {
        fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
      } else {
        fireEvent.contextMenu(
          screen.getByRole("link", { name: "Open Thread" }),
        );
      }
      fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
      const input = await screen.findByRole("textbox", { name: "Thread name" });
      expect(input).toHaveProperty("value", "Thread");
    },
  );

  it.each([
    { name: "desktop", isCompactViewport: false },
    { name: "compact", isCompactViewport: true },
  ])(
    "opens the row's context menu from a status chip of a sticky parent on $name",
    async ({ isCompactViewport }) => {
      renderThreadRow({
        thread: createThread({
          experimental_rowState: {
            statuses: { task: { value: "Running" } },
            progress: null,
          },
        }),
        isCompactViewport,
        options: {
          kind: "parent",
          depth: 1,
          isCompact: isCompactViewport,
          isCollapsed: false,
          childCount: 1,
          childActivity: NO_COLLAPSED_CHILD_ACTIVITY,
          stickyLevel: 0,
          onToggleCollapsed: vi.fn(),
        },
      });
      const chip = document.querySelector("[data-sidebar-thread-status-chip]");
      if (chip === null) throw new Error("status chip missing");
      fireEvent.contextMenu(chip);

      expect(
        await screen.findByRole("menuitem", { name: "Rename" }),
      ).toBeTruthy();
    },
  );

  it("keeps a sticky parent's row state inside the row node that carries the drag and drop bindings", () => {
    renderThreadRow({
      thread: createThread({
        experimental_rowState: {
          statuses: { task: { value: "Running" } },
          progress: { value: 0.5 },
        },
      }),
      options: {
        kind: "parent",
        depth: 1,
        isCompact: false,
        isCollapsed: false,
        childCount: 1,
        childActivity: NO_COLLAPSED_CHILD_ACTIVITY,
        stickyLevel: 0,
        onToggleCollapsed: vi.fn(),
      },
    });

    const row = document.querySelector("[data-sidebar-rename-row]");
    const rowState = document.querySelector("[data-sidebar-thread-row-state]");
    expect(row?.contains(rowState ?? null)).toBe(true);
  });

  it.each(RENAME_PRESENTATION_CASES)(
    "presents rename from the menu, a row action, and double click for compact=$compact coarse=$coarse",
    async ({ compact, coarse, menu, direct, doubleClick }) => {
      pointerState.coarse = coarse;
      getDefaultStore().set(preferenceValueAtom("rowActions"), [
        "bb--core/rename",
      ]);
      renderThreadRow({ isCompactViewport: compact });
      fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
      await expectRenamePresentation(menu);
      if (compact) {
        expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
      } else {
        fireEvent.click(screen.getByRole("button", { name: "Rename" }));
        await expectRenamePresentation(direct);
      }
      fireEvent.doubleClick(screen.getByText("Thread"));
      await expectRenamePresentation(doubleClick);
    },
  );

  it("suppresses the context menu while the title is being edited", async () => {
    renderThreadRow();
    fireEvent.doubleClick(screen.getByText("Thread"));
    await screen.findByRole("textbox", { name: "Thread name" });
    expect(
      screen
        .getByTestId("bb-thread-actions-context-menu")
        .getAttribute("data-disabled"),
    ).toBe("true");
  });

  const splitWorkingCases: Array<{
    label: string;
    pluginStatus?: PluginSidebarThreadRowStatus;
    thread: PluginSidebarThread;
  }> = [
    {
      label: "runtime + pending input",
      thread: createThread({
        status: "active",
        runtimeStatus: "active",
        hasPendingInteraction: true,
      }),
    },
    {
      label: "workflow + pending input",
      thread: createThread({
        hasPendingInteraction: true,
        activity: activity({ workflows: 1 }),
      }),
    },
    {
      label: "background agent + unread error",
      thread: createThread({
        status: "error",
        activity: activity({ backgroundAgents: 1 }),
      }),
    },
    {
      label: "background command + pending input",
      thread: createThread({
        hasPendingInteraction: true,
        activity: activity({ backgroundCommands: 1 }),
      }),
    },
    {
      label: "plan mode + unread error",
      thread: createThread({
        status: "error",
        activity: activity({ planMode: 1 }),
      }),
    },
    {
      label: "goal + pending input",
      thread: createThread({
        hasPendingInteraction: true,
        activity: activity({ goals: 1 }),
      }),
    },
    {
      label: "plugin running + unread error",
      pluginStatus: {
        icon: "AiContentGenerator01",
        label: "Plugin running",
        tone: "running",
      },
      thread: createThread({ status: "error" }),
    },
  ];

  it.each(splitWorkingCases)(
    "shimmers the split map for $label",
    ({ pluginStatus, thread }) => {
      const { container } = renderSplitThreadRow({ pluginStatus, thread });

      const splitMap = screen.getByRole("img", { name: /open in split/ });
      expect(Array.from(splitMap.classList)).toContain("animate-shine-icon");
      expect(
        splitMap.closest("[data-sidebar-thread-trailing-indicator]"),
      ).not.toBeNull();
      expect(container.querySelector("[data-thread-status-glyph]")).toBeNull();
    },
  );

  it.each([
    ["idle", createThread()],
    ["unread error only", createThread({ status: "error" })],
  ])("keeps the split map static for %s", (_label, thread) => {
    renderSplitThreadRow({ thread });

    const splitMap = screen.getByRole("img", { name: /open in split/ });
    expect(Array.from(splitMap.classList)).not.toContain("animate-shine-icon");
  });

  it("marks the row as open in a split and omits the map when the thread is in no pane", () => {
    const { container, unmount } = renderSplitThreadRow();
    expect(
      container.querySelector(".bb-sidebar-open-in-split-row"),
    ).not.toBeNull();
    unmount();

    const other = renderThreadRow({ splitLayout: twoPaneLayout("thr_other") });
    expect(screen.queryByRole("img", { name: /open in split/ })).toBeNull();
    expect(
      other.container.querySelector(".bb-sidebar-open-in-split-row"),
    ).toBeNull();
  });

  it.each([
    {
      label: "pending input",
      expectedStatus: "Needs input",
      thread: createThread({ hasPendingInteraction: true }),
    },
    {
      label: "unread error",
      expectedStatus: "Done",
      thread: createThread({ status: "error" }),
    },
    {
      label: "plugin status",
      expectedStatus: "Plugin improving draft",
      pluginStatus: {
        icon: "AiContentGenerator01" as const,
        label: "Plugin improving draft",
      },
      thread: createThread(),
    },
    {
      label: "collapsed child workflow",
      expectedStatus: "Working",
      options: {
        kind: "parent" as const,
        depth: 1,
        isCompact: false,
        isCollapsed: true,
        childCount: 1,
        childActivity: {
          ...NO_COLLAPSED_CHILD_ACTIVITY,
          workflow: true,
        },
        onToggleCollapsed: vi.fn(),
      },
      thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
    },
  ])(
    "preserves the $label status in the split map accessible name",
    ({ expectedStatus, options, pluginStatus, thread }) => {
      renderSplitThreadRow({ options, pluginStatus, thread });

      expect(
        screen
          .getByRole("img", { name: /open in split/ })
          .getAttribute("aria-label"),
      ).toBe(`Thread — open in split; ${expectedStatus}`);
    },
  );

  it("puts the draft glyph in the trailing status slot", () => {
    renderThreadRow({
      hasComposerDraft: true,
      thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
    });

    const draftGlyph = statusGlyph();
    expect(draftGlyph.getAttribute("data-thread-status-glyph")).toBe("draft");
    expect(draftGlyph.hasAttribute("data-hide-idle-draft-label")).toBe(true);
    expect(
      draftGlyph.closest("[data-sidebar-thread-trailing-indicator]"),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Open Thread (unsubmitted draft)" }),
    ).not.toBeNull();
  });

  it("passes a plugin status over the draft glyph and drops it without one", () => {
    const withStatus = renderThreadRow({
      hasComposerDraft: true,
      pluginStatus: {
        icon: "AiContentGenerator01",
        label: "Plugin improving draft",
      },
      thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
    });

    expect(statusGlyph().getAttribute("data-thread-status-glyph")).toBe(
      "draft",
    );
    expect(statusGlyph().getAttribute("data-row-status")).toBe(
      "Plugin improving draft",
    );
    withStatus.unmount();

    renderThreadRow({
      hasComposerDraft: true,
      thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
    });
    expect(statusGlyph().getAttribute("data-thread-status-glyph")).toBe(
      "draft",
    );
    expect(statusGlyph().hasAttribute("data-row-status")).toBe(false);
  });

  it("keeps a plugin status alongside a keyboard shortcut", () => {
    renderThreadRow({
      pluginStatus: {
        icon: "AiContentGenerator01",
        label: "Plugin improving draft",
      },
      shortcutKey: "3",
    });

    expect(screen.getByText("⌘3")).not.toBeNull();
    expect(statusGlyph().getAttribute("data-row-status")).toBe(
      "Plugin improving draft",
    );
  });

  it("keeps a split mini-map alongside a keyboard shortcut", () => {
    renderSplitThreadRow({ shortcutKey: "3" });

    expect(screen.getByText("⌘3")).not.toBeNull();
    expect(screen.getByRole("img", { name: /open in split/ })).not.toBeNull();
  });

  it("passes the plugin status tone through to the status glyph", () => {
    renderThreadRow({
      hasComposerDraft: true,
      pluginStatus: {
        icon: "AiContentGenerator01",
        label: "Plugin improving draft",
        tone: "success",
      },
    });

    expect(statusGlyph().getAttribute("data-row-status")).toBe(
      "Plugin improving draft",
    );
    expect(statusGlyph().getAttribute("data-row-status-tone")).toBe("success");
  });

  it("keeps the runtime indicator ahead of a plugin status", () => {
    renderThreadRow({
      pluginStatus: {
        icon: "AiContentGenerator01",
        label: "Plugin improving draft",
      },
      thread: createThread({ status: "active", runtimeStatus: "active" }),
    });

    expect(renderedIndicators()).toEqual(["working"]);
    expect(
      statusGlyph().closest("[data-sidebar-thread-trailing-indicator]"),
    ).not.toBeNull();
  });

  it.each([true, false] as const)(
    "keeps the working-draft indicator ahead of the runtime indicator when isActive=%s",
    (isActive) => {
      renderThreadRow({
        hasComposerDraft: true,
        isActive,
        thread: createThread({ status: "active", runtimeStatus: "active" }),
      });

      expect(renderedIndicators()).toEqual(["working"]);
    },
  );

  it("renders the host title component and labels the row with the resolved display title", () => {
    const { container } = renderThreadRow({
      thread: createThread({
        title: "Compare @thread:thr_mentioned in @project:proj_mentioned",
        titleFallback:
          "Compare @thread:thr_mentioned in @project:proj_mentioned",
        displayTitle: "Compare Mention target in Mention project",
      }),
    });

    expect(
      container.querySelector('[data-thread-title="thr_test"]')?.textContent,
    ).toBe("Compare Mention target in Mention project");
    expect(
      screen.getByRole("link", {
        name: "Open Compare Mention target in Mention project",
      }),
    ).not.toBeNull();
    expect(
      screen.getByTitle("Compare Mention target in Mention project"),
    ).not.toBeNull();
    expect(screen.queryByText(/@thread:thr_mentioned/)).toBeNull();
  });

  it("marks a child from another project with the project name", () => {
    const { container } = renderThreadRow({
      crossProjectId: "proj_other",
      projects: [
        {
          id: "proj_other",
          name: "Web App",
          isPersonal: false,
          href: "/projects/proj_other",
          settingsHref: "/projects/proj_other/settings",
        },
      ],
      thread: createThread({
        parentThreadId: "thr_parent",
        projectId: "proj_other",
      }),
    });

    const marker = container.querySelector(
      "[data-sidebar-thread-cross-project]",
    );
    expect(marker?.getAttribute("aria-label")).toBe("In project Web App");
    expect(marker?.querySelector('[data-icon="FolderExport"]')).not.toBeNull();
    expect(
      marker?.parentElement?.querySelector(".bb-thread-title"),
    ).not.toBeNull();
    expect(
      marker?.closest("[data-sidebar-thread-trailing-indicator]"),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open Thread" }).getAttribute("href"),
    ).toBe("/projects/proj_other/threads/thr_test");
  });

  it("falls back to a generic label when the other project is unknown", () => {
    const { container } = renderThreadRow({
      crossProjectId: "proj_unknown",
      thread: createThread({
        parentThreadId: "thr_parent",
        projectId: "proj_unknown",
      }),
    });

    expect(
      container
        .querySelector("[data-sidebar-thread-cross-project]")
        ?.getAttribute("aria-label"),
    ).toBe("In another project");
  });

  it("opens the thread when the cross-project marker is clicked", () => {
    const { container } = renderThreadRow({
      crossProjectId: "proj_other",
      thread: createThread({
        parentThreadId: "thr_parent",
        projectId: "proj_other",
      }),
    });
    const link = screen.getByRole("link", { name: "Open Thread" });
    const onLinkClick = vi.fn();
    link.addEventListener("click", onLinkClick);

    fireEvent.click(
      container.querySelector("[data-sidebar-thread-cross-project]")!,
    );

    expect(onLinkClick).toHaveBeenCalledTimes(1);
  });

  it("omits the cross-project marker for same-project rows", () => {
    const { container } = renderThreadRow({});
    expect(
      container.querySelector("[data-sidebar-thread-cross-project]"),
    ).toBeNull();
  });

  it("shows a plain terminal signal with its own label", () => {
    renderThreadRow({
      thread: createThread({
        indicator: "check-terminal",
        hasPendingInteraction: false,
      }),
    });
    expect(renderedIndicators()).toEqual(["check-terminal"]);
    expect(screen.getByRole("img", { name: "Check terminal" })).toBeTruthy();
    expect(screen.getByText("Check terminal")).toBeTruthy();
    expect(screen.queryByText("Needs input")).toBeNull();
  });

  it.each([false, true])("shows a collapsed child's signal, with real questions first: %s", (withQuestion) => {
    const children = [createThread({ id: "signal", indicator: "check-terminal", hasPendingInteraction: false })];
    if (withQuestion) children.push(createThread({ id: "question", hasPendingInteraction: true }));
    renderThreadRow({ thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }), options: { kind: "parent", depth: 1, isCompact: false, isCollapsed: true, childCount: children.length, childActivity: getCollapsedChildActivity(children), onToggleCollapsed: vi.fn() } });
    expect(renderedIndicators()).toEqual([withQuestion ? "needs-input" : "check-terminal"]);
    expect(screen.getByRole("img", { name: withQuestion ? "Needs input" : "Check terminal" })).toBeTruthy();
  });

  it("shows the needs-input indicator when the thread needs user input", () => {
    renderThreadRow({
      thread: createThread({ hasPendingInteraction: true }),
    });

    expect(renderedIndicators()).toEqual(["needs-input"]);
    expect(
      screen
        .getByRole("img", { name: "Needs input" })
        .classList.contains("text-destructive-text"),
    ).toBe(true);
    expect(
      screen
        .getByRole("img", { name: "Needs input" })
        .classList.contains("text-warning"),
    ).toBe(false);
  });

  it("clocks a thread with queued work, and drops the clock once it runs", () => {
    const { container, rerenderThreadRow } = renderThreadRow({
      thread: createThread({
        lastReadAt: 1,
        latestAttentionAt: 1,
        queuedWork: "waiting",
      }),
    });

    expect(renderedIndicators()).toEqual(["queued-waiting"]);

    rerenderThreadRow(
      createThread({
        lastReadAt: 1,
        latestAttentionAt: 1,
        queuedWork: "waiting",
        runtimeStatus: "active",
      }),
    );
    expect(renderedIndicators()).toEqual(["working"]);
  });

  it("shows unread success instead of queued work", () => {
    renderThreadRow({
      thread: createThread({
        status: "idle",
        lastReadAt: 1_000,
        latestAttentionAt: 2_000,
        queuedWork: "waiting",
      }),
    });

    expect(renderedIndicators()).toEqual(["done-unread"]);
  });

  it("keeps queue failure separate from an unread completed turn", () => {
    renderThreadRow({
      thread: createThread({
        lastReadAt: 1,
        latestAttentionAt: 1,
        queuedWork: "failed",
      }),
    });
    expect(renderedIndicators()).toEqual(["queued-failed"]);

    cleanup();
    renderThreadRow({
      thread: createThread({
        status: "error",
        lastReadAt: 0,
        latestAttentionAt: 10,
      }),
    });
    expect(renderedIndicators()).toEqual(["done-unread"]);
  });

  it.each([true, false])(
    "reserves quick-action space after parent disclosure (collapsed: %s)",
    (isCollapsed) => {
      const onToggleCollapsed = vi.fn();
      renderThreadRow({
        thread: createThread({
          title: "Nested discussion with enough text to fill the sidebar width",
          displayTitle:
            "Nested discussion with enough text to fill the sidebar width",
        }),
        options: {
          kind: "parent",
          depth: 1,
          isCompact: false,
          isCollapsed,
          childCount: 1,
          childActivity: NO_COLLAPSED_CHILD_ACTIVITY,
          onToggleCollapsed,
        },
      });
      const toggle = screen.getByRole("button", {
        name: /(?:Expand|Collapse) Nested discussion/,
      });
      const link = screen.getByRole("link", {
        name: "Open Nested discussion with enough text to fill the sidebar width",
      });
      const titleContainer = link.parentElement;
      const navigationTarget = link.parentElement;
      const titleWrapper = link.nextElementSibling?.firstElementChild;
      expect(titleContainer?.classList.contains("flex-1")).toBe(true);
      expect(titleContainer?.classList.contains("min-w-0")).toBe(true);
      expect(navigationTarget?.classList.contains("flex-1")).toBe(true);
      expect(titleWrapper?.classList.contains("flex-1")).toBe(true);
      expect(
        link.parentElement?.classList.contains(
          "pr-(--bb-sidebar-hover-actions-inset)",
        ),
      ).toBe(true);
      const row = link.closest("[data-sidebar-rename-row]");
      expect(
        Array.from(row?.querySelectorAll("button") ?? [], (button) =>
          button.getAttribute("aria-label"),
        ),
      ).toEqual([
        toggle.getAttribute("aria-label"),
        "Archive",
        "Thread actions",
      ]);
      fireEvent.click(toggle);
      expect(onToggleCollapsed).toHaveBeenCalledWith("thr_test");
    },
  );

  it("routes a tap on the bare row through its navigation link", () => {
    renderThreadRow();
    const link = screen.getByRole("link", { name: "Open Thread" });
    const row = link.closest("[data-sidebar-rename-row]");
    expect(row).not.toBeNull();
    const clickLink = vi.spyOn(link, "click");

    fireEvent.click(row!);
    expect(clickLink).toHaveBeenCalledOnce();

    fireEvent.click(row!.querySelector("[data-sidebar-thread-trailing]")!);
    expect(clickLink).toHaveBeenCalledTimes(2);

    fireEvent.click(link);
    expect(clickLink).toHaveBeenCalledTimes(2);
  });

  it.each([
    { isCompact: false, metadata: false },
    { isCompact: true, metadata: false },
    { isCompact: false, metadata: true },
    { isCompact: true, metadata: true },
  ])("keeps phone touch rows at least 44 px (compact: $isCompact, metadata: $metadata)", ({ isCompact, metadata }) => {
    getDefaultStore().set(sidebarShowRowMetadataAtom, metadata);
    renderThreadRow({
      experiments: ["threadRowMetadata"],
      options: { ...DEFAULT_OPTIONS, isCompact },
    });
    const row = screen.getByRole("link", { name: "Open Thread" }).closest<HTMLElement>("[data-sidebar-rename-row]")!;
    expect(row.classList.contains("max-md:pointer-coarse:min-h-11")).toBe(true);
    expect(row.classList.contains("md:h-(--bb-sidebar-desktop-row-height)")).toBe(true);
    expect(row.classList.contains("[--bb-sidebar-desktop-row-height:2.5rem]")).toBe(true);
    expect(row.classList.contains("min-h-11")).toBe(false);
  });

  it("draws other plugins' metadata only while Metadata is on", () => {
    const slot = renderThreadRow({ experiments: ["threadRowMetadata"] });
    expect(
      slot.container.querySelector("[data-thread-row-metadata]"),
    ).toBeNull();

    act(() => getDefaultStore().set(sidebarShowRowMetadataAtom, true));
    expect(
      slot.container.querySelector("[data-thread-row-metadata]"),
    ).not.toBeNull();
  });

  it.skipIf(!sdkExportsAreSpyable).each([false, true])(
    "keeps empty metadata rows dense (compact: %s)",
    (isCompact) => {
      vi.spyOn(
        pluginSdk,
        "experimental_ThreadRowMetadata",
        "get",
      ).mockReturnValue(() => <span data-thread-row-metadata="" />);
      getDefaultStore().set(sidebarShowRowMetadataAtom, true);
      const slot = renderThreadRow({
        experiments: ["threadRowMetadata"],
        options: { ...DEFAULT_OPTIONS, isCompact },
      });
      const link = screen.getByRole("link", { name: "Open Thread" });
      const content = link.parentElement!;
      const reservation = content.lastElementChild!;
      expect(content.classList.contains("py-1.25")).toBe(false);
      expect(content.classList.contains("[&_.bb-thread-title]:leading-4")).toBe(
        false,
      );
      expect(reservation.classList.contains("flex")).toBe(false);
      expect(reservation.classList.contains("hidden")).toBe(true);
      expect(
        reservation.classList.contains("has-[[data-reserve-line]]:flex"),
      ).toBe(true);
      slot.unmount();
    },
  );

  it.skipIf(!sdkExportsAreSpyable).each([false, true])(
    "reserves stable row metrics across late metadata registration (compact: %s)",
    (isCompact) => {
      let registered = false;
      vi.spyOn(
        pluginSdk,
        "experimental_ThreadRowMetadata",
        "get",
      ).mockReturnValue(() => (
        <span data-thread-row-metadata="" data-reserve-line="">
          {registered ? (
            <span className="text-xs leading-3.5">#10843</span>
          ) : null}
        </span>
      ));
      getDefaultStore().set(sidebarShowRowMetadataAtom, true);
      const thread = createThread();
      const slot = renderThreadRow({
        thread,
        experiments: ["threadRowMetadata"],
        options: { ...DEFAULT_OPTIONS, isCompact },
      });
      const link = screen.getByRole("link", { name: "Open Thread" });
      const row = link.closest<HTMLElement>("[data-sidebar-rename-row]")!;
      const content = link.parentElement!;
      const title = row.querySelector(".bb-thread-title")!;
      const reservation = content.lastElementChild!;
      const before = [
        row.className,
        content.className,
        title.className,
        reservation.className,
      ];
      expect(
        content.classList.contains("has-[[data-reserve-line]]:py-1.25"),
      ).toBe(true);
      expect(
        content.classList.contains(
          "has-[[data-reserve-line]]:[&_.bb-thread-title]:leading-4",
        ),
      ).toBe(true);
      expect(content.className).not.toContain("data-has-items");
      expect(reservation.classList.contains("basis-full")).toBe(true);
      expect(reservation.classList.contains("h-3.5")).toBe(true);
      expect(reservation.classList.contains("shrink-0")).toBe(true);
      expect(reservation.classList.contains("overflow-hidden")).toBe(true);
      expect(reservation.textContent).toBe("");
      expect(row.className).toContain("max-md:pointer-coarse:min-h-11");

      registered = true;
      slot.rerenderThreadRow({ ...thread });
      expect(reservation.querySelector("[data-reserve-line]")).not.toBeNull();
      expect(content.lastElementChild).toBe(reservation);
      expect([
        row.className,
        content.className,
        title.className,
        reservation.className,
      ]).toEqual(before);
      const clickLink = vi.spyOn(link, "click");
      fireEvent.click(row);
      expect(clickLink).toHaveBeenCalledOnce();

      registered = false;
      slot.rerenderThreadRow({ ...thread });
      expect(reservation.textContent).toBe("");
      expect([
        row.className,
        content.className,
        title.className,
        reservation.className,
      ]).toEqual(before);

      act(() => getDefaultStore().set(sidebarShowRowMetadataAtom, false));
      expect(reservation.isConnected).toBe(false);
      expect(content.classList.contains("py-1.25")).toBe(false);
      expect(content.classList.contains("[&_.bb-thread-title]:leading-4")).toBe(
        false,
      );
      expect(row.className).toContain("md:h-(--bb-sidebar-desktop-row-height)");
      expect(row.classList.contains("max-md:pointer-coarse:min-h-11")).toBe(true);
    },
  );

  it("ignores the Metadata preference while its experiment is off", () => {
    getDefaultStore().set(sidebarShowRowMetadataAtom, true);
    const slot = renderThreadRow();
    expect(
      slot.container.querySelector("[data-thread-row-metadata]"),
    ).toBeNull();
  });

  it("routes a click on other plugins' metadata like the rest of the row", () => {
    getDefaultStore().set(sidebarShowRowMetadataAtom, true);
    const slot = renderThreadRow({
      experiments: ["sidebarMultiSelect", "threadRowMetadata"],
    });
    const link = screen.getByRole("link", { name: "Open Thread" });
    const row = link.closest("[data-sidebar-rename-row]");
    const items = row?.querySelector("[data-thread-row-metadata]");
    expect(items).not.toBeNull();
    const clickLink = vi.spyOn(link, "click");

    fireEvent.click(items!, { metaKey: true, shiftKey: true });
    expect(row?.hasAttribute("data-sidebar-thread-selected")).toBe(true);
    expect(clickLink).not.toHaveBeenCalled();
    expect(slot.inspection.navigateCalls).toEqual([]);

    fireEvent.click(items!);
    expect(row?.hasAttribute("data-sidebar-thread-selected")).toBe(false);
    expect(clickLink).toHaveBeenCalledOnce();
  });

  it("does not route a suppressed drag click on the trailing area", () => {
    renderThreadRow({
      options: {
        ...DEFAULT_OPTIONS,
        consumeClickSuppression: vi.fn(() => true),
      },
    });
    const link = screen.getByRole("link", { name: "Open Thread" });
    const clickLink = vi.spyOn(link, "click");
    const trailing = link
      .closest("[data-sidebar-rename-row]")
      ?.querySelector("[data-sidebar-thread-trailing]");
    expect(trailing).not.toBeNull();

    fireEvent.click(trailing!);
    expect(clickLink).not.toHaveBeenCalled();
  });

  it("keeps the parent-thread disclosure caret visible on mobile", () => {
    renderThreadRow({
      thread: createThread({
        title: "Parent thread",
        displayTitle: "Parent thread",
      }),
      options: {
        kind: "parent",
        depth: 1,
        isCompact: false,
        isCollapsed: false,
        childCount: 1,
        childActivity: NO_COLLAPSED_CHILD_ACTIVITY,
        onToggleCollapsed: vi.fn(),
      },
    });

    expect(
      screen
        .getByRole("button", { name: "Collapse Parent thread threads" })
        .getAttribute("data-sidebar-hover-actions-mobile"),
    ).toBe("always");
  });

  it.each([
    { isCollapsed: true, expectedHoverReveal: false },
    { isCollapsed: false, expectedHoverReveal: true },
  ])(
    "sets parent-thread disclosure hover reveal to $expectedHoverReveal when collapsed is $isCollapsed",
    ({ expectedHoverReveal, isCollapsed }) => {
      renderThreadRow({
        thread: createThread({
          title: "Parent thread",
          displayTitle: "Parent thread",
        }),
        options: {
          kind: "parent",
          depth: 1,
          isCompact: false,
          isCollapsed,
          childCount: 1,
          childActivity: NO_COLLAPSED_CHILD_ACTIVITY,
          onToggleCollapsed: vi.fn(),
        },
      });

      const toggle = screen.getByRole("button", {
        name: `${isCollapsed ? "Expand" : "Collapse"} Parent thread threads`,
      });
      expect(toggle.classList.contains("bb-sidebar-hover-actions")).toBe(
        expectedHoverReveal,
      );
    },
  );

  it("renders a sticky parent tier with its guide line", () => {
    const { container } = renderThreadRow({
      options: {
        kind: "parent",
        depth: 2,
        isCompact: false,
        isCollapsed: false,
        childCount: 1,
        childActivity: NO_COLLAPSED_CHILD_ACTIVITY,
        stickyLevel: 1,
        onToggleCollapsed: vi.fn(),
      },
    });
    const tier = container.querySelector<HTMLElement>(
      '[data-sidebar-sticky-tier="parent"]',
    );
    expect(tier).not.toBeNull();
    expect(
      tier?.style.getPropertyValue("--bb-sidebar-sticky-parent-level"),
    ).toBe("1");
    expect(tier?.style.paddingLeft).toBe("36px");
    expect(tier?.querySelector('[aria-hidden="true"].w-px')).not.toBeNull();
    expect(
      tier?.querySelector<HTMLElement>('[aria-hidden="true"].w-px')?.style.left,
    ).toBe("30px");
  });

  it("keeps its active indicator and actions alongside a Command shortcut", () => {
    renderThreadRow({
      shortcutKey: "3",
      thread: createThread({ status: "active", runtimeStatus: "active" }),
    });

    const shortcut = screen.getByText("⌘3");
    expect(shortcut.className).toContain("px-1.5");
    expect(shortcut.className).toContain("py-1");
    expect(shortcut.className).toContain("opacity-60");
    expect(screen.getByRole("img", { name: "Working" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Archive" })).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Thread actions" }),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Open Thread" })
        .getAttribute("aria-keyshortcuts"),
    ).toBe("Meta+3");
  });

  it("shows runtime work before workflow and background work", () => {
    renderThreadRow({
      thread: createThread({
        activity: activity({
          workflows: 1,
          backgroundAgents: 1,
          backgroundCommands: 1,
        }),
        runtimeStatus: "active",
      }),
    });

    expect(renderedIndicators()).toEqual(["working"]);
  });

  it("shows the workflow indicator for an idle thread with an active workflow", () => {
    renderThreadRow({
      thread: createThread({
        activity: activity({ workflows: 1 }),
        lastReadAt: 1,
        latestAttentionAt: 1,
      }),
    });

    expect(renderedIndicators()).toEqual(["working"]);
  });

  it.each([
    { activityKey: "backgroundAgents" as const, indicator: "working" },
    { activityKey: "backgroundCommands" as const, indicator: "working" },
    { activityKey: "planMode" as const, indicator: "working" },
    { activityKey: "goals" as const, indicator: "working" },
  ])(
    "shows the $indicator indicator for $activityKey activity",
    ({ activityKey, indicator }) => {
      renderThreadRow({
        thread: createThread({
          activity: activity({ [activityKey]: 1 }),
          lastReadAt: 1,
          latestAttentionAt: 1,
        }),
      });

      expect(renderedIndicators()).toEqual([indicator]);
    },
  );

  it("shows workflow before background agent and command work", () => {
    renderThreadRow({
      thread: createThread({
        activity: activity({
          workflows: 1,
          backgroundAgents: 1,
          backgroundCommands: 1,
        }),
        lastReadAt: 1,
        latestAttentionAt: 1,
      }),
    });

    expect(renderedIndicators()).toEqual(["working"]);
  });

  it("folds background agent and command work into one working indicator", () => {
    renderThreadRow({
      thread: createThread({
        activity: activity({ backgroundAgents: 1, backgroundCommands: 1 }),
        lastReadAt: 1,
        latestAttentionAt: 1,
      }),
    });

    expect(renderedIndicators()).toEqual(["working"]);
  });

  it("shows fork working precedence over unread background work and workflows", () => {
    const background = renderThreadRow({
      thread: createThread({
        activity: activity({ backgroundAgents: 1, backgroundCommands: 1 }),
      }),
    });
    expect(renderedIndicators()).toEqual(["working"]);
    background.unmount();

    renderThreadRow({
      thread: createThread({
        activity: activity({ workflows: 1, backgroundCommands: 1 }),
      }),
    });
    expect(renderedIndicators()).toEqual(["working"]);
  });

  it.each([
    { flag: "workflow" as const, indicator: "working" },
    { flag: "backgroundAgent" as const, indicator: "working" },
    { flag: "backgroundCommand" as const, indicator: "working" },
    { flag: "planMode" as const, indicator: "working" },
    { flag: "goal" as const, indicator: "working" },
  ])(
    "shows the $indicator indicator for collapsed parent rows with hidden $flag activity",
    ({ flag, indicator }) => {
      renderThreadRow({
        thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
        options: {
          kind: "parent",
          depth: 1,
          isCompact: false,
          isCollapsed: true,
          childCount: 1,
          childActivity: {
            ...NO_COLLAPSED_CHILD_ACTIVITY,
            working: true,
            [flag]: true,
          },
          onToggleCollapsed: vi.fn(),
        },
      });

      expect(renderedIndicators()).toEqual([indicator]);
    },
  );

  it("shows a working draft for collapsed descendants before named work", () => {
    renderThreadRow({
      thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
      hiddenDraftThreadIds: ["thr_hidden_child"],
      options: {
        kind: "parent",
        depth: 1,
        isCompact: false,
        isCollapsed: true,
        childCount: 1,
        childActivity: {
          ...NO_COLLAPSED_CHILD_ACTIVITY,
          threadIds: ["thr_hidden_child"],
          working: true,
          planMode: true,
          goal: true,
        },
        onToggleCollapsed: vi.fn(),
      },
    });

    expect(renderedIndicators()).toEqual(["working"]);
  });

  it("ignores hidden child activity once the parent is expanded", () => {
    renderThreadRow({
      thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
      options: {
        kind: "parent",
        depth: 1,
        isCompact: false,
        isCollapsed: false,
        childCount: 1,
        childActivity: {
          ...NO_COLLAPSED_CHILD_ACTIVITY,
          working: true,
          workflow: true,
        },
        onToggleCollapsed: vi.fn(),
      },
    });

    expect(renderedIndicators()).toEqual([]);
  });

  it("shows unread success for an already-unread successful thread on initial load", () => {
    renderThreadRow({
      thread: createThread({
        status: "idle",
        lastReadAt: 1_000,
        latestAttentionAt: 2_000,
      }),
    });

    expect(renderedIndicators()).toEqual(["done-unread"]);
  });

  it("switches directly from working to unread success after finishing", () => {
    const thread = createThread({
      status: "active",
      runtimeStatus: "active",
      lastReadAt: 1_000,
      latestAttentionAt: 1_000,
    });
    const { rerenderThreadRow } = renderThreadRow({ thread });

    expect(renderedIndicators()).toEqual(["working"]);

    rerenderThreadRow({
      ...thread,
      status: "idle",
      runtimeStatus: "idle",
      latestAttentionAt: 2_000,
      isUnread: true,
    });

    expect(renderedIndicators()).toEqual(["done-unread"]);
  });

  it("edits the row title inline after a double click and commits on Enter", async () => {
    const slot = renderThreadRow({
      sdk: { threads: { update: vi.fn().mockResolvedValue({}) } },
    });

    fireEvent.doubleClick(screen.getByText("Thread"));
    const input = await screen.findByRole("textbox", { name: "Thread name" });
    expect(input).toHaveProperty("value", "Thread");

    fireEvent.change(input, { target: { value: "Renamed thread" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(slot.inspection.sdkCalls).toEqual([
        {
          method: "threads.update",
          args: [{ threadId: "thr_test", title: "Renamed thread" }],
        },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull();
    });
    expect(screen.getByText("Thread")).not.toBeNull();
  });

  it("renames inline after a fine-pointer double click on a compact viewport", async () => {
    renderThreadRow({ isCompactViewport: true });
    const link = screen.getByRole("link", { name: "Open Thread" });
    expect(fireEvent.click(link)).toBe(true);
    expect(fireEvent.click(link)).toBe(false);
    expect(
      await screen.findByRole("textbox", { name: "Thread name" }),
    ).toHaveProperty("value", "Thread");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not start a sortable drag while editing the title", async () => {
    const onPointerDown = vi.fn();
    renderThreadRow({
      options: {
        ...DEFAULT_OPTIONS,
        dragBindings: {
          attributes: {
            role: "button",
            tabIndex: 0,
            "aria-disabled": false,
            "aria-pressed": undefined,
            "aria-roledescription": "sortable",
            "aria-describedby": "thread-sortable",
          },
          disabled: false,
          isDragging: false,
          listeners: { onPointerDown },
          setActivatorNodeRef: vi.fn(),
        },
      },
    });

    fireEvent.doubleClick(screen.getByText("Thread"));
    fireEvent.pointerDown(
      await screen.findByRole("textbox", { name: "Thread name" }),
    );

    expect(onPointerDown).not.toHaveBeenCalled();
  });

  it("restores the row when a long press opens its menu and still allows deliberate dragging", async () => {
    const onDragStart = vi.fn();
    const thread = createThread();
    function DraggableThread() {
      const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: thread.id,
      });
      return (
        <ThreadRowHarness
          thread={thread}
          options={{
            ...DEFAULT_OPTIONS,
            dragBindings: {
              attributes,
              listeners,
              setActivatorNodeRef: setNodeRef,
              isDragging,
              disabled: false,
            },
          }}
        />
      );
    }
    function Harness() {
      const { dndContextProps } = useSidebarReorderDnd({
        onDragStart,
        onDragEnd: vi.fn(),
        touchSensor: SidebarTouchSensor,
      });
      return (
        <CompactViewportOverrideProvider isCompactViewport>
          <DndContext {...dndContextProps}>
            <DraggableThread />
          </DndContext>
        </CompactViewportOverrideProvider>
      );
    }
    const slot = renderSlot(
      { component: Harness },
      {},
      {
        sidebarThreads: { threads: [thread], projects: [] },
      },
    );
    const link = screen.getByRole("link", { name: "Open Thread" });
    expect(link).toHaveProperty("draggable", false);
    fireEvent.pointerDown(link, {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.touchStart(link, { touches: [{ clientX: 10, clientY: 10 }] });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 550)));
    expect(
      slot.container.querySelector("[data-sidebar-touch-armed=true]"),
    ).not.toBeNull();
    fireEvent.contextMenu(link);
    expect(await screen.findByRole("menu")).not.toBeNull();
    expect(
      slot.container.querySelector("[data-sidebar-touch-armed-chip]"),
    ).toBeNull();
    expect(onDragStart).not.toHaveBeenCalled();
    fireEvent.touchMove(link, { touches: [{ clientX: 26, clientY: 10 }] });
    await waitFor(() => expect(onDragStart).toHaveBeenCalledTimes(1));
    expect(
      screen
        .getByTestId("bb-thread-actions-context-menu")
        .getAttribute("data-dragging"),
    ).toBe("true");
    fireEvent.touchEnd(link, { touches: [] });
  });

  it("starts touch reordering from the thread row", () => {
    const onTouchStart = vi.fn();
    renderThreadRow({
      options: {
        ...DEFAULT_OPTIONS,
        dragBindings: {
          attributes: {
            role: "button",
            tabIndex: 0,
            "aria-disabled": false,
            "aria-pressed": undefined,
            "aria-roledescription": "sortable",
            "aria-describedby": "thread-sortable",
          },
          disabled: false,
          isDragging: false,
          listeners: { onTouchStart },
          setActivatorNodeRef: vi.fn(),
        },
      },
    });

    fireEvent.touchStart(screen.getByRole("link", { name: "Open Thread" }));
    expect(onTouchStart).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Reorder Thread" })).toBeNull();
  });

  it("suppresses the click that follows a drag and drops the suppression afterwards", () => {
    const consumeClickSuppression = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const slot = renderThreadRow({
      options: { ...DEFAULT_OPTIONS, consumeClickSuppression },
      experiments: ["sidebarMultiSelect"],
    });
    const link = screen.getByRole("link", { name: "Open Thread" });

    const row = link.closest("[data-sidebar-rename-row]");

    expect(fireEvent.click(link)).toBe(false);
    expect(row?.hasAttribute("data-sidebar-thread-selected")).toBe(false);
    expect(fireEvent.click(link, { metaKey: true, shiftKey: true })).toBe(
      false,
    );
    expect(consumeClickSuppression).toHaveBeenCalledTimes(2);
    expect(row?.hasAttribute("data-sidebar-thread-selected")).toBe(true);
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("starts a rename from a second click after the row remounts", async () => {
    const thread = createThread();
    const { rerenderThreadRow } = renderThreadRow({ thread });
    const link = screen.getByRole("link", { name: "Open Thread" });

    fireEvent.click(link);
    rerenderThreadRow(thread);
    fireEvent.click(screen.getByRole("link", { name: "Open Thread" }));

    expect(
      await screen.findByRole("textbox", { name: "Thread name" }),
    ).toHaveProperty("value", "Thread");
  });
});

const execFileAsync = promisify(execFile);

const chromiumPath = inject("threadListChromiumPath");
const pluginCss = inject("threadListPluginCss");
const CHROMIUM_QUIET_FLAGS = [
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--disable-background-networking",
  "--no-first-run",
];

interface RowLayout {
  innerWidth: number;
  title: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
  };
  metadata: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
    visible: boolean;
    text: string;
  };
  branch: { width: number } | null;
  mode: { left: number; right: number; width: number };
  context: { textLeft: number; glyphWidth: number } | null;
  row: {
    width: number;
    height: number;
    bottom: number;
    left: number;
    right: number;
  };
  link: { width: number };
  statusGlyph: { kind: string | null; width: number; height: number; visible: boolean } | null;
  chip: { width: number; left: number; right: number } | null;
  bar: {
    width: number;
    height: number;
    bottom: number;
    fill: number;
    fillBackground: string;
  } | null;
}

const MEASURE_SCRIPT = `
const box = (element) => {
  const rect = element.getBoundingClientRect();
  return {
    width: rect.width,
    height: rect.height,
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left,
    right: rect.right,
  };
};
const bar = document.querySelector("[role=progressbar]");
const chip = document.querySelector("[data-sidebar-thread-status-chip]");
const glyph = document.querySelector("[data-thread-status-glyph]");
const statusSlot = document.querySelector("[data-sidebar-thread-trailing-indicator]");
const context = document.querySelector("[data-sidebar-thread-context]");
const visible = (element) => {
  for (let node = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  }
  return true;
};
const layout = {
  innerWidth: window.innerWidth,
  title: box(document.querySelector(".bb-thread-title > span:last-child")),
  metadata: { ...box(context), visible: visible(context), text: context.textContent },
  branch: document.querySelector("[data-thread-row-branch]") ? box(document.querySelector("[data-thread-row-branch]")) : null,
  mode: (document.querySelector("[data-sidebar-thread-leading]") ? box(document.querySelector("[data-sidebar-thread-leading]")) : {width:0}),
  context: context && context.firstElementChild ? {
    textLeft: box(context.firstElementChild).left,
    glyphWidth: (document.querySelector("[data-sidebar-thread-leading]") ? box(document.querySelector("[data-sidebar-thread-leading]")) : {width:0}).width,
  } : null,
  row: box(document.querySelector("[data-sidebar-rename-row]")),
  link: box(document.querySelector("[data-sidebar-thread-id]")),
  statusGlyph: glyph && statusSlot ? { ...box(statusSlot), kind: glyph.getAttribute("data-thread-status-glyph"), visible: visible(glyph) } : null,
  chip: chip ? box(chip) : null,
  bar: bar
    ? {
        ...box(bar),
        fill: box(bar.firstElementChild).width,
        fillBackground: getComputedStyle(bar.firstElementChild).backgroundColor,
      }
    : null,
};
document.getElementById("layout").textContent = JSON.stringify(layout);
`;

async function measureRowLayout(
  rowHtml: string,
  viewportWidth: number,
  sidebarWidth = viewportWidth,
): Promise<RowLayout> {
  const dir = await mkdtemp(join(tmpdir(), "bb-row-layout-"));
  try {
    const page = join(dir, "row.html");
    const themeCss = await readFile(
      join(process.cwd(), "../../apps/app/src/components/ui/theme.css"),
      "utf8",
    );
    await writeFile(
      page,
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
:root{--bb-sidebar-row-height:1.75rem;--bb-sidebar-row-height-coarse:2.5rem;--sidebar-accent:#e4e4e7;--timeline-accent:#2563eb}
*,::before,::after{box-sizing:border-box}
body{margin:0}
${pluginCss ?? ""}
${themeCss}
</style></head><body>
<div data-bb-plugin-root style="width:${sidebarWidth}px">${rowHtml}</div>
<pre id="layout"></pre>
<script>addEventListener("load", () => setTimeout(() => {${MEASURE_SCRIPT}}, 50));</script>
</body></html>`,
    );
    const { stdout } = await execFileAsync(chromiumPath ?? "", [
      "--headless",
      `--user-data-dir=${join(dir, "profile")}`,
      "--no-sandbox",
      "--disable-gpu",
      ...CHROMIUM_QUIET_FLAGS,
      "--hide-scrollbars",
      `--window-size=${viewportWidth},900`,
      "--virtual-time-budget=2000",
      "--dump-dom",
      `file://${page}`,
    ]);
    const match = /<pre id="layout">([^<]*)<\/pre>/.exec(stdout);
    if (match?.[1] === undefined) throw new Error(stdout.slice(0, 500));
    return JSON.parse(match[1].replaceAll("&quot;", '"')) as RowLayout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface StickyParentLayout {
  tier: { top: number; bottom: number; height: number };
  rowState: { top: number; bottom: number };
  next: { top: number };
  rowStateHitsRow: boolean;
}

const STICKY_MEASURE_SCRIPT = `
const box = (element) => {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, height: rect.height };
};
const rowStateElement = document.querySelector("[data-sidebar-thread-row-state]");
const rowStateBox = rowStateElement.getBoundingClientRect();
const hit = document.elementFromPoint(
  rowStateBox.left + rowStateBox.width / 2,
  rowStateBox.top + rowStateBox.height / 2,
);
document.getElementById("layout").textContent = JSON.stringify({
  tier: box(document.querySelector("[data-sidebar-sticky-tier]")),
  rowState: box(rowStateElement),
  next: box(document.getElementById("next-row")),
  rowStateHitsRow: hit !== null && hit.closest("[data-sidebar-rename-row]") !== null,
});
`;

async function measureStickyParentLayout(
  rowHtml: string,
  viewportWidth: number,
): Promise<StickyParentLayout> {
  const dir = await mkdtemp(join(tmpdir(), "bb-sticky-layout-"));
  try {
    const page = join(dir, "sticky.html");
    const themeCss = await readFile(
      join(process.cwd(), "../../apps/app/src/components/ui/theme.css"),
      "utf8",
    );
    await writeFile(
      page,
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
@layer theme, base, components, utilities;
:root{--bb-sidebar-row-height:1.75rem;--bb-sidebar-row-height-coarse:2.5rem;--sidebar:#fafafa;--sidebar-accent:#e4e4e7;--timeline-accent:#2563eb}
*,::before,::after{box-sizing:border-box}
body{margin:0}
${pluginCss ?? ""}
${themeCss}
[data-sidebar-sticky-stack] [data-sidebar-sticky-tier]{top:auto}
</style></head><body>
<div data-bb-plugin-root style="width:${viewportWidth}px">
<div data-sidebar-sticky-stack>${rowHtml}<div id="next-row" style="height:1.75rem">Next row</div></div>
</div>
<pre id="layout"></pre>
<script>${STICKY_MEASURE_SCRIPT}</script>
</body></html>`,
    );
    const { stdout } = await execFileAsync(chromiumPath ?? "", [
      "--headless",
      `--user-data-dir=${join(dir, "profile")}`,
      "--no-sandbox",
      "--disable-gpu",
      ...CHROMIUM_QUIET_FLAGS,
      "--hide-scrollbars",
      `--window-size=${viewportWidth},900`,
      "--virtual-time-budget=2000",
      "--dump-dom",
      `file://${page}`,
    ]);
    const match = /<pre id="layout">([^<]*)<\/pre>/.exec(stdout);
    if (match?.[1] === undefined) throw new Error(stdout.slice(0, 500));
    return JSON.parse(match[1].replaceAll("&quot;", '"')) as StickyParentLayout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface NestedPinLayout {
  rowStateHeight: number;
  tier0: { top: number; bottom: number };
  tier1: { top: number; bottom: number };
  tier1Visible: boolean;
}

const NESTED_PIN_SCRIPT = `
const scroller = document.getElementById("scroller");
const tier0 = document.querySelector("[data-sidebar-sticky-tier]:not(#tier1)");
const tier1 = document.getElementById("tier1");
const rowState = tier0.querySelector("[data-sidebar-thread-row-state]");
const rowStateHeight = rowState.getBoundingClientRect().height;
const growingRowHeight = rowState.closest("[data-sidebar-rename-row]").getBoundingClientRect().height;
tier1.style.setProperty("--bb-sidebar-sticky-parent-offset", "calc(" + growingRowHeight + "px - 1 * var(--bb-sidebar-sticky-row-height))");
scroller.scrollTop = 400;
const origin = scroller.getBoundingClientRect().top;
const box = (element) => {
  const rect = element.getBoundingClientRect();
  return { top: rect.top - origin, bottom: rect.bottom - origin };
};
const tier1Box = tier1.getBoundingClientRect();
const hit = document.elementFromPoint(tier1Box.left + 40, tier1Box.top + tier1Box.height / 2);
document.getElementById("layout").textContent = JSON.stringify({
  rowStateHeight,
  tier0: box(tier0),
  tier1: box(tier1),
  tier1Visible: hit !== null && tier1.contains(hit),
});
`;

async function measureNestedPinLayout(
  rowHtml: string,
  viewportWidth: number,
): Promise<NestedPinLayout> {
  const dir = await mkdtemp(join(tmpdir(), "bb-nested-pin-"));
  try {
    const page = join(dir, "nested.html");
    const themeCss = await readFile(
      join(process.cwd(), "../../apps/app/src/components/ui/theme.css"),
      "utf8",
    );
    const children = Array.from(
      { length: 30 },
      (_, index) => `<div style="height:1.75rem">child ${index}</div>`,
    ).join("");
    await writeFile(
      page,
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
@layer theme, base, components, utilities;
:root{--bb-sidebar-row-height:1.75rem;--bb-sidebar-row-height-coarse:2.5rem;--sidebar:#fafafa;--sidebar-accent:#e4e4e7;--timeline-accent:#2563eb}
*,::before,::after{box-sizing:border-box}
body{margin:0}
${pluginCss ?? ""}
${themeCss}
[data-testid][data-thread-id],.group0>div:first-child{display:contents}
</style></head><body>
<div data-bb-plugin-root style="width:${viewportWidth}px">
<div id="scroller" style="height:240px;overflow:auto">
<div data-sidebar-sticky-stack style="--bb-sidebar-sticky-parent-base-top:0px">
<div class="group0">${rowHtml}<div><div>
<div data-sidebar-sticky-tier="parent" id="tier1" class="bg-sidebar" style="--bb-sidebar-sticky-parent-level:1">Level-1 parent</div>${children}</div>${children}</div></div>
</div></div></div>
<pre id="layout"></pre>
<script>${NESTED_PIN_SCRIPT}</script>
</body></html>`,
    );
    const { stdout } = await execFileAsync(chromiumPath ?? "", [
      "--headless",
      `--user-data-dir=${join(dir, "profile")}`,
      "--no-sandbox",
      "--disable-gpu",
      ...CHROMIUM_QUIET_FLAGS,
      "--hide-scrollbars",
      `--window-size=${viewportWidth},400`,
      "--virtual-time-budget=2000",
      "--dump-dom",
      `file://${page}`,
    ]);
    const match = /<pre id="layout">([^<]*)<\/pre>/.exec(stdout);
    if (match?.[1] === undefined) throw new Error(stdout.slice(0, 500));
    return JSON.parse(match[1].replaceAll("&quot;", '"')) as NestedPinLayout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(
  pluginCss === null || (chromiumPath === null && !process.env.CI),
)("ThreadRow row-state layout", () => {
  it("has a Chromium binary to measure layout with", () => {
    expect(chromiumPath).not.toBeNull();
  });

  it("keeps desktop chat, terminal and cross-project titles aligned above visible metadata in a narrow sidebar", async () => {
    const projects = [
      makePluginProject({ id: "proj_test", name: "drone-agent" }),
    ];
    const providers: PluginProvidersState["providers"] = [
      {
        id: "provider-test",
        pluginId: "provider-test",
        displayName: "Test Provider",
        logoUrl: null,
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
      },
    ];
    const layouts: RowLayout[] = [];
    for (const [id, nativeTerminal, crossProjectId] of [
      ["chat", false, null],
      ["terminal", true, null],
      ["cross-project", false, "proj_test"],
    ] as const) {
      const view = renderThreadRow({
        thread: createThread({
          id,
          title: "Slice B setup cue check",
          pinnedAt: id === "chat" ? 1 : null,
          experimental_nativeTerminal: nativeTerminal,
          providerId: nativeTerminal ? "unresolved-provider" : "provider-test",
          environment: makeSidebarEnvironment({ branchName: "main" }),
          updatedAt: Date.now() - 4 * 86_400_000,
        }),
        projects,
        providers,
        crossProjectId,
        isCompactViewport: false,
      });
      layouts.push(await measureRowLayout(view.container.innerHTML, 1280, 256));
      view.unmount();
    }
    for (const layout of layouts) {
      expect(layout.title.width).toBeGreaterThan(100);
      expect(layout.metadata.visible).toBe(true);
      expect(layout.metadata.width).toBeGreaterThan(100);
      expect(layout.metadata.height).toBeGreaterThan(0);
      expect(layout.metadata.top).toBeGreaterThanOrEqual(
        layout.title.bottom - 1,
      );
      expect(layout.metadata.bottom).toBeLessThanOrEqual(layout.row.bottom + 1);
      expect(layout.context?.textLeft).toBeCloseTo(layout.title.left, 0);
      expect(layout.title.left).toBeCloseTo(layouts[0]!.title.left, 0);
      expect(layout.mode.right + 4).toBeCloseTo(layout.title.left, 0);
      expect(layout.mode.width).toBe(16);
      expect(layout.metadata.text).toContain("drone-agent");
      expect(layout.metadata.text).toContain(" · ");
      expect(layout.metadata.text).not.toContain("main");
      expect(layout.branch).toBeNull();
    }
  });

  it("aligns metadata text after chat, terminal and worktree glyph slots", async () => {
    const view = renderThreadRow({
      thread: createThread({ environment: null }),
      isCompactViewport: false,
    });
    const chat = await measureRowLayout(view.container.innerHTML, 1280);
    view.rerenderThreadRow(
      createThread({ environment: null, experimental_nativeTerminal: true }),
    );
    const terminal = await measureRowLayout(view.container.innerHTML, 1280);
    view.rerenderThreadRow(
      createThread({
        environment: makeSidebarEnvironment({ isWorktree: true }),
      }),
    );
    const worktree = await measureRowLayout(view.container.innerHTML, 1280);
    expect(chat.context).not.toBeNull();
    expect(chat.context?.glyphWidth).toBe(0);
    for (const layout of [terminal, worktree]) {
      expect(layout.context?.glyphWidth).toBe(16);
      expect(layout.context?.textLeft).toBeCloseTo(layout.title.left, 0);
    }
    await writeFile(
      join(tmpdir(), "p108-sidebar-metadata-offsets.json"),
      JSON.stringify({ chat: chat.context, terminal: terminal.context, worktree: worktree.context }),
    );
  });

  it("keeps desktop sidebar row height when the smallest text advances one tier", async () => {
    vi.spyOn(pluginSdk, "experimental_useExperiment").mockReturnValue(true);
    const { container } = renderThreadRow({
      thread: createThread(),
      isCompactViewport: false,
    });
    const html = container.innerHTML;
    const before = await measureRowLayout(`<style>:root{--text-2xs:0.625rem;--text-2xs--line-height:0.875rem}</style>${html}`, 1280);
    const after = await measureRowLayout(`<style>:root{--text-2xs:0.6875rem;--text-2xs--line-height:0.875rem}</style>${html}`, 1280);
    expect(after.row.height - before.row.height).toBeLessThanOrEqual(1);
    expect(after.row.height).toBeGreaterThan(0);
    await writeFile(join(tmpdir(), "p36-sidebar-af0afa41bfdb.json"), JSON.stringify({ before: before.row.height, after: after.row.height }));
  });

  const VIEWPORTS = [
    { name: "desktop", width: 280, isCompact: false },
    { name: "compact 390px", width: 390, isCompact: true },
  ];

  it.each([
    { kind: "working", thread: { status: "active", runtimeStatus: "active" } },
    { kind: "needs-input", thread: { hasPendingInteraction: true } },
  ] as const)("keeps the $kind status slot visible at desktop width", async ({ kind, thread }) => {
    const { container } = renderThreadRow({
      thread: createThread(thread),
      isCompactViewport: false,
    });
    const row = container.querySelector("[data-sidebar-rename-row]");
    expect(row?.className).toContain("[--bb-sidebar-desktop-row-height:2.5rem]");
    expect(row?.className).toContain("md:h-(--bb-sidebar-desktop-row-height)");
    const layout = await measureRowLayout(container.innerHTML, 1280);
    expect(layout.innerWidth).toBeGreaterThanOrEqual(768);
    expect(layout.statusGlyph?.kind).toBe(kind);
    expect(layout.statusGlyph?.visible).toBe(true);
    expect(layout.statusGlyph?.width).toBeGreaterThan(0);
    expect(layout.statusGlyph?.height).toBeGreaterThan(0);
  });

  async function layoutFor(
    progress: { value: number; label?: string } | null,
    viewport: (typeof VIEWPORTS)[number],
  ): Promise<RowLayout> {
    const { container } = renderThreadRow({
      thread: createThread({
        experimental_rowState: { statuses: {}, progress },
      }),
      isCompactViewport: viewport.isCompact,
      options: { ...DEFAULT_OPTIONS, isCompact: viewport.isCompact },
    });
    return measureRowLayout(container.innerHTML, viewport.width);
  }

  it.each(VIEWPORTS)(
    "renders the 60% progress bar at a real width on $name",
    async (viewport) => {
      const layout = await layoutFor({ value: 0.6 }, viewport);

      expect(layout.innerWidth).toBeGreaterThan(0);
      expect(layout.link.width).toBeGreaterThan(0);
      expect(layout.bar).not.toBeNull();
      expect(layout.bar?.width).toBeGreaterThan(viewport.width / 2);
      expect(layout.bar?.height).toBeGreaterThan(0);
      expect((layout.bar?.fill ?? 0) / (layout.bar?.width ?? 1)).toBeCloseTo(
        0.6,
        1,
      );
      expect(layout.bar?.bottom).toBeLessThanOrEqual(layout.row.bottom);
      expect(layout.bar?.fillBackground).not.toBe("rgba(0, 0, 0, 0)");
    },
  );

  it.each(VIEWPORTS)(
    "keeps the row title readable beside a status chip and label on $name",
    async (viewport) => {
      const { container } = renderThreadRow({
        thread: createThread({
          experimental_rowState: {
            statuses: { task: { value: "Running" } },
            progress: { value: 0.6, label: "Writing tests" },
          },
        }),
        isCompactViewport: viewport.isCompact,
        options: { ...DEFAULT_OPTIONS, isCompact: viewport.isCompact },
      });
      const layout = await measureRowLayout(
        container.innerHTML,
        viewport.width,
      );

      expect(layout.link.width).toBeGreaterThan(viewport.width / 3);
      expect(layout.bar?.width).toBeGreaterThan(viewport.width / 2);
    },
  );

  it.each(VIEWPORTS)(
    "keeps a short status chip content-sized on $name",
    async (viewport) => {
      const { container } = renderThreadRow({
        thread: createThread({
          experimental_rowState: {
            statuses: { task: { value: "Running" } },
            progress: { value: 0.6 },
          },
        }),
        isCompactViewport: viewport.isCompact,
        options: { ...DEFAULT_OPTIONS, isCompact: viewport.isCompact },
      });
      const layout = await measureRowLayout(
        container.innerHTML,
        viewport.width,
      );

      expect(layout.chip?.width).toBeGreaterThan(0);
      expect(layout.chip?.width).toBeLessThan(layout.row.width / 2);
      expect(layout.bar?.width).toBeGreaterThan(viewport.width / 2);
    },
  );

  it.each(VIEWPORTS)(
    "truncates a long status chip inside the row on $name",
    async (viewport) => {
      const { container } = renderThreadRow({
        thread: createThread({
          experimental_rowState: {
            statuses: {
              task: { value: "A very long status value ".repeat(8) },
            },
            progress: null,
          },
        }),
        isCompactViewport: viewport.isCompact,
        options: { ...DEFAULT_OPTIONS, isCompact: viewport.isCompact },
      });
      const layout = await measureRowLayout(
        container.innerHTML,
        viewport.width,
      );

      expect(layout.chip?.width).toBeGreaterThan(layout.row.width / 2);
      expect(layout.chip?.left).toBeGreaterThanOrEqual(layout.row.left);
      expect(layout.chip?.right).toBeLessThanOrEqual(layout.row.right);
    },
  );

  it.each(VIEWPORTS)(
    "keeps a sticky parent row's state inside the row, clear of the next row and under the pointer on $name",
    async (viewport) => {
      const { container } = renderThreadRow({
        thread: createThread({
          experimental_rowState: {
            statuses: {
              task: { value: "WT-GUARD preserve recoverable work" },
              build: { value: "#138 f49bb0e9 OPEN: chain138.out:unit EXIT=0" },
            },
            progress: { value: 0.6, label: "#138 merge pipeline" },
          },
        }),
        isCompactViewport: viewport.isCompact,
        options: {
          kind: "parent",
          depth: 1,
          isCompact: viewport.isCompact,
          isCollapsed: false,
          childCount: 1,
          childActivity: NO_COLLAPSED_CHILD_ACTIVITY,
          stickyLevel: 0,
          onToggleCollapsed: vi.fn(),
        },
      });
      const layout = await measureStickyParentLayout(
        container.innerHTML,
        viewport.width,
      );

      expect(layout.rowState.top).toBeGreaterThanOrEqual(layout.tier.top - 0.5);
      expect(layout.rowState.bottom).toBeLessThanOrEqual(
        layout.tier.bottom + 0.5,
      );
      expect(layout.tier.bottom).toBeLessThanOrEqual(layout.next.top + 0.5);
      expect(layout.rowStateHitsRow).toBe(true);
    },
  );

  it.each(VIEWPORTS)(
    "keeps a nested sticky parent visible below a pinned parent that has row state on $name",
    async (viewport) => {
      const { container } = renderThreadRow({
        thread: createThread({
          experimental_rowState: {
            statuses: {
              task: { value: "WT-GUARD preserve recoverable work" },
              build: { value: "#138 f49bb0e9 OPEN: chain138.out:unit EXIT=0" },
            },
            progress: { value: 0.6, label: "#138 merge pipeline" },
          },
        }),
        isCompactViewport: viewport.isCompact,
        options: {
          kind: "parent",
          depth: 1,
          isCompact: viewport.isCompact,
          isCollapsed: false,
          childCount: 1,
          childActivity: NO_COLLAPSED_CHILD_ACTIVITY,
          stickyLevel: 0,
          onToggleCollapsed: vi.fn(),
        },
      });
      const layout = await measureNestedPinLayout(
        container.innerHTML,
        viewport.width,
      );

      expect(layout.rowStateHeight).toBeGreaterThan(40);
      expect(layout.tier1.top).toBeGreaterThanOrEqual(
        layout.tier0.bottom - 0.5,
      );
      expect(layout.tier1.top).toBeLessThanOrEqual(layout.tier0.bottom + 4);
      expect(layout.tier1Visible).toBe(true);
    },
  );

  it("renders no progress bar for 0.0 or null progress", () => {
    const zero = renderThreadRow({
      thread: createThread({
        experimental_rowState: { statuses: {}, progress: { value: 0 } },
      }),
    });
    expect(zero.container.querySelector("[role=progressbar]")).toBeNull();
    expect(
      zero.container.querySelector("[data-sidebar-thread-row-state]"),
    ).toBeNull();
    cleanup();

    const none = renderThreadRow({
      thread: createThread({
        experimental_rowState: { statuses: {}, progress: null },
      }),
    });
    expect(none.container.querySelector("[role=progressbar]")).toBeNull();
    expect(
      none.container.querySelector("[data-sidebar-thread-row-state]"),
    ).toBeNull();
  });
});

it("uses regular desktop weight for inactive rows and medium for attention", () => {
  const view = renderThreadRow({ thread: createThread({ indicator: "none", lastReadAt: 1, latestAttentionAt: 1 }) });
  const title = () => view.container.querySelector(".bb-thread-title")!;
  expect(title().getAttribute("data-emphasized")).toBe("false");
  expect(title().className).toContain("font-normal");
  expect(title().className).toContain("font-normal");
  view.rerenderThreadRow(createThread({ indicator: "check-terminal" }));
  expect(title().getAttribute("data-emphasized")).toBe("true");
  const metadata = view.container.querySelector("[data-sidebar-thread-context]")!;
  expect(metadata.className).toContain("md:text-sidebar-metadata-foreground");
});

it("puts a mode glyph in the leading column without a blank chat slot", () => {
  const view = renderThreadRow({ thread: createThread({ environment: null }) });
  expect(view.container.querySelector("[data-sidebar-thread-leading]")).toBeNull();
  view.rerenderThreadRow(createThread({ experimental_nativeTerminal: true }));
  expect(screen.getByRole("img", { name: "Native terminal" }).closest("[data-sidebar-thread-leading]")).not.toBeNull();
});

it("leaves desktop descenders room without fixed title or metadata heights", () => {
  const view = renderThreadRow({ thread: createThread({ title: "g p y j q" }) });
  const title = view.container.querySelector(".bb-thread-title")!;
  const text = title.lastElementChild!;
  const metadata = view.container.querySelector("[data-sidebar-thread-context]")!;
  expect(title.classList.contains("md:leading-5")).toBe(true);
  expect(text.classList.contains("md:leading-5")).toBe(true);
  expect(title.classList.contains("md:items-center!")).toBe(true);
  for (const element of [title, text, metadata]) {
    expect(element.className).not.toMatch(/(?:^| )md:h-/);
  }
  expect(metadata.classList.contains("md:leading-4")).toBe(true);
});
