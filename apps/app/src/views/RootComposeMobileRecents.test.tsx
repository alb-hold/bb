// @vitest-environment jsdom

import { InfoRowTime } from "@bb/shared-ui/info-list-row";

import type { ThreadListEntry } from "@bb/domain";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { ReactNode } from "react";

import { Provider, createStore } from "jotai";

import { mobileRecentsCollapsedThreadIdsAtom } from "./mobile-recents-collapse";

import { MemoryRouter } from "react-router-dom";

import { RouteLoadingSkeleton } from "@/components/ui/route-loading-skeleton";

import {
  writeCachedSidebarBootstrap,
  readCachedSidebarBootstrap,
  SIDEBAR_BOOTSTRAP_CACHE_KEY,
  resetSidebarBootstrapCacheForTest,
} from "@/lib/sidebar-bootstrap-cache";

import {
  makeSidebarBootstrapResponse,
  makeProjectWithThreadsResponse,
} from "@/test/fixtures/projects";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";

import type { SystemEnvironmentProvider } from "@bb/server-contract";

import { systemEnvironmentProvidersQueryKey } from "@/hooks/queries/environment-provider-queries";

import {
  RecentThreadProviderMark,
  RecentThreadRowContent,
} from "./RootComposeRecentRows";

import { RootComposeMobileRecents } from "./RootComposeMobileRecents";

import { SidebarThreadEntriesProvider } from "@/lib/sidebar-thread-entries";

import { readFileSync } from "node:fs";

import {
  SidebarProvider,
  Sidebar,
  SidebarInset,
} from "@/components/ui/sidebar";

import { RootComposeHome } from "./RootComposeHome";

import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";

import { CORE_THREAD_ACTIONS } from "@/lib/thread-actions/core-thread-actions";

import { ThreadActionCollectors } from "@/lib/thread-actions/thread-action-registry";


const threadActions = vi.hoisted(() => ({
  requestArchive: vi.fn(),
  requestDelete: vi.fn(),
  requestRename: vi.fn(),
  togglePin: vi.fn(),
  toggleRead: vi.fn(),
  unarchiveThread: vi.fn(),
}));


vi.mock("@/components/thread/ThreadActionsProvider", () => ({
  useThreadActions: () => threadActions,
}));


const sdkThreads = vi.hoisted(() => ({
  pin: vi.fn(async ({ threadId }: { threadId: string }) => ({
    id: threadId,
  })),
}));


vi.mock("@/lib/sdk", () => ({ sdk: { threads: sdkThreads } }));


const personalProvider: SystemEnvironmentProvider = {
  machineProviderId: null,
  id: "personal-workspace",
  displayName: "Personal workspace",
  description: "Prepare a workspace for this thread.",
  icon: "Folder",
  logoUrl: null,
  pluginId: "environment-personal-workspace",
  acceptsEmptyInputs: true,
  machineAvailability: {},
  availability: null,
  requires: {
    projectCheckout: false,
    gitCheckout: false,
    gitRemote: false,
    projectless: true,
  },
  inputs: null,
};


function TestProviders({
  children,
  store = createStore(),
  withSidebarEntries = false,
}: {
  children: ReactNode;
  store?: ReturnType<typeof createStore>;
  withSidebarEntries?: boolean;
}) {
  const body = (
    <>
      <ThreadActionCollectors
        coreRegistrations={CORE_THREAD_ACTIONS}
        requestRename={() => {}}
      />
      {children}
    </>
  );
  return (
    <Provider store={store}>
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          {withSidebarEntries ? (
            <SidebarThreadEntriesProvider navigation={undefined}>
              {body}
            </SidebarThreadEntriesProvider>
          ) : (
            body
          )}
        </MemoryRouter>
      </QueryClientProvider>
    </Provider>
  );
}


function storeWithCollapsedThreads(threadIds: string[]) {
  const store = createStore();
  void store.set(mobileRecentsCollapsedThreadIdsAtom, threadIds);
  return store;
}


function makeThread(overrides: Partial<ThreadListEntry> = {}): ThreadListEntry {
  return makeThreadListEntry({
    id: "thr_mobile",
    projectId: "proj_mobile",
    title: "Mobile activity",
    titleFallback: "Mobile activity",
    status: "active",
    lastReadAt: 1,
    latestAttentionAt: 2,
    createdAt: 1,
    updatedAt: 2,
    activity: {
      activeGoalCount: 0,
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 1,
    },
    runtime: {
      displayStatus: "active",
    },
    ...overrides,
  });
}


