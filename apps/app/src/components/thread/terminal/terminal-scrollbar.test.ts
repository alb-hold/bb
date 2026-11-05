// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { trackTerminalScrollability } from "./terminal-scrollbar";

it("hides an empty terminal thumb, shows scrollback, and hides it after clearing", () => {
  const element = document.createElement("div");
  const active = { baseY: 0 };
  let render = () => {};
  let scroll = () => {};
  trackTerminalScrollability({
    element,
    buffer: { active } as never,
    onRender: vi.fn((callback) => {
      render = () => callback({ start: 0, end: 1 });
      return { dispose() {} };
    }),
    onScroll: vi.fn((callback) => {
      scroll = () => callback(active.baseY);
      return { dispose() {} };
    }),
  });
  expect(element.dataset.scrollable).toBe("false");
  active.baseY = 3;
  render();
  expect(element.dataset.scrollable).toBe("true");
  active.baseY = 0;
  scroll();
  expect(element.dataset.scrollable).toBe("false");
});

it("keeps the xterm custom track transparent and its thumb thin", () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../../app.css"),
    "utf8",
  );
  expect(css).toMatch(
    /:where\(\.xterm\) \.xterm-scrollable-element > \.xterm-scrollbar \{\s*background: transparent !important;/,
  );
  expect(css).toMatch(/> \.xterm-slider \{\s*width: 4px !important;/);
  expect(css).toContain(
    "scrollbar-color: var(--terminal-scrollbar) transparent",
  );
});
