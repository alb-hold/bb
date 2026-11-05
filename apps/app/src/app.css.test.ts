import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "app.css"),
  "utf8",
);

describe("app.css chrome geometry", () => {
  it("owns the shared app chrome row height", () => {
    expect(css).toMatch(/--bb-app-chrome-row-height:\s*3rem;/);
  });
});

describe("app.css compact prompt controls", () => {
  it("lets designated controls shrink in both compact containers", () => {
    expect(
      css.match(
        /\[data-(?:composer-box|promptbox-shell)\] \[data-promptbox-shrinkable-control\] \{\s*flex-shrink: 1 !important;\s*\}/g,
      ),
    ).toHaveLength(2);
  });

  it("removes collapsed follow-up footer controls from keyboard focus", () => {
    const block = css.match(
      /\[data-follow-up-composer\]:not\(\[data-follow-up-composer-footer-visible\]\)\s+\[data-follow-up-composer-footer\]\s*\{([^}]*)\}/,
    )?.[1];
    expect(block).toBeDefined();
    expect(block).toMatch(/visibility:\s*hidden;/);
    expect(block).not.toMatch(/transition-delay\s*:/);
  });
});

describe("app.css sidebar drag cursor", () => {
  it("scopes the grabbing cursor to the sidebar panel on fine pointers only", () => {
    expect(css).not.toMatch(/body\[data-sidebar-dragging="true"\]\s*\*/);
    const block = css.match(
      /@media \(pointer: fine\) \{\s*body\[data-sidebar-dragging="true"\],\s*body\[data-sidebar-dragging="true"\] \[data-sidebar="panel"\] \* \{([^}]*)\}/,
    )?.[1];
    expect(block).toBeDefined();
    expect(block).toMatch(/cursor:\s*grabbing !important;/);
  });
});

describe("compact touch targets", () => {
  const block = css.slice(css.lastIndexOf("@media (width < 48rem)"));
  it.each([
    'aria-label="Message actions"',
    'aria-label="Copy message"',
    'aria-label="Reply in side chat"',
    'aria-label="Wrap lines"',
    'aria-label="Copy code"',
    'aria-label="Thread actions"',
    'aria-label="Show right panel"',
    'aria-label="Toggle sidebar"',
    'aria-label="Prompt actions"',
    'aria-label="Start voice input"',
    'data-model-reasoning-trigger',
    'data-compact-touch-summary',
  ])("reserves a disjoint 44px target for %s only at compact widths", (selector) => {
    expect(block).toContain(`[${selector}]`);
    expect(block).toContain("min-inline-size: 44px");
    expect(block).toContain("min-block-size: 44px");
    expect(block).not.toMatch(/svg|data-icon-root/);
  });
});
