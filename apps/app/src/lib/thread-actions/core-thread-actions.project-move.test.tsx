// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ThreadListEntry } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSidebarThreads } from "@/lib/plugin-sidebar-hooks";
import { CORE_THREAD_ACTIONS } from "./core-thread-actions";

type Project = { id: string; name: string; threads: ThreadListEntry[] };

const state = vi.hoisted(() => ({
  data: undefined as
    | {
        sections: never[];
        projects: Project[];
        personalProject: Project;
      }
    | undefined,
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useArchivedThreads: () => ({
    data: undefined,
    isLoadingError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    fetchNextPage: vi.fn(async () => undefined),
  }),
}));

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => ({ data: state.data, isError: false }),
}));

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: [] }),
}));

vi.mock("@/components/thread/ThreadActionsProvider", () => ({
  useThreadActions: () => ({
    requestArchive: vi.fn(),
    requestDelete: vi.fn(),
    togglePin: vi.fn(),
    toggleRead: vi.fn(),
  }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

function moveToProjectData() {
  const action = CORE_THREAD_ACTIONS.find(
    (candidate) => candidate.id === "moveToProject",
  );
  if (action?.useData === undefined) throw new Error("moveToProject missing");
  return action.useData;
}

function render() {
  const useMoveData = moveToProjectData();
  return renderHook(
    () => ({
      move: useMoveData({ threadIds: [] }) as {
        projects: readonly { id: string; name: string }[];
        viewedThreadId: string | null;
        showMovedThread: (threadId: string, projectId: string) => void;
      },
      sidebar: useSidebarThreads(),
    }),
    { wrapper },
  );
}

afterEach(() => {
  cleanup();
  state.data = undefined;
});

describe("moveToProject data matches the sidebar threads source", () => {
  it("offers the same projects while the sidebar is loading", () => {
    state.data = undefined;
    const { result } = render();
    expect(result.current.sidebar.status).toBe("loading");
    expect(result.current.move.projects).toEqual(
      result.current.sidebar.projects.map(({ id, name }) => ({ id, name })),
    );
    expect(result.current.move.projects).toEqual([]);
    expect(result.current.move.viewedThreadId).toBeNull();
  });

  it("offers the same projects, in order, once the sidebar has settled", () => {
    state.data = {
      sections: [],
      projects: [
        { id: "proj_one", name: "One", threads: [] },
        { id: "proj_two", name: "Two", threads: [] },
      ],
      personalProject: { id: "personal", name: "Personal", threads: [] },
    };
    const { result } = render();
    expect(result.current.sidebar.status).toBe("ready");
    expect(result.current.move.projects).toEqual(
      result.current.sidebar.projects.map(({ id, name }) => ({ id, name })),
    );
    expect(result.current.move.projects.map((project) => project.id)).toEqual([
      "proj_one",
      "proj_two",
      "personal",
    ]);
  });
});
