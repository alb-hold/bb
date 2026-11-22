// @vitest-environment jsdom

import { observeSidebarPageScroll } from "@/lib/sidebar-page-scroll";
import { createElement, useEffect, useRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { useAtomValue } from "jotai";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { sidebarBootstrapResponseSchema } from "@bb/server-contract";
import { afterEach, expect, it, vi } from "vitest";
import { withTestHarness } from "../../../../server/test/helpers/test-app.js";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { SidebarThreadEntriesProvider } from "@/lib/sidebar-thread-entries";
import { useSidebarThreads } from "@/lib/plugin-sidebar-hooks";
import { invalidateRealtimeQueriesFetchedBeforeInitialConnect } from "@/hooks/cache-owners/system-cache-effects";
import { patchThreadEntity } from "@/hooks/cache-owners/thread-entity-store";
import { sidebarNavigationQueryKey } from "./query-keys";
import {
  SIDEBAR_BOOTSTRAP_CACHE_KEY,
  readCachedSidebarBootstrap,
  resetSidebarBootstrapCacheForTest,
  writeCachedSidebarBootstrap,
} from "@/lib/sidebar-bootstrap-cache";
import { mobileRecentsCollapsedThreadIdsAtom } from "@/views/mobile-recents-collapse";
import { getMobileRecentThreads } from "@/views/root-compose-recent-threads";
import { useMobileRecentsThreadReveal } from "@/views/useMobileRecentsThreadReveal";
import {
  useSidebarNavigation,
  useSidebarNavigationPaging,
  useSidebarNavigationPreview,
} from "./sidebar-navigation-query";
import {
  SelectedSidebarThreadIdProvider,
  useSidebarNavigationPreviewWithSelected,
} from "./sidebar-selected-thread-projection";

const routeState = vi.hoisted(() => ({
  threadId: undefined as string | undefined,
}));

vi.mock("../../../../server/test/helpers/provider-registry.js", () => ({
  registerFirstPartyProviders: vi.fn(),
}));
vi.mock("../../../../server/src/install-machine-asset.js", async () => {
  const { resolve } = await import("node:path");
  const assets = resolve(import.meta.dirname, "../../../../server/src/assets");
  return {
    INSTALL_MACHINE_SCRIPT_PATH: resolve(assets, "install-machine.sh"),
    INSTALL_MACHINE_WINDOWS_SCRIPT_PATH: resolve(
      assets,
      "install-machine-windows.mjs",
    ),
  };
});
vi.mock("@/hooks/useRouteState", () => ({
  useRouteState: () =>
    routeState.threadId === undefined ? {} : { threadId: routeState.threadId },
}));
vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useEnvironmentListRealtimeSubscription: vi.fn(),
  useHostListRealtimeSubscription: vi.fn(),
  useProjectListRealtimeSubscription: vi.fn(),
  useThreadListRealtimeSubscription: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  routeState.threadId = undefined;
  resetSidebarBootstrapCacheForTest();
});

