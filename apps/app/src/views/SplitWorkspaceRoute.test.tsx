// @vitest-environment jsdom

import { Suspense, useEffect } from "react";
import {
  cleanup,
  fireEvent,
  render as renderReact,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { threadQueryKey } from "@/hooks/queries/query-keys";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneContent } from "@/lib/split-layout";
import {
  paneContentForPathname,
  paneContentRoute,
} from "./thread-detail/splitThreadNavigation";
import SplitWorkspaceRoute from "./SplitWorkspaceRoute";

const workspaceLifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
const { queryClient, wrapper } = createQueryClientTestHarness();
function render(ui: ReactNode) {
  return renderReact(ui, { wrapper });
}
const { queueSplitDownload } = vi.hoisted(() => ({
  queueSplitDownload: vi.fn(),
}));

vi.mock("@/lib/split-prefetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/split-prefetch")>()),
  queueSplitDownload,
}));

afterEach(() => {
  cleanup();
  queryClient.clear();
});

vi.mock("./thread-detail/SplitThreadArea", () => ({
  SplitThreadArea: ({ routeContent }: { routeContent: PaneContent }) => {
    useEffect(() => {
      workspaceLifecycle.mounts += 1;
      return () => {
        workspaceLifecycle.unmounts += 1;
      };
    }, []);
    return (
      <output
        data-testid="route-content"
        data-subpath={
          routeContent.kind === "plugin-panel" ? routeContent.subPath : ""
        }
        data-route={paneContentRoute(routeContent)}
      >
        {routeContent.kind}
      </output>
    );
  },
}));

vi.mock("./LegacyProjectComposeRedirect", () => ({
  LegacyProjectComposeRedirect: () => <div>legacy redirect</div>,
}));

vi.mock("./ToolsView", () => ({
  PluginsView: ({ detailKey }: { detailKey?: string }) => (
    <output data-testid="tools-view">{detailKey ?? "overview"}</output>
  ),
}));

function NavigationControls() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/")}>compose</button>
      <button onClick={() => navigate("/plugins/docs/docs/work/today.md")}>
        plugin
      </button>
      <button onClick={() => navigate("/threads/thread-1")}>thread</button>
    </>
  );
}

describe("SplitWorkspaceRoute", () => {
  it.each([
    ["/threads/thr_cached", "/projects/proj_actual/threads/thr_cached"],
    [
      "/projects/proj_wrong/threads/thr_cached",
      "/projects/proj_wrong/threads/thr_cached",
    ],
  ])(
    "resolves only projectless route metadata before the pane mounts: %s",
    (path, expected) => {
      queryClient.setQueryData(
        threadQueryKey("thr_cached"),
        makeThreadResponse({ id: "thr_cached", projectId: "proj_actual" }),
      );
      render(
        <MemoryRouter initialEntries={[path]}>
          <SplitWorkspaceRoute />
        </MemoryRouter>,
      );
      expect(
        screen.getByTestId("route-content").getAttribute("data-route"),
      ).toBe(expected);
    },
  );

  it("does not fetch markdown renderer dependencies when home loads", () => {
    expect(queueSplitDownload).not.toHaveBeenCalledWith("markdown-html");
  });

  beforeEach(() => {
    workspaceLifecycle.mounts = 0;
    workspaceLifecycle.unmounts = 0;
  });

  it("preserves the workspace mount across focus-driven page URL changes", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <NavigationControls />
        <Routes>
          <Route path="*" element={<SplitWorkspaceRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("route-content").textContent).toBe("new-thread");

    fireEvent.click(screen.getByRole("button", { name: "plugin" }));
    expect(screen.getByTestId("route-content").textContent).toBe(
      "plugin-panel",
    );

    fireEvent.click(screen.getByRole("button", { name: "thread" }));
    expect(screen.getByTestId("route-content").textContent).toBe("thread");
    expect(workspaceLifecycle).toEqual({ mounts: 1, unmounts: 0 });
  });

  it("passes the plugin id from the full-window detail URL to PluginsView", async () => {
    render(
      <MemoryRouter initialEntries={["/plugins/github"]}>
        <Routes>
          <Route
            path="*"
            element={
              <Suspense fallback={null}>
                <SplitWorkspaceRoute />
              </Suspense>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect((await screen.findByTestId("tools-view")).textContent).toBe(
      "github",
    );
  });
});

describe.each([
  {
    surface: "pane navigation",
    readRoute(pathname: string) {
      const content = paneContentForPathname(pathname);
      if (content?.kind !== "plugin-panel") {
        throw new Error("Expected a plugin panel");
      }
      return { subPath: content.subPath, route: paneContentRoute(content) };
    },
  },
  {
    surface: "workspace route",
    readRoute(pathname: string) {
      const view = render(
        <MemoryRouter initialEntries={[pathname]}>
          <SplitWorkspaceRoute />
        </MemoryRouter>,
      );
      const output = view.getByTestId("route-content");
      const result = {
        subPath: output.getAttribute("data-subpath"),
        route: output.getAttribute("data-route"),
      };
      view.unmount();
      return result;
    },
  },
])("plugin URL round trips through $surface", ({ readRoute }) => {
  it.each([
    { path: "items/key%3A42" },
    { path: "items/key:42" },
    { path: "items/discount%25" },
    { path: "items/%D0%BF%D0%BB%D0%B0%D0%BD" },
    { path: "items/key%252Fpart" },
    { path: "items/key/part" },
    { path: "items/key%2Fpart", subPath: "items/key/part" },
    { path: "items/bad%ZZ" },
    { path: "" },
  ])(
    "keeps /plugins/notes/board/$path stable across five rounds",
    ({ path, subPath = path }) => {
      const expected = `/plugins/notes/board${subPath ? `/${subPath}` : ""}`;
      let pathname = `/plugins/notes/board${path ? `/${path}` : ""}`;
      for (let round = 0; round < 5; round += 1) {
        const parsed = readRoute(pathname);
        expect(parsed.subPath).toBe(subPath);
        expect(parsed.route).toBe(expected);
        if (parsed.route === null) {
          throw new Error("Expected a rebuilt plugin route");
        }
        pathname = parsed.route;
      }
    },
  );
});
