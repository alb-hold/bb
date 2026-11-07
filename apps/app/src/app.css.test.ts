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
  const block = css.slice(
    css.lastIndexOf("@media (width < 48rem)"),
    css.indexOf("@media (width <= 480px)"),
  );
  it.each([
    'data-compact-touch="action"',
    'data-compact-touch="action-menu"',
    'data-compact-touch="code"',
    'data-compact-touch="header"',
    'data-sidebar="trigger"',
    "data-promptbox-plus-control",
    'data-compact-touch="voice"',
    'data-compact-touch="picker"',
    "data-model-reasoning-trigger",
    "data-compact-touch-summary",
  ])(
    "reserves a disjoint 44px target for %s only at compact widths",
    (selector) => {
      expect(block).toContain(`[${selector}]`);
      expect(block).toContain("min-inline-size: 44px");
      expect(block).toContain("min-block-size: 44px");
      expect(block).not.toMatch(/svg|data-icon-root/);
    },
  );
});

it("keeps disclosure extensions at their full height between neighbours", () => {
  const block = css.slice(
    css.lastIndexOf("@media (width < 48rem)"),
    css.indexOf("@media (width <= 480px)"),
  );
  expect(block).not.toContain("--compact-touch-summary-start");
  expect(block).not.toContain("--compact-touch-summary-end");
  expect(block).not.toContain("--compact-touch-summary-half-gap");
});

it("reserves real timeline hit areas without extensions into neighbouring rows", () => {
  const block = css.slice(
    css.lastIndexOf("@media (width < 48rem)"),
    css.indexOf("@media (width <= 480px)"),
  );
  const timeline = block.slice(block.indexOf('[data-compact-touch="action"]'));
  expect(block).not.toContain("aria-label");
  expect(timeline).not.toContain("min-block-size");
  expect(timeline).not.toContain('content: ""');
  expect(timeline).toContain("min-height: 44px");
  expect(timeline).not.toContain("inset-block: calc((100% - 44px) / 2)");
  expect(timeline).not.toContain("inset-block: -12px");
});

it("keeps the last summary hit area inside the animated clip without negative margins", () => {
  const block = css.slice(
    css.lastIndexOf("@media (width < 48rem)"),
    css.indexOf("@media (width <= 480px)"),
  );
  expect(block).toMatch(
    /\[data-compact-touch-height\]:has\(\[data-compact-touch-summary\]\)\s*\{\s*margin-block: 0px;\s*\}/,
  );
  expect(block).toMatch(
    /\[data-compact-touch-height\]:has\(\[data-compact-touch-summary\]\) > div\s*\{\s*padding-block: 0px;\s*\}/,
  );
});

it("limits compact pseudo-element hit areas to coarse pointers", () => {
  expect(css).toContain("@media (width < 48rem) and (pointer: coarse)");
});

it("reserves an 8px action gap", () => {
  expect(css).toContain("column-gap: 0.5rem");
});

it("keeps the home execution controls on one row with voice beside the input", () => {
  expect(css).toContain("grid-template-columns: 2.75rem minmax(0, 1fr)");
  expect(css).not.toMatch(/data-promptbox-trailing-actions[^}]*grid-row: 2/s);
  expect(css).toContain("padding-inline-end: 3rem");
});

it("insets the phone microphone inside the input row without overlapping the action row", () => {
  const phone = css.slice(css.indexOf("@media (width < 48rem)"));
  const trailing = phone.match(
    /\[data-promptbox-execution-layout="stacked"\]\s*> \[data-promptbox-trailing-actions\]\s*\{([^}]*)\}/,
  )?.[1];
  const row = phone.match(
    /\[data-promptbox-execution-layout="stacked"\]\s*\{\s*padding:([^;]*);/,
  )?.[1];
  expect(trailing).toMatch(/right: 0\.5rem;/);
  expect(trailing).toMatch(/bottom: calc\(100% - 0\.5rem\);/);
  expect(row?.trim()).toBe("0.75rem 0.25rem 0.25rem");
});
it("keeps code and message hit areas inside their own rows", () => {
  expect(css).toMatch(/min-height: 44px;/);
  expect(css).toMatch(
    /\[data-message-action-slot\]\s*\{\s*padding-block: 0px;/,
  );
  expect(css).toMatch(/\[data-code-actions\]\s*\{\s*min-height: 2.75rem;/);
});

it("reveals actions for coarse pointers while retaining keyboard focus access", () => {
  const actionsCss = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "components/thread/timeline/message-action-bar.css",
    ),
    "utf8",
  );
  expect(actionsCss).toContain("@media (pointer: coarse)");
  expect(actionsCss).toContain(
    '[data-touch-actions-visible="false"]:not(:focus-within)',
  );
  expect(actionsCss).toContain("clip-path: inset(50%)");
  expect(actionsCss.slice(actionsCss.lastIndexOf("@media (pointer: coarse)"))).not.toContain("display: none");
  expect(actionsCss).toContain('[data-touch-actions-visible="true"] [data-message-action-row] button');
});