const IDLE_ACTIVITY: ThreadListEntry["activity"] = {
      activeGoalCount: 0,
  activeWorkflowCount: 0,
  activeBackgroundAgentCount: 0,
  activeBackgroundCommandCount: 0,
  activePlanModeCount: 0,
};


function makeIdleThread(
  overrides: Partial<ThreadListEntry> = {},
): ThreadListEntry {
  return makeThread({
    status: "idle",
    runtime: {
      displayStatus: "idle",
    },
    activity: IDLE_ACTIVITY,
    ...overrides,
  });
}


afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});


describe("mobile recents hierarchy interaction", () => {
  function renderTree() {
    return render(
      <TestProviders>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map()}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[
            makeThread({
              id: "thr_parent",
              title: "Rework folder model",
              titleFallback: "Rework folder model",
              latestAttentionAt: 10,
            }),
            makeThread({
              id: "thr_child",
              title: "Audit folder query paths",
              titleFallback: "Audit folder query paths",
              parentThreadId: "thr_parent",
              latestAttentionAt: 9,
            }),
          ]}
        />
      </TestProviders>,
    );
  }

  it("collapses and expands children from the provider tile and caret", () => {
    const { container } = renderTree();

    expect(container.querySelector("a button")).toBeNull();

    expect(screen.getByText("Audit folder query paths")).not.toBeNull();
    const collapse = screen.getByRole("button", {
      name: "Hide threads under Rework folder model",
    });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");

    const providerTile = collapse.querySelector("span.size-4");
    if (!(providerTile instanceof HTMLElement)) {
      throw new Error("Expected provider tile inside the disclosure button");
    }
    expect(providerTile.className).not.toContain("border");
    expect(providerTile.closest("li")?.querySelector("a")?.className).toContain(
      "h-13",
    );
    fireEvent.click(providerTile);

    expect(screen.queryByText("Audit folder query paths")).toBeNull();
    const expand = screen.getByRole("button", {
      name: "Show threads under Rework folder model",
    });
    expect(expand.getAttribute("aria-expanded")).toBe("false");

    const caret = expand.querySelector("svg");
    if (caret === null) {
      throw new Error("Expected disclosure caret");
    }
    fireEvent.click(caret);
    expect(screen.getByText("Audit folder query paths")).not.toBeNull();
  });

  it.each([
    {
      label: "Needs input",
      child: makeIdleThread({
        id: "thr_child",
        parentThreadId: "thr_parent",
        hasPendingInteraction: true,
      }),
    },
    {
      label: "Working",
      child: makeIdleThread({
        id: "thr_child",
        parentThreadId: "thr_parent",
        activity: {
          ...IDLE_ACTIVITY,
          activePlanModeCount: 1,
        },
      }),
    },
    {
      label: "Working",
      child: makeThread({
        id: "thr_child",
        parentThreadId: "thr_parent",
        activity: IDLE_ACTIVITY,
      }),
    },
  ])(
    "renders child-only $label state on a collapsed parent",
    ({ child, label }) => {
      render(
        <TestProviders store={storeWithCollapsedThreads(["thr_parent"])}>
          <RootComposeMobileRecents
            highlightedThreadId={null}
            projectNamesById={new Map()}
            providersById={new Map()}
            showCreatingRow={false}
            threads={[
              makeIdleThread({
                id: "thr_parent",
                lastReadAt: 10,
                latestAttentionAt: 5,
              }),
              child,
            ]}
          />
        </TestProviders>,
      );

      expect(screen.getByLabelText(label)).not.toBeNull();
      expect(
        screen.getByRole("link", {
          name: `Open Mobile activity — ${label}`,
        }),
      ).not.toBeNull();
    },
  );

  it("renders a child-only draft state on a collapsed parent", () => {
    window.localStorage.setItem(
      "bb.promptbox.contents-proj_mobile-thr_child-3",
      JSON.stringify({ text: "Continue child work", attachments: [] }),
    );
    render(
      <TestProviders store={storeWithCollapsedThreads(["thr_parent"])}>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map()}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[
            makeIdleThread({
              id: "thr_parent",
              lastReadAt: 10,
              latestAttentionAt: 5,
            }),
            makeIdleThread({
              id: "thr_child",
              parentThreadId: "thr_parent",
            }),
          ]}
        />
      </TestProviders>,
    );

    expect(
      screen.getByLabelText("Thread has unsubmitted draft"),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", {
        name: "Open Mobile activity — Thread has unsubmitted draft",
      }),
    ).not.toBeNull();
  });

  it("reveals a highlighted thread whose parent is collapsed", () => {
    const store = storeWithCollapsedThreads(["thr_parent"]);
    render(
      <TestProviders store={store}>
        <RootComposeMobileRecents
          highlightedThreadId="thr_child"
          projectNamesById={new Map()}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[
            makeThread({
              id: "thr_parent",
              title: "Rework folder model",
              titleFallback: "Rework folder model",
            }),
            makeThread({
              id: "thr_child",
              title: "Audit folder query paths",
              titleFallback: "Audit folder query paths",
              parentThreadId: "thr_parent",
            }),
          ]}
        />
      </TestProviders>,
    );

    expect(screen.getByText("Audit folder query paths")).not.toBeNull();
    expect(store.get(mobileRecentsCollapsedThreadIdsAtom)).toEqual([]);
  });

  it("gives only the parent a toggle and indents the child", () => {
    renderTree();

    expect(screen.getAllByRole("button")).toHaveLength(1);
    const [parentRow, childRow] = screen.getAllByRole("listitem");
    if (!parentRow || !childRow) {
      throw new Error("Expected a parent and a child row");
    }
    expect(parentRow.style.paddingLeft).toBe("8px");
    expect(childRow.style.paddingLeft).toBe("22px");
  });
});


