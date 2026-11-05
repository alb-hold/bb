// @vitest-environment jsdom
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
