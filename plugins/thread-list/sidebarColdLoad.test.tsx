// @vitest-environment jsdom

import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makePluginProject, makeSidebarThread } from "./app/model/fixtures.js";
import { defaultPreferences } from "./shared/preferences.js";
import {
  resetPreferencesSyncForTest,
  setPreferencesMirrorStorageForTest,
} from "./app/preferences/preferences-sync.js";
import type { SidebarData } from "./app/model/use-sidebar-data.js";

const state = vi.hoisted(() => ({ data: null as SidebarData | null }));
vi.mock("./app/model/use-sidebar-data.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./app/model/use-sidebar-data.js")>()),
  useSidebarData: () => ({ ...state.data!, archived: null }),
}));
const { buildSidebarData } = await import("./app/model/use-sidebar-data.js");
const app = await loadPluginApp(() => import("./app"));
const registration = app.threadLists[0]!;
const project = makePluginProject({ id: "proj_personal", isPersonal: true });
const pinned = makeSidebarThread({
  id: "thr_pinned",
  projectId: project.id,
  title: "Pinned cold row",
  pinnedAt: 10,
  isPinned: true,
});
const thread = makeSidebarThread({
  id: "thr_regular",
  projectId: project.id,
  title: "Regular cold row",
});

afterEach(() => {
  cleanup();
  resetPreferencesSyncForTest();
  setPreferencesMirrorStorageForTest(undefined);
  vi.unstubAllGlobals();
});

it.each(["threads", "pinned"])(
  "paints both sections together when %s data arrives first, before resize delivery",
  async (first) => {
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    setPreferencesMirrorStorageForTest(null);
    state.data = buildSidebarData(
      "loading",
      [first === "threads" ? thread : pinned],
      [project],
      [],
    );
    const props = {
      activeThreadId: null,
      activeProjectId: null,
      isCompactViewport: false,
      onNavigate: vi.fn(),
      searchQuery: "",
    };
    const result = renderSlot(registration, props, {
      sidebarThreads: { projects: [project], threads: [pinned, thread] },
      rpc: {
        listPreferences: () => ({
          preferences: {
            ...defaultPreferences(),
            organizationMode: "chronological",
          },
        }),
      },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Loading sidebar navigation")).toBeTruthy(),
    );
    expect(screen.queryByText("Threads")).toBeNull();
    expect(screen.queryByText("Pinned cold row")).toBeNull();
    state.data = buildSidebarData("ready", [pinned, thread], [project], []);
    const Component = registration.component;
    result.rerender(<Component {...props} activeThreadId="thr_regular" />);
    await waitFor(() => expect(screen.getByText("Threads")).toBeTruthy());
    expect(screen.getByText("Pinned cold row")).toBeTruthy();
    const sections = () =>
      Array.from(
        document.querySelectorAll('[data-sidebar-sticky-tier="label"] [title]'),
        (el) => el.getAttribute("title"),
      );
    const firstPaint = sections();
    expect(firstPaint.indexOf("Pinned")).toBeLessThan(
      firstPaint.indexOf("Threads"),
    );
    act(() => {
      for (const callback of observers) callback([], {} as ResizeObserver);
    });
    expect(sections()).toEqual(firstPaint);
    expect(screen.getByText("Pinned cold row")).toBeTruthy();
  },
);

it.each([
  {
    label: "desktop expanded",
    compact: false,
    visible: true,
    activeThreadId: null,
  },
  {
    label: "phone home list",
    compact: true,
    visible: true,
    activeThreadId: null,
  },
  {
    label: "phone thread route",
    compact: true,
    visible: true,
    activeThreadId: "thr_regular",
  },
  {
    label: "phone closed drawer",
    compact: true,
    visible: false,
    activeThreadId: "thr_regular",
  },
  {
    label: "desktop collapsed",
    compact: false,
    visible: false,
    activeThreadId: null,
  },
])(
  "mounts pinned rows in the first visible commit only for $label",
  async ({ compact, visible, activeThreadId }) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    setPreferencesMirrorStorageForTest(null);
    state.data = buildSidebarData("ready", [pinned, thread], [project], []);
    renderSlot(
      registration,
      {
        activeThreadId,
        activeProjectId: null,
        isCompactViewport: compact,
        experimental_isVisible: visible,
        onNavigate: vi.fn(),
        searchQuery: "",
      },
      {
        sidebarThreads: { projects: [project], threads: [pinned, thread] },
        rpc: {
          listPreferences: () => ({
            preferences: {
              ...defaultPreferences(),
              organizationMode: "chronological",
            },
          }),
        },
      },
    );
    await waitFor(() => expect(screen.getByText("Threads")).toBeTruthy());
    expect(screen.queryByText("Pinned cold row") !== null).toBe(visible);
  },
);
