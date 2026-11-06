// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { createStore, Provider, useAtomValue } from "jotai";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  sidebarFooterCapacityAtom,
  useMeasureSidebarFooterCapacity,
} from "./sidebarFooterPreferences";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Footer() {
  const capacity = useAtomValue(sidebarFooterCapacityAtom);
  const row = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  useMeasureSidebarFooterCapacity(row, more);
  return (
    <div ref={row} style={{ columnGap: 4 }}>
      <button ref={more}>More</button>
      <output>{capacity ?? "unmeasured"}</output>
    </div>
  );
}

it("measures capacity at observer delivery before paint without a commit geometry read", () => {
  let deliver: ResizeObserverCallback = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        deliver = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const geometry = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, 0, this.tagName === "BUTTON" ? 28 : 164, 28);
    });
  const store = createStore();
  const view = render(
    <Provider store={store}>
      <Footer />
    </Provider>,
  );
  expect(geometry).not.toHaveBeenCalled();
  expect(store.get(sidebarFooterCapacityAtom)).toBeNull();
  act(() => {
    deliver([], {} as ResizeObserver);
    expect(screen.getByRole("status").textContent).toBe("unmeasured");
  });
  expect(store.get(sidebarFooterCapacityAtom)).toBe(4);
  expect(screen.getByRole("status").textContent).toBe("4");
  geometry.mockImplementation(() => new DOMRect());
  act(() => deliver([], {} as ResizeObserver));
  expect(store.get(sidebarFooterCapacityAtom)).toBe(4);
  view.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});
