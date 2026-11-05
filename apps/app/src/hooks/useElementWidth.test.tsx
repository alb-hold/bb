// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useElementWidth } from "./useElementWidth";

function Probe({ mounted = true }: { mounted?: boolean }) {
  const { ref, width } = useElementWidth();
  return (
    <>
      {mounted ? <div ref={ref} data-testid="measured" /> : null}
      <output>{width}</output>
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("measures the observed border box without forcing layout in the ref or resize callback", () => {
  let callback: ResizeObserverCallback = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(notify: ResizeObserverCallback) {
        callback = notify;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const read = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
  const view = render(<Probe />);
  expect(read).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toBe("0");
  const resize = (width: number) =>
    act(() =>
      callback(
        [
          {
            target: screen.getByTestId("measured"),
            contentRect: new DOMRect(0, 0, width - 20, 100),
            borderBoxSize: [{ inlineSize: width, blockSize: 100 }],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          },
        ],
        {} as ResizeObserver,
      ),
    );
  resize(800);
  expect(screen.getByRole("status").textContent).toBe("800");
  resize(400);
  expect(screen.getByRole("status").textContent).toBe("400");
  expect(read).not.toHaveBeenCalled();
  view.rerender(<Probe mounted={false} />);
  expect(disconnect).toHaveBeenCalledOnce();
});
