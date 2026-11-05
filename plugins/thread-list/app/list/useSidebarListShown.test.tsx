// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarContentElementContext } from "../ui/sidebar.js";
import { useSidebarListShown } from "./useSidebarListShown.js";

function Probe() {
  return <span>{useSidebarListShown() ? "visible rows" : "hidden rows"}</span>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("realizes rows from observer geometry without reading layout during commit", () => {
  const callbacks: ResizeObserverCallback[] = [];
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
    observe() {}
    disconnect = disconnect;
  });
  const height = vi.spyOn(Element.prototype, "clientHeight", "get");
  const element = document.createElement("div");
  const result = render(
    <SidebarContentElementContext.Provider value={{ current: element }}>
      <Probe />
    </SidebarContentElementContext.Provider>,
  );
  expect(height).not.toHaveBeenCalled();
  expect(screen.getByText("hidden rows")).not.toBeNull();
  const resize = (height: number) => act(() => {
    for (const callback of callbacks) callback([
      { target: element, contentRect: new DOMRectReadOnly(0, 0, 300, height), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] },
    ], {} as ResizeObserver);
  });
  resize(500);
  expect(screen.getByText("visible rows")).not.toBeNull();
  resize(0);
  expect(screen.getByText("hidden rows")).not.toBeNull();
  resize(300);
  expect(screen.getByText("visible rows")).not.toBeNull();
  expect(height).not.toHaveBeenCalled();
  result.unmount();
  expect(disconnect).toHaveBeenCalled();
});