it.each(["unread", "collapse", "counts"] as const)(
  "keeps %s state consistent while the next navigation page is demanded",
  async (goal) => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async ({ app, db }) => {
        const parentId = "thr_paging_parent";
        const childId = "thr_paging_child";
        const insert = db.$client.prepare(
          "INSERT INTO threads (id, project_id, provider_id, status, parent_thread_id, created_at, updated_at, last_read_at, latest_attention_at, archived_at) VALUES (?, ?, 'codex', 'idle', ?, ?, 1, 1, ?, ?)",
        );
        insert.run(parentId, PERSONAL_PROJECT_ID, null, 100, 1, null);
        for (let i = 0; i < 24; i++) {
          insert.run("thr_page_" + i, PERSONAL_PROJECT_ID, null, 50, 1, null);
        }
        insert.run(childId, PERSONAL_PROJECT_ID, parentId, 1, 2, null);
        insert.run("thr_history", PERSONAL_PROJECT_ID, null, 0, 1, 10);
        const expected = sidebarBootstrapResponseSchema.parse(
          await (await app.request("/api/v1/sidebar-bootstrap")).json(),
        );
        const expectedIds = expected.personalProject.threads.map(
          (row) => row.id,
        );
        expect(expectedIds).toHaveLength(26);
        expect(expectedIds.at(-1)).toBe(childId);
        const storageKey = "bb.mobileRecents.collapsedThreads";
        window.localStorage.setItem(storageKey, JSON.stringify([parentId]));
        const fetchUrls: string[] = [];
        vi.stubGlobal(
          "fetch",
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const req = new Request(input, init);
            fetchUrls.push(req.url);
            return app.fetch(req);
          },
        );
        const { wrapper, queryClient } = createQueryClientTestHarness();
        const observedCounts = new Set<number>();
        const { result } = renderHook(
          () => {
            useMobileRecentsThreadReveal();
            const navigation = useSidebarNavigation();
            const preview = useSidebarNavigationPreview();
            const paging = useSidebarNavigationPaging();
            const collapsed = useAtomValue(mobileRecentsCollapsedThreadIdsAtom);
            const rows = navigation.data?.personalProject.threads;
            if (rows) observedCounts.add(rows.length);
            return { rows, preview, paging, collapsed };
          },
          { wrapper },
        );
        await waitFor(() =>
          expect(
            result.current.preview?.personalProject.threads,
          ).toHaveLength(25),
        );
        expect(fetchUrls).toHaveLength(1);
        expect(new URL(fetchUrls[0]!).searchParams.get("cursor")).toBeNull();
        expect(new URL(fetchUrls[0]!).searchParams.get("overview")).toBe("true");
        const overview = result.current.preview?.overview;
        expect(overview?.counts[PERSONAL_PROJECT_ID]).toBe(26);
        expect(overview?.unreadTree.map((row) => row.id).sort()).toEqual(
          [childId, parentId].sort(),
        );
        expect(
          overview?.unreadTree.find((row) => row.id === childId)
            ?.parentThreadId,
        ).toBe(parentId);
        expect(result.current.collapsed).toContain(parentId);
        expect(result.current.paging.hasNextPage).toBe(true);
        expect(
          queryClient.getQueryData(sidebarNavigationQueryKey()),
        ).toBeUndefined();
        expect(
          window.localStorage.getItem(SIDEBAR_BOOTSTRAP_CACHE_KEY),
        ).toBeNull();
        if (goal === "unread") expect(result.current.rows).toBeUndefined();

        await act(async () => {
          await result.current.paging.fetchNextPage();
        });
        await waitFor(() =>
          expect(result.current.rows?.map((row) => row.id)).toEqual(
            expectedIds,
          ),
        );
        expect(fetchUrls).toHaveLength(2);
        expect(new URL(fetchUrls[1]!).searchParams.get("cursor")).toBeTruthy();
        expect(new URL(fetchUrls[1]!).searchParams.get("overview")).toBeNull();
        expect(result.current.paging.hasNextPage).toBe(false);
        expect(result.current.preview).toBeNull();
        if (goal === "unread") {
          expect(result.current.collapsed).toContain(parentId);
        } else if (goal === "collapse") {
          expect(window.localStorage.getItem(storageKey)).toBe(
            JSON.stringify([parentId]),
          );
        } else {
          expect([...observedCounts]).toEqual([expectedIds.length]);
        }
      },
    );
  },
);

