// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.resetModules();
});

it.each([1280, 390])(
  "keeps the home shell and composer glyphs synchronous at %ipx",
  async (width) => {
    vi.resetModules();
    const [
      icons,
      registry,
      home,
      project,
      permissions,
      sidebar,
      viewport,
      tooltip,
    ] = await Promise.all([
      import("@bb/shared-ui/icon"),
      import("@bb/shared-ui/icon-registry"),
      import("./views/RootComposeHome"),
      import("./components/pickers/ProjectSelector"),
      import("./components/pickers/PermissionModePicker"),
      import("./components/sidebar/SidebarNavigationModel"),
      import("@bb/shared-ui/hooks/use-compact-viewport"),
      import("@bb/shared-ui/tooltip"),
    ]);
    expect(registry.getExtendedIcons()).toBeNull();
    const view = render(
      <viewport.CompactViewportOverrideProvider isCompactViewport={width < 768}>
        <tooltip.TooltipProvider>
          <aside>
            <sidebar.SidebarNavigationIcon
              icon={{ kind: "host", name: "extensions" }}
            />
          </aside>
          <home.RootComposeHome
            isCompact={width < 768}
            homepageSections={null}
            compactScrollContent={null}
            composer={
              <div data-app-composer="">
                <project.ProjectSelector
                  projects={[]}
                  value={null}
                  allowNoProject
                  onChange={() => {}}
                />
                <permissions.PermissionModePicker
                  value="auto"
                  options={[
                    { value: "auto", label: "Approve for me" },
                    { value: "full", label: "Full access" },
                  ]}
                  supported
                  onChange={() => {}}
                />
                <icons.Icon name="Mic" />
                <icons.Icon name="ArrowUp" />
              </div>
            }
          />
        </tooltip.TooltipProvider>
      </viewport.CompactViewportOverrideProvider>,
    );
    expect(registry.getExtendedIcons()).toBeNull();
    expect(view.container.querySelector("[data-icon-pending]")).toBeNull();
    for (const name of [
      "FolderMinus",
      "SecurityCheck",
      "Plug02",
      "Mic",
      "ArrowUp",
    ]) {
      const glyph = view.container.querySelector(`svg[data-icon="${name}"]`);
      expect(glyph, name).not.toBeNull();
      expect(glyph?.childElementCount, name).toBeGreaterThan(0);
    }
  },
);
