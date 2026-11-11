import { describe, expect, it } from "vitest";
import { arrangePluginNavPanelPreferences } from "@/components/plugin/pluginNavSidebarOrder";

function panel(pluginId: string, id: string) {
  return { pluginId, id };
}

describe("useSidebarNavigationArrangement visibility", () => {
  it("keeps newly discovered plugin panels out of the default visible set", () => {
    const initial = arrangePluginNavPanelPreferences({
      panels: [panel("github", "pulls")],
      storedOrder: ["github/pulls"],
      storedVisibleKeys: ["github/pulls"],
      defaultHiddenKeys: [],
    });
    const afterRegister = arrangePluginNavPanelPreferences({
      panels: [panel("github", "pulls"), panel("docs", "vault")],
      storedOrder: ["github/pulls", "docs/vault"],
      storedVisibleKeys: initial.normalizedVisibleKeys,
      defaultHiddenKeys: [],
    });
    expect(afterRegister.visibleKeys).toEqual(["github/pulls"]);
  });
});