it("loads page 1 while idle, advances to page 2 on scroll, and commits complete only after the final page", async () => {
  await withTestHarness(
    { seedFirstPartyProviders: false },
    async ({ app, db }) => {
      const insert = db.$client.prepare(
        "INSERT INTO threads (id, project_id, provider_id, status, parent_thread_id, created_at, updated_at, last_read_at, latest_attention_at, archived_at) VALUES (?, ?, 'codex', 'idle', NULL, ?, 1, 1, 1, ?)",
      );
      for (let i = 0; i < 52; i++) {
        insert.run(`thr_active_${String(i).padStart(2, "0")}`, PERSONAL_PROJECT_ID, 200 - i, null);
      }
      for (let i = 0; i < 5; i++) {
        insert.run(`thr_archived_${i}`, PERSONAL_PROJECT_ID, 10 - i, 100);
      }
      const bareComplete = sidebarBootstrapResponseSchema.parse(
        await (await app.request("/api/v1/sidebar-bootstrap")).json(),
      );
      const expectedIds = bareComplete.personalProject.threads.map(
        (row) => row.id,
      );
      expect(expectedIds).toHaveLength(52);

      const fetchUrls: string[] = [];
      vi.stubGlobal(
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const req = new Request(input, init);
          fetchUrls.push(req.url);
          return app.fetch(req);
        },
      );

      const { wrapper, queryClient } = createQueryClientTestHarness();
      let latest!: {
        completeIds: string[] | undefined;
        previewCount: number | undefined;
        overviewCount: number | undefined;
        hasNextPage: boolean;
      };

      function ScrollableSidebarHarness() {
        const scrollerRef = useRef<HTMLDivElement>(null);
        const navigation = useSidebarNavigation();
        const preview = useSidebarNavigationPreview();
        const paging = useSidebarNavigationPaging();
        latest = {
          completeIds: navigation.data?.personalProject.threads.map(
            (row) => row.id,
          ),
          previewCount: preview?.personalProject.threads.length,
          overviewCount: preview?.overview?.counts[PERSONAL_PROJECT_ID],
          hasNextPage: paging.hasNextPage,
        };
        useEffect(() => {
          const el = scrollerRef.current;
          if (!el || !paging.hasNextPage || paging.isFetchingNextPage) return;
          return observeSidebarPageScroll(el, paging.fetchNextPage);
        }, [paging.fetchNextPage, paging.hasNextPage, paging.isFetchingNextPage]);
        return createElement("div", {
          ref: scrollerRef,
          "data-testid": "sidebar-scroller",
        });
      }

      const view = render(createElement(ScrollableSidebarHarness), { wrapper });
      const scroller = view.getByTestId("sidebar-scroller");
      Object.defineProperty(scroller, "scrollHeight", {
        configurable: true,
        value: 1000,
      });
      Object.defineProperty(scroller, "clientHeight", {
        configurable: true,
        value: 300,
      });
      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        writable: true,
        value: 0,
      });

      await waitFor(() => expect(latest.previewCount).toBe(25));
      fireEvent.scroll(scroller);
      await act(async () => {
        await Promise.resolve();
      });
      expect(fetchUrls).toHaveLength(1);
      expect(latest.overviewCount).toBe(52);
      expect(latest.hasNextPage).toBe(true);
      expect(latest.completeIds).toBeUndefined();
      expect(
        queryClient.getQueryData(sidebarNavigationQueryKey()),
      ).toBeUndefined();
      expect(readCachedSidebarBootstrap()).toBeNull();
      expect(
        window.localStorage.getItem(SIDEBAR_BOOTSTRAP_CACHE_KEY),
      ).toBeNull();

      scroller.scrollTop = 700;
      fireEvent.scroll(scroller);
      await waitFor(() => expect(latest.previewCount).toBe(50));
      expect(fetchUrls).toHaveLength(2);
      const cursor1 = new URL(fetchUrls[1]!).searchParams.get("cursor");
      expect(cursor1).toBeTruthy();
      expect(new URL(fetchUrls[1]!).searchParams.get("overview")).toBeNull();
      expect(latest.overviewCount).toBe(52);
      expect(latest.hasNextPage).toBe(true);
      expect(latest.completeIds).toBeUndefined();
      expect(
        queryClient.getQueryData(sidebarNavigationQueryKey()),
      ).toBeUndefined();
      expect(readCachedSidebarBootstrap()).toBeNull();

      scroller.scrollTop = 750;
      fireEvent.scroll(scroller);
      await waitFor(() => expect(latest.completeIds).toEqual(expectedIds));
      expect(fetchUrls).toHaveLength(3);
      const cursor2 = new URL(fetchUrls[2]!).searchParams.get("cursor");
      expect(cursor2).toBeTruthy();
      expect(cursor2).not.toBe(cursor1);
      expect(latest.hasNextPage).toBe(false);
      expect(latest.previewCount).toBeUndefined();
      expect(
        queryClient.getQueryData(sidebarNavigationQueryKey()),
      ).toBeDefined();
      expect(readCachedSidebarBootstrap()).not.toBeNull();
    },
  );
});

