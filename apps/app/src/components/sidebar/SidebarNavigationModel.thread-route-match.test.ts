import { matchPath } from "react-router-dom";
import { getPluginPanelRoutePluginId } from "@/lib/route-paths";
import { describe, expect, it } from "vitest";
import { isThreadRoutePathname } from "./SidebarNavigationModel";

const THREAD_PATHNAMES = [
  "/threads/x",
  "/threads/x/",
  "/threads/x/sub",
  "/projects/p/threads/x",
  "/projects/p/threads/x/sub",
  "/threads",
  "/threads/",
  "/projects/p/threads",
  "/projects/p",
  "/THREADS/x",
  "/Projects/P/Threads/X",
  "/threadsX/y",
  "/projects//threads/x",
  "/threads//x",
  "/threads/a%2Fb",
  "/",
  "/settings",
];

const PLUGIN_PANEL_PATHS = [
  ["/plugins//panel", null],
  ["/plugins/garden//", null],
  ["/plugins/garden/panel/", "garden"],
] as const;

describe("SidebarNavigationModel thread route matching", () => {
  it.each(THREAD_PATHNAMES)("matches router semantics for %s", (pathname) => {
    expect(isThreadRoutePathname(pathname)).toBe(
      matchPath("/threads/:threadId/*", pathname) !== null ||
        matchPath("/projects/:projectId/threads/:threadId/*", pathname) !==
          null,
    );
  });

  it.each(PLUGIN_PANEL_PATHS)(
    "returns no empty plugin ID for %s",
    (pathname, expected) => {
      const pluginId = getPluginPanelRoutePluginId(pathname);
      expect(pluginId).toBe(expected);
      expect(pluginId === null || pluginId.length > 0).toBe(true);
    },
  );
});
