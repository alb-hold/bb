import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const css = source("../../app.css");

describe("P95 responsive layout contracts", () => {
  it("collapses only the idle desktop terminal composer and aligns it to the grid", () => {
    expect(css).toMatch(
      /@media \(width >= 48rem\)[\s\S]*?\[data-native-composer-inline\][\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto/,
    );
    expect(css).toContain(
      "[data-native-terminal-prompt] {\n    max-width: none;",
    );
  });
  it("keeps terminal placeholders on one line", () => {
    expect(css).toContain("[data-native-composer] textarea::placeholder");
    expect(css).toContain("white-space: nowrap");
  });
  it("lets the model label shrink before its chevron", () => {
    expect(css).toMatch(/\[data-model-name\] \{\s*min-width: 0;/);
    expect(css).toContain("text-overflow: ellipsis;");
    expect(source("../pickers/ModelReasoningPicker.tsx")).toContain(
      'data-model-chevron=""',
    );
  });
  it("keeps execution controls on one row at 440px of composer width", () => {
    expect(css).toContain("@container promptbox-shell (min-width: 27.5rem)");
    expect(css).toContain("@container promptbox-shell (max-width: 40rem)");
  });
  it("hosts terminal search in the panel action area", () => {
    expect(source("../secondary-panel/ThreadSecondaryPanel.tsx")).toContain(
      "<SecondaryPanelActions />",
    );
    expect(source("../thread/terminal/TerminalSearch.tsx")).toContain(
      "createPortal(trigger, actionsTarget)",
    );
  });
  it("packs mobile terminal keys without stretching the scroller", () => {
    expect(source("../thread/terminal/TerminalMobileControls.tsx")).toContain(
      'className="relative min-w-0 shrink"',
    );
  });
  it("gives usage metadata the sanctioned xs subtle style", () => {
    expect(source("../thread/ThreadUsageSummary.tsx")).toContain(
      "text-left font-sans text-xs tabular-nums text-subtle-foreground",
    );
  });
  it("separates sidebar footer actions with a token border", () => {
    expect(source("../sidebar/AppSidebar.tsx")).toContain(
      "border-t border-sidebar-border",
    );
  });
});