it("prefers fresh multi-page partial overview over warm placeholder and clears seeded complete cache on realtime invalidation", async () => {
  await withTestHarness(
    { seedFirstPartyProviders: false },
    async ({ app, db }) => {
      const insert = db.$client.prepare(
        "INSERT INTO threads (id, project_id, provider_id, status, parent_thread_id, created_at, updated_at, last_read_at, latest_attention_at, archived_at) VALUES (?, ?, 'codex', 'idle', ?, ?, 1, 1, ?, NULL)",
      );
      insert.run("thr_seed_0", PERSONAL_PROJECT_ID, null, 300, 1);
      const oldComplete = sidebarBootstrapResponseSchema.parse(
        await (await app.request("/api/v1/sidebar-bootstrap")).json(),
      );
      expect(oldComplete.personalProject.threads).toHaveLength(1);

      const parentId = "thr_warm_parent";
      const childId = "thr_warm_child";
      insert.run(parentId, PERSONAL_PROJECT_ID, null, 200, 1);
      for (let i = 0; i < 23; i++) {
        insert.run(`thr_warm_${i}`, PERSONAL_PROJECT_ID, null, 150 - i, 1);
      }
      insert.run(childId, PERSONAL_PROJECT_ID, parentId, 1, 2);

      writeCachedSidebarBootstrap(oldComplete);
      const warmReads = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) =>
          app.fetch(new Request(input, init)),
      );
      vi.stubGlobal("fetch", warmReads);
      const warmHarness = createQueryClientTestHarness();
      const warm = renderHook(
        () => {
          const navigation = useSidebarNavigation();
          const preview = useSidebarNavigationPreview();
          const paging = useSidebarNavigationPaging();
          return { navigation, preview, paging };
        },
        { wrapper: warmHarness.wrapper },
      );
      await waitFor(() =>
        expect(
          warm.result.current.preview?.personalProject.threads,
        ).toHaveLength(25),
      );
      expect(warmReads).toHaveBeenCalledTimes(1);
      expect(warm.result.current.navigation.isPlaceholderData).toBe(true);
      expect(
        warmHarness.queryClient.getQueryData(sidebarNavigationQueryKey()),
      ).toBeUndefined();
      expect(
        warm.result.current.preview?.overview?.counts[PERSONAL_PROJECT_ID],
      ).toBe(26);
      expect(
        warm.result.current.preview?.overview?.unreadTree
          .map((row) => row.id)
          .sort(),
      ).toEqual([childId, parentId].sort());
      warm.unmount();

      resetSidebarBootstrapCacheForTest();
      window.localStorage.clear();
      const seededReads = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) =>
          app.fetch(new Request(input, init)),
      );
      vi.stubGlobal("fetch", seededReads);
      const seededHarness = createQueryClientTestHarness();
      seededHarness.queryClient.setQueryData(
        sidebarNavigationQueryKey(),
        oldComplete,
      );
      const seeded = renderHook(
        () => {
          const navigation = useSidebarNavigation();
          const preview = useSidebarNavigationPreview();
          const paging = useSidebarNavigationPaging();
          return { navigation, preview, paging };
        },
        { wrapper: seededHarness.wrapper },
      );
      expect(seeded.result.current.navigation.data).toEqual(oldComplete);
      expect(seededReads).toHaveBeenCalledTimes(0);

      await act(async () => {
        await seededHarness.queryClient.invalidateQueries({
          queryKey: sidebarNavigationQueryKey(),
        });
      });
      await waitFor(() =>
        expect(
          seeded.result.current.preview?.personalProject.threads,
        ).toHaveLength(25),
      );
      expect(seededReads).toHaveBeenCalledTimes(1);
      expect(
        seededHarness.queryClient.getQueryData(sidebarNavigationQueryKey()),
      ).toBeUndefined();
      expect(seeded.result.current.navigation.data).toBeUndefined();
      expect(
        seeded.result.current.preview?.overview?.counts[PERSONAL_PROJECT_ID],
      ).toBe(26);
      expect(seeded.result.current.paging.hasNextPage).toBe(true);

      await act(async () => {
        await seeded.result.current.paging.fetchNextPage();
      });
      await waitFor(() =>
        expect(
          seeded.result.current.navigation.data?.personalProject.threads,
        ).toHaveLength(26),
      );
      expect(seededReads).toHaveBeenCalledTimes(2);
      expect(seeded.result.current.preview).toBeNull();
      expect(seeded.result.current.paging.hasNextPage).toBe(false);
    },
  );
});

