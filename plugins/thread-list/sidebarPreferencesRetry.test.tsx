// @vitest-environment jsdom

import { cleanup, screen, waitFor } from "@testing-library/react";
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
const thread = makeSidebarThread({
  id: "thr_regular",
  projectId: project.id,
  title: "Regular row",
});

afterEach(() => {
  cleanup();
  resetPreferencesSyncForTest();
  setPreferencesMirrorStorageForTest(undefined);
});

it("leaves the loading skeleton when the first preferences load fails at startup", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  setPreferencesMirrorStorageForTest(null);
  state.data = buildSidebarData("ready", [thread], [project], []);
  let loads = 0;
  renderSlot(
    registration,
    {
      activeThreadId: null,
      activeProjectId: null,
      isCompactViewport: false,
      experimental_isVisible: true,
      onNavigate: vi.fn(),
      searchQuery: "",
    },
    {
      sidebarThreads: { projects: [project], threads: [thread] },
      rpc: {
        listPreferences: () => {
          loads += 1;
          if (loads === 1) {
            throw new Error(
              'plugin "thread-list" is not running (status: starting)',
            );
          }
          return { preferences: defaultPreferences() };
        },
      },
    },
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Loading sidebar navigation")).toBeTruthy(),
  );
  await waitFor(() => expect(screen.getByText("Regular row")).toBeTruthy(), {
    timeout: 5_000,
  });
  expect(screen.queryByLabelText("Loading sidebar navigation")).toBeNull();
  expect(loads).toBe(2);
}, 15_000);
