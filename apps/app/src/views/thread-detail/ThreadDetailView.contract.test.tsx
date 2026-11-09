// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { makeEnvironment } from "@bb/test-helpers/domain-fixtures";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { resetFixedPanelTabsStateForTest } from "@/lib/fixed-panel-tabs";
import {
  createPluginFixedPanelTab,
  createThreadInfoFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import {
  collectPluginAppRegistrations,
  definePluginApp,
} from "@/lib/plugin-app-definition";
import { resetFocusedAppPanelControllersForTest } from "@/lib/app-fixed-tab-navigation";
import { markPluginFrontendsSettled } from "@/lib/plugin-frontend-boot-state";
import {
  CONTRACT_PLUGIN_ID,
  ContractActionTab,
  ContractStateProbe,
  ContractTargetedFixedTab,
  contractActionPanelTabId,
  contractTarget,
  describePanelControllerContract,
  readContractPanel,
  readContractTabs,
  snapshotFromState,
  type ContractStateSink,
} from "@/test/panel-controller-contract";
import { DefaultPaneContextProvider } from "./PaneContext";
import { ThreadDetailView } from "./ThreadDetailView";
import { threadQueryKey } from "@/hooks/queries/query-keys";

const appCommandHandlers = vi.hoisted(
  () => new Map<string, () => boolean | void>(),
);
const fixtures = vi.hoisted(() => ({
  probe: {
    current: null,
  } as import("@/test/panel-controller-contract").ContractPanelRef,
}));

const THREAD = makeThreadResponse({
  id: "thr_contract",
  projectId: "proj_contract",
  environmentId: "env_contract",
});
const ENVIRONMENT = makeEnvironment({
  id: "env_contract",
  projectId: "proj_contract",
});

it.each([
  ["page", "/threads/thr_contract", "proj_wrong", true, true],
  [
    "page",
    "/projects/proj_wrong/threads/thr_contract",
    "proj_wrong",
    true,
    false,
  ],
  ["pane", "/threads/thr_contract", "proj_wrong", true, false],
  [
    "pane",
    "/projects/proj_wrong/threads/thr_contract",
    "proj_wrong",
    true,
    false,
  ],
  ["page", "/threads/thr_contract", "proj_wrong", false, false],
  ["pane", "/threads/thr_contract", "proj_wrong", false, false],
  [
    "pane",
    "/projects/proj_contract/threads/thr_contract",
    "proj_contract",
    true,
    true,
  ],
] as const)(
  "resolves %s at %s with project %s before route canonicalization (record cached: %s, found: %s)",
  (surface, path, projectId, cached, found) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    if (cached) client.setQueryData(threadQueryKey(THREAD.id), THREAD);
    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: (
            <DefaultPaneContextProvider
              paneId="main"
              onRequestClose={null}
              navigateInPane={() => {}}
            >
              <ThreadDetailView
                {...(surface === "page"
                  ? { surface }
                  : {
                      surface,
                      projectId,
                      threadId: THREAD.id,
                      timelineEnabled: false,
                    })}
              />
            </DefaultPaneContextProvider>
          ),
        },
      ],
      { initialEntries: [path] },
    );
    render(
      <QueryClientProvider client={client}>
        <Provider>
          <RouterProvider router={router} />
        </Provider>
      </QueryClientProvider>,
    );
    if (found) {
      expect(screen.queryByText("Not found")).toBeNull();
      expect(document.querySelector("[data-thread-window]")).not.toBeNull();
    } else {
      expect(screen.getByText("Not found")).toBeDefined();
      expect(document.querySelector("[data-thread-window]")).toBeNull();
    }
    expect(router.state.location.pathname).toBe(path);
  },
);