it("requests the idle Home sidebar once when realtime connects during warm replay", async () => {
  await withTestHarness({ seedFirstPartyProviders: false }, async ({ app }) => {
    const snapshot = sidebarBootstrapResponseSchema.parse(
      await (await app.request("/api/v1/sidebar-bootstrap")).json(),
    );
    writeCachedSidebarBootstrap(snapshot);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const reads = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        await pending;
        return app.fetch(new Request(input, init));
      },
    );
    vi.stubGlobal("fetch", reads);
    const { wrapper, queryClient } = createQueryClientTestHarness();
    function HomeNavigation() {
      const navigation = useSidebarNavigation();
      return createElement(SidebarThreadEntriesProvider, {
        navigation: navigation.data,
        children: null,
      });
    }
    render(createElement(HomeNavigation), { wrapper });
    try {
      await waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
      act(() =>
        invalidateRealtimeQueriesFetchedBeforeInitialConnect({
          queryClient,
          connectedAt: Date.now() + 1,
        }),
      );
      expect(
        queryClient.getQueryData(sidebarNavigationQueryKey()),
      ).toBeUndefined();
    } finally {
      await act(async () => {
        finish();
      });
    }
    await waitFor(() =>
      expect(
        queryClient.getQueryData(sidebarNavigationQueryKey()),
      ).toBeDefined(),
    );
    expect(reads).toHaveBeenCalledTimes(1);
  });
});

it("reports off-page child counts and unread rollups on page 1 while excluding archived and hidden children", async () => {
  await withTestHarness(
    { seedFirstPartyProviders: false },
    async ({ app, db }) => {
      const parentId = "thr_offpage_parent";
      const unreadErrorChildId = "thr_offpage_child_error";
      const readChildId = "thr_offpage_child_read";
      const insert = db.$client.prepare(
        "INSERT INTO threads (id, project_id, provider_id, status, parent_thread_id, visibility, created_at, updated_at, last_read_at, latest_attention_at, archived_at) VALUES (?, ?, 'codex', ?, ?, ?, ?, 1, ?, ?, ?)",
      );
      insert.run(
        parentId,
        PERSONAL_PROJECT_ID,
        "idle",
        null,
        "visible",
        300,
        1,
        1,
        null,
      );
      for (let i = 0; i < 24; i++) {
        insert.run(
          `thr_filler_${i}`,
          PERSONAL_PROJECT_ID,
          "idle",
          null,
          "visible",
          200 - i,
          1,
          1,
          null,
        );
      }
      insert.run(
        unreadErrorChildId,
        PERSONAL_PROJECT_ID,
        "error",
        parentId,
        "visible",
        2,
        1,
        5,
        null,
      );
      insert.run(
        readChildId,
        PERSONAL_PROJECT_ID,
        "idle",
        parentId,
        "visible",
        1,
        5,
        5,
        null,
      );
      insert.run(
        "thr_archived_child",
        PERSONAL_PROJECT_ID,
        "error",
        parentId,
        "visible",
        1,
        1,
        5,
        100,
      );
      insert.run(
        "thr_hidden_child",
        PERSONAL_PROJECT_ID,
        "error",
        parentId,
        "hidden",
        1,
        1,
        5,
        null,
      );

      const fetchUrls: string[] = [];
      vi.stubGlobal(
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const req = new Request(input, init);
          fetchUrls.push(req.url);
          return app.fetch(req);
        },
      );
      const { wrapper } = createQueryClientTestHarness();
      const { result } = renderHook(
        () => {
          useSidebarNavigation();
          return useSidebarNavigationPreview();
        },
        { wrapper },
      );

      await waitFor(() =>
        expect(result.current?.personalProject.threads).toHaveLength(25),
      );
      expect(fetchUrls).toHaveLength(1);
      const overview = result.current?.overview;
      expect(overview?.counts[PERSONAL_PROJECT_ID]).toBe(27);
      expect(overview?.childCounts?.[parentId]).toBe(2);
      const errorEntry = overview?.unreadTree.find(
        (entry) => entry.id === unreadErrorChildId,
      );
      expect(errorEntry).toMatchObject({
        id: unreadErrorChildId,
        parentThreadId: parentId,
        projectId: PERSONAL_PROJECT_ID,
        status: "error",
      });

      const mobileRows = getMobileRecentThreads({
        collapsedThreadIds: new Set([parentId]),
        draftThreadIds: new Set(),
        threads: result.current!.personalProject.threads,
        overview,
      });
      const parentRow = mobileRows.find((row) => row.thread.id === parentId);
      expect(parentRow?.hasChildren).toBe(true);
      expect(parentRow?.isCollapsed).toBe(true);
      expect(parentRow?.childActivity.unread).toBe(true);
      expect(parentRow?.childActivity.unreadError).toBe(true);
    },
  );
});

