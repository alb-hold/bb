// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  SIDEBAR_FOOTER_ACTION_CLASS,
  SIDEBAR_RAIL_BUTTON_CLASS,
} from "@bb/shared-ui/sidebar-row-classes";

afterEach(cleanup);

it.each([SIDEBAR_FOOTER_ACTION_CLASS, SIDEBAR_RAIL_BUTTON_CLASS])(
  "keeps inactive chrome legible and puzzle paths outlined: %s",
  (className) => {
    const css = readFileSync(join(import.meta.dirname, "../../app.css"), "utf8");
    const { container } = render(
      <>
        <style>{css.slice(css.indexOf(":where(.bb-sidebar-chrome-icon)"))}</style>
        <button className={className}>
          <svg data-icon-root="" data-icon="Puzzle">
            <path fill="currentColor" />
          </svg>
        </button>
      </>,
    );
    const path = container.querySelector("path")!;
    expect(getComputedStyle(path).fill).toBe("none");
    expect(getComputedStyle(path).stroke).toBe("currentcolor");
    expect(className.split(" ")).toContain("text-sidebar-foreground");
  },
);

it("sizes desktop chrome glyphs at 18 px without enlarging phone glyphs", () => {
  const css = readFileSync(join(import.meta.dirname, "../../app.css"), "utf8");
  const start = css.indexOf(":root {");
  const end = css.indexOf("\n  [data-sidebar-header-slot]", start);
  const { container } = render(<style>{css.slice(start, end)}</style>);
  const rules = Array.from(container.querySelector("style")!.sheet!.cssRules);
  const root = rules[0] as CSSStyleRule;
  expect(root.style.getPropertyValue("--bb-sidebar-control-icon-size")).toBe("18px");
  const phone = (rules[1] as CSSMediaRule).cssRules[0] as CSSStyleRule;
  expect(phone.style.getPropertyValue("--bb-sidebar-control-icon-size")).toBe("20px");
});

it("reserves final phone footer targets before plugin actions arrive", () => {
  const css = readFileSync(join(import.meta.dirname, "../../app.css"), "utf8");
  function Footer({ plugin }: { plugin: boolean }) {
    return (
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenu>
              {plugin && (
                <SidebarMenuItem>
                  <button
                    data-sidebar="menu-button"
                    className={SIDEBAR_FOOTER_ACTION_CLASS}
                  >
                    Provider usage
                  </button>
                </SidebarMenuItem>
              )}
              <SidebarMenuItem>
                <button
                  data-sidebar="menu-button"
                  className={SIDEBAR_FOOTER_ACTION_CLASS}
                >
                  Report a bug
                </button>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <button
                  data-sidebar="menu-button"
                  className={SIDEBAR_FOOTER_ACTION_CLASS}
                >
                  More
                </button>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    );
  }
  const style = document.createElement("style");
  style.textContent = css.slice(
    css.indexOf(
      "@media (width < 48rem) and (pointer: coarse) {",
      css.indexOf("root-compose-desktop-recents"),
    ),
  );
  document.head.append(style);
  try {
    const rules = Array.from(style.sheet?.cssRules ?? []).flatMap((rule) =>
      "conditionText" in rule &&
      "cssRules" in rule &&
      rule.conditionText === "(width < 48rem) and (pointer: coarse)"
        ? Array.from((rule as CSSMediaRule).cssRules).filter(
            (child): child is CSSStyleRule =>
              "selectorText" in child && "style" in child,
          )
        : [],
    );
    const declaration = (element: Element, property: string) =>
      rules
        .filter((rule) => element.matches(rule.selectorText))
        .map((rule) => rule.style.getPropertyValue(property))
        .filter(Boolean)
        .at(-1);
    const view = render(<Footer plugin={false} />);
    for (const plugin of [false, true]) {
      view.rerender(<Footer plugin={plugin} />);
      const row = view.container.querySelector('[data-sidebar="menu-item"]')!;
      expect(declaration(row, "min-block-size")).toBe("44px");
      for (const button of view.container.querySelectorAll("button")) {
        expect(declaration(button, "min-inline-size")).toBe("44px");
        expect(declaration(button, "min-block-size")).toBe("44px");
      }
    }
  } finally {
    style.remove();
  }
});

it.each([SIDEBAR_FOOTER_ACTION_CLASS, SIDEBAR_RAIL_BUTTON_CLASS])(
  "normalizes branded glyph paint in chrome %s",
  (className) => {
    const css = readFileSync(
      join(import.meta.dirname, "../../app.css"),
      "utf8",
    );
    const { container } = render(
      <>
        <style>
          {css.slice(css.indexOf(":where(.bb-sidebar-chrome-icon)"))}
        </style>
        <button className={className} aria-label="Provider usage">
          <span data-icon-root="">
            <svg>
              <path fill="#8247ff" stroke="#8247ff" />
              <path fill="none" stroke="none" />
            </svg>
          </span>
        </button>
      </>,
    );
    const paths = container.querySelectorAll("path");
    expect(getComputedStyle(paths[0]).fill).toBe("currentcolor");
    expect(getComputedStyle(paths[0]).stroke).toBe("currentcolor");
    expect(getComputedStyle(paths[1]).fill).not.toBe("currentcolor");
    expect(getComputedStyle(container.querySelector("svg")!).strokeWidth).toBe(
      "1.5",
    );
  },
);
