// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Tooltip, TooltipProvider, TooltipTrigger } from "./tooltip";
import { isLastInputKeyboard } from "./overlay-trigger";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("installs persistent modality listeners once when the first trigger mounts", () => {
  const listen = vi.spyOn(document, "addEventListener");
  const mount = () =>
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Open</TooltipTrigger>
        </Tooltip>
      </TooltipProvider>,
    );
  const first = mount();
  const installations = () =>
    listen.mock.calls.filter(
      ([type, , options]) =>
        (type === "keydown" || type === "pointerdown") &&
        typeof options === "object" &&
        options?.capture === true,
    );
  expect(installations().map(([type]) => type)).toEqual([
    "keydown",
    "pointerdown",
  ]);
  fireEvent.keyDown(document.body, { key: "Tab" });
  expect(isLastInputKeyboard()).toBe(true);
  first.unmount();
  fireEvent.pointerDown(document.body, { pointerType: "mouse" });
  expect(isLastInputKeyboard()).toBe(false);
  mount();
  expect(installations()).toHaveLength(2);
});