describe("mobile recents section", () => {
  it("keeps the Recent label pinned while the list scrolls under it", () => {
    render(
      <TestProviders>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map()}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[makeThread()]}
        />
      </TestProviders>,
    );

    expect(
      screen.getByText("Recent").classList.contains("text-subtle-foreground"),
    ).toBe(true);
    const label = screen.getByText("Recent").parentElement;
    if (!(label instanceof HTMLElement)) {
      throw new Error("Expected a Recent label wrapper");
    }
    expect(label.className).toContain("sticky");
    expect(label.className).toContain("top-0");
    expect(label.className).toContain("bg-background");
    expect(label.classList.contains("pt-1")).toBe(true);
    expect(label.classList.contains("pb-2")).toBe(true);
    expect(label.querySelector('[data-overflow-fade="below"]')).toBeNull();
  });
});


describe("mobile recent thread rows", () => {


  it.each([
    [3 * 60 * 60 * 1000, "3h"],
    [24 * 60 * 60 * 1000, "1d"],
    [2 * 24 * 60 * 60 * 1000, "2d"],
    [21 * 24 * 60 * 60 * 1000, "3w"],
  ] as const)("matches sidebar relative dates at %s ms", (age, expected) => {
    const now = Date.now();
    render(
      <TestProviders>
        <InfoRowTime timestamp={now - age} now={now} />
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map([["proj_mobile", "bb"]])}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[
            makeThread({
              latestAttentionAt: now - age,
              activity: {
                activeWorkflowCount: 0,
                activeBackgroundAgentCount: 0,
                activeBackgroundCommandCount: 0,
                activePlanModeCount: 0,
                activeGoalCount: 0,
              },
            }),
          ]}
        />
      </TestProviders>,
    );

    expect(screen.getByTitle(`bb \u00b7 ${expected}`).textContent).toBe(
      `bb \u00b7 ${expected}`,
    );
    expect(screen.getByText(expected, { selector: "time" }).tagName).toBe(
      "TIME",
    );
    const metadata = screen.getByTitle(`bb \u00b7 ${expected}`);
    expect(metadata.classList.contains("text-xs")).toBe(true);
    expect(metadata.classList.contains("text-subtle-foreground")).toBe(true);
    expect(metadata.className).not.toContain("pointer-coarse:text-sm");
    expect(metadata.querySelector("[data-icon]")).toBeNull();
    expect(metadata.classList.contains("pl-5.5")).toBe(false);
  });


  it.each([
    "bb/mobile-home",
    "bb/add-e2e-coverage-for-the-mobile-home-recent-list-with-a-very-long-branch",
  ])("keeps project and age outside the shrinking branch: %s", (branch) => {
    render(
      <TestProviders>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map([["proj_mobile", "bb"]])}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[
            makeThread({
              environmentBranchName: branch,
              environmentProviderId: null,
              latestAttentionAt: Date.now() - 3 * 60 * 60 * 1000,
              activity: {
                activeWorkflowCount: 0,
                activeBackgroundAgentCount: 0,
                activeBackgroundCommandCount: 0,
                activePlanModeCount: 0,
                activeGoalCount: 0,
              },
            }),
          ]}
        />
      </TestProviders>,
    );

    const metadata = screen.getByTitle(`bb \u00b7 ${branch} \u00b7 3h`);
    expect(metadata.textContent).toBe(`bb \u00b7 ${branch} \u00b7 3h`);
    const project = screen.getByText("bb");
    const age = screen.getByText("3h");
    const branchNode = screen.getByText(branch);
    for (const node of [project, age]) {
      expect(node.classList.contains("shrink-0")).toBe(true);
      expect(node.classList.contains("min-w-0")).toBe(false);
    }
    expect(age.classList.contains("truncate")).toBe(false);
    expect(branchNode.classList.contains("min-w-0")).toBe(true);
    expect(branchNode.classList.contains("truncate")).toBe(true);
    expect(metadata.classList.contains("leading-4")).toBe(true);
    expect(metadata.classList.contains("pl-5.5")).toBe(false);
    expect(metadata.querySelector('[role="img"]')).toBeNull();
  });


  it("caps the project and reserves the age beside a short branch", () => {
    render(
      <TestProviders>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map([["proj_mobile", "queen-scheduler"]])}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[
            makeThread({
              environmentBranchName: "main",
              environmentProviderId: null,
            }),
          ]}
        />
      </TestProviders>,
    );
    const project = screen.getByText("queen-scheduler");
    const branch = screen.getByText("main");
    expect(project.classList.contains("max-w-[min(14ch,60%)]")).toBe(true);
    expect(project.classList.contains("shrink-0")).toBe(true);
    expect(branch.classList.contains("truncate")).toBe(true);
  });


  it("does not repeat the project name as the workspace segment", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(systemEnvironmentProvidersQueryKey({}), [
      personalProvider,
    ]);
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <RootComposeMobileRecents
            highlightedThreadId={null}
            projectNamesById={new Map([["proj_mobile", "Personal"]])}
            providersById={new Map()}
            showCreatingRow={false}
            threads={[
              makeThread({
                environmentId: "env_personal",
                environmentProviderId: "personal-workspace",
                latestAttentionAt: Date.now() - 3 * 60 * 60 * 1000,
                activity: {
      activeGoalCount: 0,
                  activeWorkflowCount: 0,
                  activeBackgroundAgentCount: 0,
                  activeBackgroundCommandCount: 0,
                  activePlanModeCount: 0,
                },
              }),
            ]}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByTitle("Personal \u00b7 3h").textContent).toBe(
      "Personal \u00b7 3h",
    );
  });



  it("reserves an empty status slot when a thread has no indicator", () => {
    render(
      <TestProviders>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map()}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[
            makeThread({
              status: "idle",
              lastReadAt: 10,
              latestAttentionAt: 5,
              runtime: {
                displayStatus: "idle",
              },
              activity: {
                activeWorkflowCount: 0,
                activeBackgroundAgentCount: 0,
                activeBackgroundCommandCount: 0,
                activePlanModeCount: 0,
                activeGoalCount: 0,
              },
            }),
          ]}
        />
      </TestProviders>,
    );

    expect(screen.queryByLabelText("Plan mode active")).toBeNull();
    expect(screen.queryByLabelText("Thread working")).toBeNull();
    expect(
      screen.getByRole("link").querySelectorAll("[data-recent-status-slot]"),
    ).toHaveLength(1);
  });
});


