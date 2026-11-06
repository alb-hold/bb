// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarContentElementContext } from "../ui/sidebar.js";
import {
  SidebarListVisibleContext,
  useSidebarListShown,
} from "./useSidebarListShown.js";

function Probe() {
  return useSidebarListShown() ? <span>pinned rows</span> : null;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("falls back to observer visibility when an older host omits visibility", () => {
  let resize: ResizeObserverCallback | undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const element = document.createElement("div");
  render(
    <SidebarContentElementContext.Provider value={{ current: element }}>
      <Probe />
    </SidebarContentElementContext.Provider>,
  );
  expect(screen.queryByText("pinned rows")).toBeNull();
  act(() =>
    resize?.(
      [
        {
          target: element,
          contentRect: new DOMRectReadOnly(0, 0, 300, 500),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      {} as ResizeObserver,
    ),
  );
  expect(screen.getByText("pinned rows")).toBeTruthy();
  act(() =>
    resize?.(
      [
        {
          target: element,
          contentRect: new DOMRectReadOnly(0, 0, 300, 0),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      {} as ResizeObserver,
    ),
  );
  expect(screen.queryByText("pinned rows")).toBeNull();
});

it("tracks the host visibility immediately when the sidebar opens or collapses", () => {
  const { rerender } = render(
    <SidebarListVisibleContext.Provider value={false}>
      <Probe />
    </SidebarListVisibleContext.Provider>,
  );
  expect(screen.queryByText("pinned rows")).toBeNull();
  rerender(
    <SidebarListVisibleContext.Provider value>
      <Probe />
    </SidebarListVisibleContext.Provider>,
  );
  expect(screen.getByText("pinned rows")).toBeTruthy();
  rerender(
    <SidebarListVisibleContext.Provider value={false}>
      <Probe />
    </SidebarListVisibleContext.Provider>,
  );
  expect(screen.queryByText("pinned rows")).toBeNull();
});