vi.mock("@/components/commands/AppCommandProvider", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/commands/AppCommandProvider")
  >()),
  useAppCommandHandler: (command: string, handler: () => boolean | void) => {
    appCommandHandlers.set(command, handler);
  },
  useAppCommandShortcut: () => null,
}));
vi.mock("@bb/shared-ui/hooks/use-compact-viewport", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@bb/shared-ui/hooks/use-compact-viewport")
  >()),
  useIsCompactViewport: () => false,
}));
vi.mock("./ThreadDetailSecondaryContent", async () => {
  const { ContractSecondaryPanel } =
    await import("@/test/panel-controller-contract");
  return {
    ThreadDetailSecondaryContent: ({
      main,
      secondaryPanel,
    }: {
      main: ReactNode;
      secondaryPanel: Parameters<typeof ContractSecondaryPanel>[0];
    }) => (
      <>
        {main}
        <ContractSecondaryPanel {...secondaryPanel} />
      </>
    ),
  };
});
vi.mock("./ThreadDetailHeader", () => ({ ThreadDetailHeader: () => null }));
vi.mock("./DeferredThreadDetailPromptArea", async () => {
  const { PluginContext } = await import("@/components/plugin/plugin-context");
  const { ContractPanelProbe } =
    await import("@/test/panel-controller-contract");
  return {
    DeferredThreadDetailPromptArea: () => (
      <PluginContext.Provider value={CONTRACT_PLUGIN_ID}>
        <ContractPanelProbe probe={fixtures.probe} />
      </PluginContext.Provider>
    ),
  };
});
vi.mock("./useThreadDetailThread", () => ({
  useThreadDetailThread: () => ({
    hasThreadDetailBootstrapSettled: true,
    thread: THREAD,
    threadDetailBootstrapQuery: { isFetching: false },
    threadQuery: {
      data: THREAD,
      isFetching: false,
      isLoadingError: false,
      error: null,
    },
    unreadDividerState: { ready: true, anchor: null },
  }),
}));
vi.mock("@/hooks/queries/environment-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/queries/environment-queries")
  >()),
  useEnvironment: () => ({
    data: ENVIRONMENT,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

describePanelControllerContract(
  "thread view",
  { fixedTabs: true },
  async () => {
    const probe = fixtures.probe;
    probe.current = null;
    const sink: ContractStateSink = { current: null };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(threadQueryKey(THREAD.id), THREAD);
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <DefaultPaneContextProvider
              paneId="main"
              onRequestClose={null}
              navigateInPane={() => {}}
            >
              <ContractStateProbe
                panelStateId={THREAD.id}
                syncThreadId={THREAD.id}
                sink={sink}
              />
              <ThreadDetailView
                surface="pane"
                projectId={THREAD.projectId}
                threadId={THREAD.id}
                timelineEnabled={false}
              />
            </DefaultPaneContextProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );
    render(
      <QueryClientProvider client={client}>
        <Provider>
          <RouterProvider router={router} />
        </Provider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(snapshotFromState(sink).tabIds).toEqual(
        expect.arrayContaining([
          createThreadInfoFixedPanelTab().id,
          pluginFixedTabId("summary"),
        ]),
      ),
    );
    return {
      panel: () => readContractPanel(probe),
      snapshot: () => snapshotFromState(sink),
      tabs: () => readContractTabs(probe),
      renderedTabVisible: () =>
        screen.queryByTestId("contract-tab-visible")?.textContent ?? null,
      renderedTarget: () =>
        screen.queryByTestId("contract-target")?.textContent ?? null,
      command: (id) => appCommandHandlers.get(id)?.() !== false,
      action: { tab: actionTab, panelTabId: contractActionPanelTabId("chat") },
      fixed: {
        targeted: { tab: targetedTab, panelTabId: pluginFixedTabId("summary") },
        untargeted: {
          tab: untargetedTab,
          panelTabId: pluginFixedTabId("notes"),
        },
      },
      foreignTab: {
        id: "chat",
        context: { kind: "nav-panel", panelId: "board" },
        availability: "action",
      },
      toggleRestoresActiveTab: true,
    };
  },
);

const targetedTab = {
  id: "summary",
  context: { kind: "thread" },
  availability: "fixed",
} as const;
const untargetedTab = { ...targetedTab, id: "notes" } as const;
const actionTab = {
  id: "chat",
  context: { kind: "thread" },
  availability: "action",
} as const;

function pluginFixedTabId(tabId: string) {
  return createPluginFixedPanelTab({ pluginId: CONTRACT_PLUGIN_ID, tabId }).id;
}

beforeEach(() => {
  markPluginFrontendsSettled();
  appCommandHandlers.clear();
  window.localStorage.clear();
  resetFixedPanelTabsStateForTest();
  resetPluginSlotStoreForTest();
  setPluginSlotRegistrations(
    CONTRACT_PLUGIN_ID,
    collectPluginAppRegistrations(
      definePluginApp((app) => {
        app.slots.experimental_tab({
          ...targetedTab,
          title: "Summary",
          icon: "Info",
          component: () => <ContractTargetedFixedTab tab={targetedTab} />,
          experimental_target: contractTarget,
        });
        app.slots.experimental_tab({
          ...untargetedTab,
          title: "Notes",
          icon: "Note",
          component: () => <div>Notes</div>,
        });
        app.slots.experimental_tab({
          ...actionTab,
          title: "Chat",
          icon: "Chat",
          component: ContractActionTab,
        });
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetFocusedAppPanelControllersForTest();
});