it.each(["archived", "hidden", "active-offpage"] as const)(
  "resolves %s selected thread reveal via targeted reads without draining active sidebar pages",
  async (kind) => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async ({ app, db }) => {
        const parentId = "thr_targeted_parent";
        const activeChildId = "thr_targeted_active_child";
        const archivedChildId = "thr_targeted_archived_child";
        const hiddenChildId = "thr_targeted_hidden_child";
        const insert = db.$client.prepare(
          "INSERT INTO threads (id, project_id, provider_id, status, parent_thread_id, visibility, created_at, updated_at, last_read_at, latest_attention_at, archived_at) VALUES (?, ?, 'codex', 'idle', ?, ?, ?, 1, 1, 1, ?)",
        );
        insert.run(
          parentId,
          PERSONAL_PROJECT_ID,
          null,
          "visible",
          300,
          null,
        );
        for (let i = 0; i < 24; i++) {
          insert.run(
            `thr_targeted_filler_${i}`,
            PERSONAL_PROJECT_ID,
            null,
            "visible",
            200 - i,
            null,
          );
        }
        insert.run(
          activeChildId,
          PERSONAL_PROJECT_ID,
          parentId,
          "visible",
          1,
          null,
        );
        insert.run(
          archivedChildId,
          PERSONAL_PROJECT_ID,
          parentId,
          "visible",
          1,
          100,
        );
        insert.run(
          hiddenChildId,
          PERSONAL_PROJECT_ID,
          parentId,
          "hidden",
          1,
          null,
        );

        const storageKey = "bb.mobileRecents.collapsedThreads";
        window.localStorage.setItem(storageKey, JSON.stringify([parentId]));
        routeState.threadId =
          kind === "archived"
            ? archivedChildId
            : kind === "hidden"
              ? hiddenChildId
              : activeChildId;

        const fetchUrls: string[] = [];
        vi.stubGlobal(
          "fetch",
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const req = new Request(input, init);
            fetchUrls.push(req.url);
            return app.fetch(req);
          },
        );

        const { wrapper, queryClient } = createQueryClientTestHarness();
        const { result } = renderHook(
          () => {
            useMobileRecentsThreadReveal();
            const preview = useSidebarNavigationPreviewWithSelected(
              routeState.threadId,
            );
            const collapsed = useAtomValue(mobileRecentsCollapsedThreadIdsAtom);
            return { preview, collapsed };
          },
          { wrapper },
        );

        await waitFor(() =>
          expect(
            result.current.preview?.personalProject.threads.length ?? 0,
          ).toBeGreaterThanOrEqual(25),
        );
        if (kind === "active-offpage") {
          await waitFor(() =>
            expect(
              result.current.preview?.personalProject.threads.some(
                (row) => row.id === activeChildId,
              ),
            ).toBe(true),
          );
          await waitFor(() =>
            expect(result.current.collapsed).not.toContain(parentId),
          );
          const mobileRows = getMobileRecentThreads({
            collapsedThreadIds: new Set(result.current.collapsed),
            draftThreadIds: new Set(),
            threads: result.current.preview!.personalProject.threads,
            overview: result.current.preview!.overview,
          });
          expect(mobileRows.some((row) => row.thread.id === activeChildId)).toBe(
            true,
          );
        } else {
          await waitFor(() =>
            expect(
              fetchUrls.some(
                (url) =>
                  url.includes("/api/v1/threads") &&
                  url.includes(`threadIds=${routeState.threadId}`),
              ),
            ).toBe(true),
          );
          await act(async () => {
            await Promise.resolve();
          });
          expect(result.current.collapsed).toContain(parentId);
          expect(
            result.current.preview?.personalProject.threads.some(
              (row) => row.id === routeState.threadId,
            ),
          ).toBe(false);
          expect(
            fetchUrls.some((url) => url.includes("/api/v1/threads/ancestors")),
          ).toBe(false);
        }

        const sidebarBootstrapCalls = fetchUrls.filter((url) =>
          url.includes("/api/v1/sidebar-bootstrap"),
        );
        expect(sidebarBootstrapCalls).toHaveLength(1);
        expect(
          new URL(sidebarBootstrapCalls[0]!).searchParams.get("cursor"),
        ).toBeNull();
        expect(
          queryClient.getQueryData(sidebarNavigationQueryKey()),
        ).toBeUndefined();
      },
    );
  },
);

