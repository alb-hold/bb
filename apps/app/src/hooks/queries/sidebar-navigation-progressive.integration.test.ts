// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useAtomValue } from "jotai";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { sidebarBootstrapResponseSchema } from "@bb/server-contract";
import { afterEach, expect, it, vi } from "vitest";
import { withTestHarness } from "../../../../server/test/helpers/test-app.js";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { resetSidebarBootstrapCacheForTest } from "@/lib/sidebar-bootstrap-cache";
import { mobileRecentsCollapsedThreadIdsAtom } from "@/views/mobile-recents-collapse";
import { useMobileRecentsThreadReveal } from "@/views/useMobileRecentsThreadReveal";
import {
  useSidebarNavigation,
  useSidebarNavigationPreview,
} from "./sidebar-navigation-query";

vi.mock("../../../../server/test/helpers/provider-registry.js", () => ({
  registerFirstPartyProviders: vi.fn(),
}));
vi.mock("../../../../server/src/install-machine-asset.js", () => ({
  INSTALL_MACHINE_SCRIPT_PATH: "install-machine.sh",
  INSTALL_MACHINE_WINDOWS_SCRIPT_PATH: "install-machine-windows.mjs",
}));
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
  "keeps %s state consistent while the next navigation page is in flight",
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
        let resume = () => {};
        const gate = new Promise<void>((resolve) => {
          resume = resolve;
        });
        vi.stubGlobal(
          "fetch",
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init);
            if (new URL(request.url).searchParams.has("cursor")) await gate;
            return app.fetch(request);
          },
        );
        const { wrapper } = createQueryClientTestHarness();
        const observedCounts = new Set<number>();
        const { result } = renderHook(
          () => {
            useMobileRecentsThreadReveal();
            const navigation = useSidebarNavigation();
            const preview = useSidebarNavigationPreview();
            const collapsed = useAtomValue(mobileRecentsCollapsedThreadIdsAtom);
            const rows = navigation.data?.personalProject.threads;
            if (rows) observedCounts.add(rows.length);
            return { rows, preview, collapsed };
          },
          { wrapper },
        );
        try {
          await waitFor(() =>
            expect(
              result.current.preview?.personalProject.threads,
            ).toHaveLength(25),
          );
          expect(result.current.collapsed).toContain(parentId);
          if (goal === "unread") expect(result.current.rows).toBeUndefined();
        } finally {
          await act(async () => {
            resume();
          });
        }
        await waitFor(() =>
          expect(result.current.rows?.map((row) => row.id)).toEqual(
            expectedIds,
          ),
        );
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
