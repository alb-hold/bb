// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadRowMetadata } from "./thread-row-metadata";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("preserves the capped project and age, dropping a branch below six visible characters and restoring it after resize", () => {
  let width = 180;
  let notify = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const measured = this.hasAttribute("data-thread-context-metadata")
        ? width
        : this.hasAttribute("data-thread-row-project")
          ? 90
          : this.dataset.measure === " · "
            ? 12
            : this.dataset.measure
              ? 49
              : 20;
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: measured,
        bottom: 16,
        width: measured,
        height: 16,
        toJSON() {},
      };
    },
  );
  const view = render(
    <ThreadRowMetadata
      project="waggle-cli"
      branch="bb/harden-input"
      age="3d"
    />,
  );
  const branch = () => view.container.querySelector("[data-thread-row-branch]");
  expect(branch()).toBeNull();
  expect(view.container.textContent).toBe("waggle-cli · 3d");
  width = 183;
  act(() => notify());
  expect(branch()?.textContent).toBe("bb/harden-input");
  expect(view.container.textContent).toBe("waggle-cli · bb/harden-input · 3d");
  width = 182;
  act(() => notify());
  expect(branch()).toBeNull();
  expect(
    view.container.querySelector("[data-thread-row-project]")?.className,
  ).toContain("max-w-[min(14ch,60%)]");
});

it("keeps the project and age when no branch exists", () => {
  const view = render(<ThreadRowMetadata project="bb" age="3h" />);
  expect(view.container.textContent).toBe("bb · 3h");
  expect(view.container.querySelector("[data-thread-row-branch]")).toBeNull();
});