it("renders off-page selected root and nested child rows on both desktop sidebar and mobile without draining active pages, preserving reactive patches and selection switching", async () => {
  await withTestHarness(
    { seedFirstPartyProviders: false },
    async ({ app, db }) => {
      const grandparentId = "thr_proj_grandparent";
      const offpageRootId = "thr_proj_offpage_root";
      const offpageParentId = "thr_proj_offpage_parent";
      const offpageChildId = "thr_proj_offpage_child";
      const insert = db.$client.prepare(
        "INSERT INTO threads (id, project_id, provider_id, title, status, parent_thread_id, visibility, created_at, updated_at, last_read_at, latest_attention_at, archived_at) VALUES (?, ?, 'codex', ?, 'idle', ?, 'visible', ?, 1, 1, 1, NULL)",
      );
      insert.run(grandparentId, PERSONAL_PROJECT_ID, "Grandparent", null, 300);
      for (let i = 0; i < 24; i++) {
        insert.run(
          `thr_proj_filler_${i}`,
          PERSONAL_PROJECT_ID,
          `Filler ${i}`,
          null,
          200 - i,
        );
      }
      insert.run(
        offpageRootId,
        PERSONAL_PROJECT_ID,
        "Off-page Root",
        null,
        3,
      );
      insert.run(
        offpageParentId,
        PERSONAL_PROJECT_ID,
        "Off-page Parent",
        grandparentId,
        2,
      );
      insert.run(
        offpageChildId,
        PERSONAL_PROJECT_ID,
        "Off-page Nested Child",
        offpageParentId,
        1,
      );

      const storageKey = "bb.mobileRecents.collapsedThreads";
      window.localStorage.setItem(
        storageKey,
        JSON.stringify([grandparentId, offpageParentId]),
      );

      const fetchUrls: string[] = [];
      vi.stubGlobal(
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const req = new Request(input, init);
          fetchUrls.push(req.url);
          return app.fetch(req);
        },
      );

      const { wrapper, queryClient } = createQueryClientTestHarness();

      function SidebarAndMobileSurface({
        selectedThreadId,
      }: {
        selectedThreadId: string | undefined;
      }) {
        return createElement(
          SelectedSidebarThreadIdProvider,
          { threadId: selectedThreadId, children: createElement(InnerSurface, { selectedThreadId }) },
        );
      }

      function InnerSurface({
        selectedThreadId,
      }: {
        selectedThreadId: string | undefined;
      }) {
        useMobileRecentsThreadReveal();
        const desktopSidebar = useSidebarThreads({
          experimental_lifecycles: ["active"],
          experimental_previewRows: true,
        });
        const mobilePreview =
          useSidebarNavigationPreviewWithSelected(selectedThreadId);
        const collapsed = useAtomValue(mobileRecentsCollapsedThreadIdsAtom);
        const mobileRows = mobilePreview
          ? getMobileRecentThreads({
              collapsedThreadIds: new Set(collapsed),
              draftThreadIds: new Set(),
              threads: mobilePreview.personalProject.threads,
              overview: mobilePreview.overview,
            })
          : [];
        return createElement(
          "div",
          null,
          createElement(
            "div",
            { "data-testid": "desktop-sidebar-rows" },
            desktopSidebar.threads.map((thread) =>
              createElement(
                "div",
                {
                  key: thread.id,
                  "data-desktop-row-id": thread.id,
                },
                thread.displayTitle,
              ),
            ),
          ),
          createElement(
            "div",
            { "data-testid": "mobile-recents-rows" },
            mobileRows.map((row) =>
              createElement(
                "div",
                {
                  key: row.thread.id,
                  "data-mobile-row-id": row.thread.id,
                },
                row.thread.title ?? row.thread.id,
              ),
            ),
          ),
          createElement(
            "div",
            { "data-testid": "paging-meta" },
            `${String(desktopSidebar.experimental_activePages?.hasNextPage)}:${String(desktopSidebar.experimental_activePages?.projectCounts?.[PERSONAL_PROJECT_ID])}`,
          ),
        );
      }

      routeState.threadId = offpageRootId;
      const view = render(
        createElement(SidebarAndMobileSurface, {
          selectedThreadId: offpageRootId,
        }),
        { wrapper },
      );

      await waitFor(() => {
        expect(
          view.container.querySelector(
            `[data-desktop-row-id="${offpageRootId}"]`,
          )?.textContent,
        ).toBe("Off-page Root");
        expect(
          view.container.querySelector(
            `[data-mobile-row-id="${offpageRootId}"]`,
          )?.textContent,
        ).toBe("Off-page Root");
      });
      expect(view.getByTestId("paging-meta").textContent).toBe("true:28");

      act(() => {
        patchThreadEntity(queryClient, offpageRootId, {
          title: "Off-page Root Updated",
        });
      });
      await waitFor(() => {
        expect(
          view.container.querySelector(
            `[data-desktop-row-id="${offpageRootId}"]`,
          )?.textContent,
        ).toBe("Off-page Root Updated");
        expect(
          view.container.querySelector(
            `[data-mobile-row-id="${offpageRootId}"]`,
          )?.textContent,
        ).toBe("Off-page Root Updated");
      });

      routeState.threadId = offpageChildId;
      view.rerender(
        createElement(SidebarAndMobileSurface, {
          selectedThreadId: offpageChildId,
        }),
      );

      await waitFor(() => {
        expect(
          view.container.querySelector(
            `[data-desktop-row-id="${offpageParentId}"]`,
          )?.textContent,
        ).toBe("Off-page Parent");
        expect(
          view.container.querySelector(
            `[data-desktop-row-id="${offpageChildId}"]`,
          )?.textContent,
        ).toBe("Off-page Nested Child");
        expect(
          view.container.querySelector(
            `[data-mobile-row-id="${offpageParentId}"]`,
          )?.textContent,
        ).toBe("Off-page Parent");
        expect(
          view.container.querySelector(
            `[data-mobile-row-id="${offpageChildId}"]`,
          )?.textContent,
        ).toBe("Off-page Nested Child");
      });
      expect(
        view.container.querySelector(
          `[data-desktop-row-id="${offpageRootId}"]`,
        ),
      ).toBeNull();
      expect(
        view.container.querySelector(`[data-mobile-row-id="${offpageRootId}"]`),
      ).toBeNull();

      const sidebarBootstrapCalls = fetchUrls.filter((url) =>
        url.includes("/api/v1/sidebar-bootstrap"),
      );
      expect(sidebarBootstrapCalls).toHaveLength(1);
      expect(
        new URL(sidebarBootstrapCalls[0]!).searchParams.get("cursor"),
      ).toBeNull();
      expect(view.getByTestId("paging-meta").textContent).toBe("true:28");
      expect(
        queryClient.getQueryData(sidebarNavigationQueryKey()),
      ).toBeUndefined();
    },
  );
});
