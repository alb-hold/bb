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
import { invalidateRealtimeQueriesFetchedBeforeInitialConnect } from "@/hooks/cache-owners/system-cache-effects";
import { sidebarNavigationQueryKey } from "./query-keys";
import {
  SIDEBAR_BOOTSTRAP_CACHE_KEY,
  readCachedSidebarBootstrap,
  resetSidebarBootstrapCacheForTest,
  writeCachedSidebarBootstrap,
} from "@/lib/sidebar-bootstrap-cache";
import { mobileRecentsCollapsedThreadIdsAtom } from "@/views/mobile-recents-collapse";
import { useMobileRecentsThreadReveal } from "@/views/useMobileRecentsThreadReveal";
import {
  useSidebarNavigation,
  useSidebarNavigationPaging,
  useSidebarNavigationPreview,
} from "./sidebar-navigation-query";

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
vi.mock("@/hooks/useRouteState", () => ({ useRouteState: () => ({}) }));
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
