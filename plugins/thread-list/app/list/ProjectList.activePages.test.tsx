// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { makePluginProject, makeSidebarThread } from "../model/fixtures.js";
import { preferencesReadyAtom } from "../preferences/preferences-sync.js";
import { sidebarOrganizationModeAtom } from "../preferences/atoms.js";

installTestPluginRuntime();
const { ProjectList } = await import("./ProjectList.js");
const { resetSidebarDataCacheForTest } =
  await import("../model/use-sidebar-data.js");

afterEach(() => {
  cleanup();
  resetSidebarDataCacheForTest();
});

function Harness({
  children,
  store,
}: {
  children: ReactNode;
  store: ReturnType<typeof createStore>;
}) {
  return (
    <TooltipProvider>
      <Provider store={store}>{children}</Provider>
    </TooltipProvider>
  );
}

function renderPagedProject({
  fetchNextPage,
  isFetchNextPageError = false,
  isFetchingNextPage = false,
  loadedThreads,
}: {
  fetchNextPage: () => Promise<void>;
  isFetchNextPageError?: boolean;
  isFetchingNextPage?: boolean;
  loadedThreads: ReturnType<typeof makeSidebarThread>[];
}) {
  const store = createStore();
  store.set(preferencesReadyAtom(), true);
  store.set(sidebarOrganizationModeAtom, "project");
  return renderSlot(
    { component: Harness },
    { children: <ProjectList activeThreadId={null} />, store },
    {
      sidebarThreads: {
        threads: loadedThreads,
        projects: [
          makePluginProject({ id: "proj_early", name: "Early project" }),
          makePluginProject({ id: "proj_late", name: "Late project" }),
        ],
        experimental_activePages: {
          hasNextPage: true,
          isFetchingNextPage,
          isFetchNextPageError,
          fetchNextPage,
          projectCounts: { proj_early: 1, proj_late: 2 },
        },
      },
    },
  );
}

const earlyThread = makeSidebarThread({
  id: "thr_early",
  projectId: "proj_early",
  title: "Early thread",
});

describe("expanded project whose threads are on a later sidebar page", () => {
  it("requests the next page by itself instead of waiting for a click", () => {
    const fetchNextPage = vi.fn(() => Promise.resolve());
    renderPagedProject({ fetchNextPage, loadedThreads: [earlyThread] });
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("does not keep paging once every project has its threads", () => {
    const fetchNextPage = vi.fn(() => Promise.resolve());
    renderPagedProject({
      fetchNextPage,
      loadedThreads: [
        earlyThread,
        makeSidebarThread({
          id: "thr_late",
          projectId: "proj_late",
          title: "Late thread",
        }),
      ],
    });
    expect(screen.getByText("Late thread")).toBeTruthy();
    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it("leaves retry to the user after a failed page fetch", () => {
    const fetchNextPage = vi.fn(() => Promise.resolve());
    renderPagedProject({
      fetchNextPage,
      isFetchNextPageError: true,
      loadedThreads: [earlyThread],
    });
    expect(fetchNextPage).not.toHaveBeenCalled();
  });
});
