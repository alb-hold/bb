// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { PERSONAL_PROJECT_ID, type ThreadListEntry } from "@bb/domain";
import {
  archiveThread,
  createEnvironment,
  createMigratedConnection,
  createProject,
  createThread,
  countThreads,
  upsertHost,
} from "../../../../packages/db/src/index.js";
import { noopNotifier } from "../../../../packages/db/src/notifier.js";
import type { SidebarBootstrapResponse } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "@/lib/api";
import {
  readCachedSidebarBootstrap,
  resetSidebarBootstrapCacheForTest,
  SIDEBAR_BOOTSTRAP_CACHE_KEY,
} from "@/lib/sidebar-bootstrap-cache";
import { stepMobileRecentsReveal, INITIAL_MOBILE_RECENTS_REVEAL_STATE } from "@/views/useMobileRecentsThreadReveal";
import { mobileRecentsCollapsedThreadIdsAtom } from "@/views/mobile-recents-collapse";
import { createStore } from "jotai";
import {
  fetchSidebarNavigation,
  sidebarNavigationPreviewQueryKey,
} from "./sidebar-navigation-query";
import { sidebarNavigationQueryKey } from "./query-keys";
import { makeProjectWithThreadsResponse } from "@/test/fixtures/projects";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, request: vi.fn() };
});

vi.mock("@/lib/api-server", () => ({
  apiClient: {
    "sidebar-bootstrap": {
      $get: vi.fn((_args, callback) => {
        const response = pageResponses.shift();
        callback?.(response);
        return Promise.resolve(response);
      }),
    },
  },
}));

let pageResponses: Response[] = [];
let releaseSecondPage: (() => void) | undefined;
let secondPageStarted: (() => void) | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function makePage(data: SidebarBootstrapResponse, nextCursor?: string) {
  return new Response(JSON.stringify(data), {
    headers: nextCursor ? { "X-BB-Next-Cursor": nextCursor } : {},
  });
}

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  resetSidebarBootstrapCacheForTest();
  pageResponses = [];
  releaseSecondPage = undefined;
  secondPageStarted = undefined;
});

describe("progressive sidebar snapshot", () => {
  it("keeps page two preview-only until final resolution, preserving unread child, collapsed group, and complete counts", async () => {
    const db = createMigratedConnection();
    try {
      const host = upsertHost(db, noopNotifier, { name: "Sidebar test host" });
      const { project } = createProject(db, noopNotifier, {
        name: "Sidebar test project",
        source: { type: "local_path", hostId: host.id, path: "/tmp/sidebar-page-test" },
      });
      const environment = createEnvironment(db, noopNotifier, {
        hostId: host.id,
        path: "/tmp/sidebar-page-test",
        projectId: project.id,
        providerOwnsPath: false,
        status: "ready",
      });
      const parent = createThread(db, noopNotifier, {
        projectId: project.id, environmentId: environment.id, providerId: "codex", status: "idle", title: "Collapsed parent",
      });
      const child = createThread(db, noopNotifier, {
        projectId: project.id, environmentId: environment.id, providerId: "codex", status: "idle", title: "Unread child", parentThreadId: parent.id,
      });
      const archived = createThread(db, noopNotifier, {
        projectId: project.id, environmentId: environment.id, providerId: "codex", status: "idle", title: "Archived row",
      });
      archiveThread(db, noopNotifier, archived.id);

      const parentEntry = { ...parent, archivedAt: null, deletedAt: null } as ThreadListEntry;
      const childEntry = { ...child, archivedAt: null, deletedAt: null, lastReadAt: 1, latestAttentionAt: 2 } as ThreadListEntry;
      const projectResponse = makeProjectWithThreadsResponse({ id: project.id, name: project.name });
      const emptyPersonal = makeProjectWithThreadsResponse({ id: PERSONAL_PROJECT_ID, kind: "personal", name: "Personal" });
      const first: SidebarBootstrapResponse = {
        sections: [],
        projects: [{ ...projectResponse, threads: [parentEntry] }],
        personalProject: emptyPersonal,
      };
      const second: SidebarBootstrapResponse = {
        sections: [],
        projects: [{ ...projectResponse, threads: [childEntry] }],
        personalProject: emptyPersonal,
      };
      const gate = deferred<void>();
      const started = deferred<void>();
      secondPageStarted = () => started.resolve();
      releaseSecondPage = () => gate.resolve();
      pageResponses = [makePage(first, "cursor-two"), makePage(second)];

      const queryClient = new QueryClient();
      const store = createStore();
      store.set(mobileRecentsCollapsedThreadIdsAtom, [parent.id]);
      const canonicalBefore = queryClient.getQueryData(sidebarNavigationQueryKey());
      const cacheBefore = readCachedSidebarBootstrap();
      expect(canonicalBefore).toBeUndefined();
      expect(cacheBefore).toBeNull();

      vi.mocked(request).mockImplementation(async (responsePromise, onResponse) => {
        const response = await responsePromise;
        onResponse?.(response);
        if (response.headers.get("X-BB-Next-Cursor")) {
          return JSON.parse(await response.text()) as SidebarBootstrapResponse;
        }
        secondPageStarted?.();
        await gate.promise;
        return JSON.parse(await response.text()) as SidebarBootstrapResponse;
      });

      const controller = new AbortController();
      const pending = fetchSidebarNavigation({ client: queryClient, signal: controller.signal });
      await started.promise;
      const preview = queryClient.getQueryData<SidebarBootstrapResponse>(sidebarNavigationPreviewQueryKey());
      expect(preview?.projects[0]?.threads.map(({ id }) => id)).toEqual([parent.id, child.id]);
      expect(queryClient.getQueryData(sidebarNavigationQueryKey())).toBeUndefined();
      expect(readCachedSidebarBootstrap()).toBeNull();
      expect(store.get(mobileRecentsCollapsedThreadIdsAtom)).toEqual([parent.id]);

      const resolved = deferred<SidebarBootstrapResponse>();
      void pending.then(resolved.resolve);
      releaseSecondPage?.();
      const complete = await resolved.promise;
      const completeThreads = complete.projects.flatMap(({ threads }) => threads);
      expect(completeThreads.map(({ id }) => id)).toEqual([parent.id, child.id]);
      expect(new Set(completeThreads.map(({ id }) => id)).size).toBe(completeThreads.length);
      expect(queryClient.getQueryData(sidebarNavigationQueryKey())).toEqual(complete);
      expect(queryClient.getQueryData(sidebarNavigationPreviewQueryKey())).toBeNull();
      expect(readCachedSidebarBootstrap()?.projects[0]?.threads.map(({ id }) => id)).toEqual([parent.id, child.id]);
      expect(countThreads(db, { projectId: project.id }).total).toBe(2);
      expect(countThreads(db, { projectId: project.id, includeArchived: true }).total).toBe(3);
      const reveal = stepMobileRecentsReveal(INITIAL_MOBILE_RECENTS_REVEAL_STATE, {
        isPlaceholderData: false,
        selectedThreadId: undefined,
        threads: completeThreads,
      });
      expect(reveal.ancestorIds).toEqual(new Set());
      expect(store.get(mobileRecentsCollapsedThreadIdsAtom)).toEqual([parent.id]);
      expect(window.localStorage.getItem(SIDEBAR_BOOTSTRAP_CACHE_KEY)).toBeNull();
    } finally {
      db.$client.close();
    }
  });
});