describe("RootComposeMobileRecents", () => {
  it("shows three desktop Recent rows with the real sidebar expanded", () => {
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("innerHeight", 800);
    const css = readFileSync("src/app.css", "utf8");
    const start = css.indexOf(
      ':where([data-testid="root-compose-compact-scroll-viewport"]',
    );
    const rules = css.slice(start, css.indexOf("@media", start));
    const props = {
      highlightedThreadId: null,
      projectNamesById: new Map<string, string>(),
      providersById: new Map(),
      showCreatingRow: false,
      maxRows: 3,
    };
    const { rerender } = render(
      <TestProviders>
        <style>{rules}</style>
        <CompactViewportOverrideProvider isCompactViewport={false}>
          <SidebarProvider open>
            <Sidebar />
            <SidebarInset>
              <RootComposeHome
                isCompact={false}
                composer={<div data-testid="desktop-composer" />}
                homepageSections={null}
                compactScrollContent={
                  <RootComposeMobileRecents
                    {...props}
                    threads={Array.from({ length: 6 }, (_, i) =>
                      makeThread({ id: `recent-${i}`, title: `Recent ${i}` }),
                    )}
                  />
                }
              />
            </SidebarInset>
          </SidebarProvider>
        </CompactViewportOverrideProvider>
      </TestProviders>,
    );
    expect(
      document.querySelector('.peer[data-state="expanded"][data-collapsible]'),
    ).not.toBeNull();
    expect(
      getComputedStyle(screen.getByTestId("root-compose-desktop-recents"))
        .display,
    ).not.toBe("none");
    expect(screen.getAllByRole("link")).toHaveLength(3);
    expect(
      screen
        .getByTestId("root-compose-desktop-recents")
        .contains(screen.getByRole("list")),
    ).toBe(true);
    expect(
      document.querySelector(
        "[data-root-compose-mobile-recents] [data-overflow-fade]",
      ),
    ).toBeNull();
    expect(
      screen.getByText("Recent").closest("section")?.className,
    ).not.toContain("md:hidden");
    rerender(
      <TestProviders>
        <RootComposeMobileRecents {...props} threads={[]} />
      </TestProviders>,
    );
    expect(screen.queryByText("Recent")).toBeNull();
  });


  it("opens thread actions on a long press without following the thread link", async () => {
    vi.useFakeTimers();
    const thread = makeThread();
    render(
      <TestProviders>
        <CompactViewportOverrideProvider isCompactViewport>
          <RootComposeMobileRecents
            highlightedThreadId={null}
            projectNamesById={new Map()}
            providersById={new Map()}
            showCreatingRow={false}
            threads={[thread]}
          />
        </CompactViewportOverrideProvider>
      </TestProviders>,
    );
    const link = screen.getByRole("link");
    fireEvent.pointerDown(link, {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: 100,
      clientY: 100,
    });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    fireEvent.pointerUp(link, { pointerId: 1, pointerType: "touch" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, click);
    expect(click.defaultPrevented).toBe(true);
    act(() => vi.advanceTimersByTime(500));
    vi.useRealTimers();
    const pin = await screen.findByRole("menuitem", { name: "Pin" });
    fireEvent.pointerDown(pin, { pointerType: "touch" });
    fireEvent.click(pin);
    vi.useRealTimers();
    await waitFor(() =>
      expect(sdkThreads.pin).toHaveBeenCalledWith({ threadId: thread.id }),
    );
  });


  it("shows concurrent Plan activity before the runtime spinner", () => {
    render(
      <TestProviders>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map()}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[makeThread()]}
        />
      </TestProviders>,
    );

    expect(screen.getByLabelText("Working")).not.toBeNull();
    expect(screen.queryByLabelText("Plan mode active")).toBeNull();
    expect(screen.queryByLabelText("Goal active")).toBeNull();
  });




  it("expires a native runtime indicator on the shared visible tick", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const thread = makeIdleThread({
      status: "active",
      runtime: {
        displayStatus: "active",
        nativeActivity: {
          lastEvidenceAt: Date.now(),
          freshForMs: 90_000,
          confirmation: "confirmed",
          evidenceKind: "holder-report",
        },
      },
    });
    render(
      <TestProviders>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map()}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[thread]}
        />
      </TestProviders>,
    );

    expect(screen.getByLabelText("Working")).not.toBeNull();
    act(() => vi.advanceTimersByTime(90_000));
    expect(screen.getByLabelText("Working")).not.toBeNull();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByLabelText("Working")).toBeNull();
  });


  it("shows Working for a draft thread with runtime activity", () => {
    window.localStorage.setItem(
      "bb.promptbox.contents-proj_mobile-thr_mobile-3",
      JSON.stringify({ text: "Keep editing", attachments: [] }),
    );

    render(
      <TestProviders>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map()}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[makeThread()]}
        />
      </TestProviders>,
    );

    expect(screen.getByLabelText("Working")).not.toBeNull();
    expect(
      screen.queryByLabelText("Thread working with unsubmitted draft"),
    ).toBeNull();
    expect(screen.queryByLabelText("Plan mode active")).toBeNull();
  });


  it("includes the resolved Done indicator in the link label", () => {
    window.localStorage.setItem(
      "bb.promptbox.contents-proj_mobile-thr_mobile-3",
      JSON.stringify({ text: "Keep editing", attachments: [] }),
    );

    render(
      <TestProviders>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map()}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[
            makeThread({
              status: "idle",
              activity: {
                activeWorkflowCount: 0,
                activeBackgroundAgentCount: 0,
                activeBackgroundCommandCount: 0,
                activePlanModeCount: 0,
                activeGoalCount: 0,
              },
              runtime: {
                displayStatus: "idle",
              },
            }),
          ]}
        />
      </TestProviders>,
    );

    expect(
      screen.getByRole("link", {
        name: "Open Mobile activity — Done",
      }),
    ).not.toBeNull();
    expect(screen.queryByLabelText("Plan mode active")).toBeNull();
  });
});


