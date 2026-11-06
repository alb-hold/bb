// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  SIDEBAR_FOOTER_ACTION_CLASS,
  SIDEBAR_RAIL_BUTTON_CLASS,
} from "@bb/shared-ui/sidebar-row-classes";

afterEach(cleanup);

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