it.each(
  ["plain", "expanded", "collapsed", "native", "worktree"].flatMap((shape) =>
    [true, false].map((isCompact) => ({ shape, isCompact })),
  ),
)(
  "keeps cached and live Recent row geometry identical ($shape, compact=$isCompact)",
  ({ shape, isCompact }) => {
    vi.spyOn(Date, "now").mockReturnValue(1800000000000);
    const thread = makeThread({
      title: "Cached work",
      nativeTerminal: shape === "native",
      environmentIsWorktree: shape === "worktree",
      status: "idle",
      runtime: { displayStatus: "idle" },
      environmentBranchName: "feature/paint",
      latestAttentionAt: Date.now() - 60000,
    });
    const child = makeThread({
      id: "cached-child",
      parentThreadId: thread.id,
      title: "Child work",
    });
    const threads = shape === "plain" ? [thread] : [thread, child];
    const store = storeWithCollapsedThreads(
      shape === "collapsed" ? [thread.id] : [],
    );
    writeCachedSidebarBootstrap(
      makeSidebarBootstrapResponse({
        projects: [
          makeProjectWithThreadsResponse({
            id: thread.projectId,
            name: "Paint project",
            threads,
          }),
        ],
      }),
    );
    window.localStorage.setItem(
      SIDEBAR_BOOTSTRAP_CACHE_KEY,
      JSON.stringify(readCachedSidebarBootstrap()),
    );
    resetSidebarBootstrapCacheForTest();
    expect(
      readCachedSidebarBootstrap()?.projects[0]?.threads[0]?.nativeTerminal,
    ).toBe(shape === "native");
    const cached = render(
      <TestProviders store={store}>
        <CompactViewportOverrideProvider isCompactViewport={isCompact}>
          <RouteLoadingSkeleton isBoundedPane={false} variant="root-compose" />
        </CompactViewportOverrideProvider>
      </TestProviders>,
    );
    const cachedSection = cached.container.querySelector(
      "[data-root-compose-mobile-recents]",
    );
    expect(cachedSection).not.toBeNull();
    const cachedRow = cachedSection!.querySelector("li")!;
    const cachedClasses = [cachedRow, ...cachedRow.querySelectorAll("*")].map(
      (node) => node.getAttribute("class"),
    );
    const expectedGlyph =
      shape === "native"
        ? "Terminal"
        : shape === "worktree"
          ? "FolderGit"
          : null;
    const expectedLabel = shape === "native" ? "Native terminal" : "Worktree";
    expect(
      cachedRow.querySelector(`[data-icon="${expectedGlyph}"]`) !== null,
    ).toBe(expectedGlyph !== null);
    expect(
      cachedRow.querySelector(`[role="img"][aria-label="${expectedLabel}"]`) !==
        null,
    ).toBe(expectedGlyph !== null);
    const cachedText = cachedRow.textContent;
    const cachedPadding = cachedRow.getAttribute("style");
    const cachedRows = cachedSection!.querySelectorAll("li").length;
    expect(cachedRow.querySelector("a, button")).toBeNull();
    expect(cachedRow.closest('[aria-hidden="true"]')).not.toBeNull();
    const cachedHeader = cachedSection!.firstElementChild!.outerHTML;
    cached.unmount();
    const live = render(
      <TestProviders store={store}>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          showCreatingRow={false}
          threads={threads}
          projectNamesById={new Map([[thread.projectId, "Paint project"]])}
          providersById={new Map()}
        />
      </TestProviders>,
    );
    const liveSection = live.container.querySelector(
      "[data-root-compose-mobile-recents]",
    )!;
    const liveRow = liveSection.querySelector("li")!;
    expect(
      [liveRow, ...liveRow.querySelectorAll("*")].map((node) =>
        node.getAttribute("class"),
      ),
    ).toEqual(cachedClasses);
    expect(
      liveRow.querySelector(`[data-icon="${expectedGlyph}"]`) !== null,
    ).toBe(expectedGlyph !== null);
    expect(
      liveRow.querySelector(`[role="img"][aria-label="${expectedLabel}"]`) !==
        null,
    ).toBe(expectedGlyph !== null);
    expect(liveRow.textContent).toBe(cachedText);
    expect(liveRow.getAttribute("style")).toBe(cachedPadding);
    expect(liveSection.querySelectorAll("li").length).toBe(cachedRows);
    expect(liveSection.firstElementChild!.outerHTML).toBe(cachedHeader);
    resetSidebarBootstrapCacheForTest();
  },
);


it.each([false, true])(
  "uses one leading glyph column for native=%s",
  (nativeTerminal) => {
    const thread = makeThreadListEntry({
      nativeTerminal,
      environmentIsWorktree: false,
    });
    const { container } = render(
      <TestProviders>
        <div className="flex items-center gap-2.5">
          <RecentThreadProviderMark thread={thread} provider={null} depth={0} />
          <RecentThreadRowContent
            thread={thread}
            projectName="bb"
            environmentProviderLookup={{ status: "loaded", provider: null }}
            indicatorKind="none"
            queuedFailedCount={0}
          />
        </div>
      </TestProviders>,
    );
    expect(container.querySelector("[data-thread-title-mode]")).toBeNull();
    expect(
      container.querySelectorAll('[aria-label="Native terminal"]'),
    ).toHaveLength(nativeTerminal ? 1 : 0);
  },
);


it.each([
  ["native", { nativeTerminal: true }, "Native terminal", "native-terminal", "Terminal"],
  ["worktree", { environmentIsWorktree: true }, "Worktree", "worktree", "FolderGit"],
] as const)(
  "keeps the provider mark in a Recent row's leading column and badges the %s mode",
  (_shape, overrides, label, badge, icon) => {
    const thread = makeThread({ title: "Badge work", ...overrides });
    const plain = makeThread({ id: "badge-plain", title: "Plain work" });
    const view = render(
      <TestProviders store={storeWithCollapsedThreads([])} withSidebarEntries>
        <RootComposeMobileRecents
          highlightedThreadId={null}
          projectNamesById={new Map()}
          providersById={new Map()}
          showCreatingRow={false}
          threads={[thread, plain]}
        />
      </TestProviders>,
    );
    const marked = screen.getByText("Badge work").closest("li")!;
    const unmarked = screen.getByText("Plain work").closest("li")!;
    const mark = marked.querySelector('[role="img"]')!;
    expect(mark.getAttribute("aria-label")).toBe(label);
    expect(
      marked.querySelectorAll(`[data-thread-mode-badge="${badge}"]`),
    ).toHaveLength(1);
    expect(marked.querySelectorAll(`[data-icon="${icon}"]`)).toHaveLength(1);
    expect(unmarked.querySelector("[data-thread-mode-badge]")).toBeNull();
    expect(view.container.querySelectorAll("li")).toHaveLength(2);
  },
);
