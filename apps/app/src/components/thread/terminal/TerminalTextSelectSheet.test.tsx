// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalMobileControls } from "./TerminalMobileControls";
import { TerminalTextSelectSheet } from "./TerminalTextSelectSheet";

afterEach(cleanup);

describe("TerminalTextSelectSheet", () => {
  it("shows the terminal text as selectable text and wires its buttons", async () => {
    const onOpenChange = vi.fn();
    const onCopyAll = vi.fn();
    render(
      <TerminalTextSelectSheet
        open
        text={"first line\nsecond line"}
        onOpenChange={onOpenChange}
        onCopyAll={onCopyAll}
      />,
    );
    await waitFor(() => {
      expect(
        document.querySelector("[data-terminal-text-snapshot]")?.textContent,
      ).toBe("first line\nsecond line");
    });
    expect(
      document.querySelector("[data-terminal-text-snapshot]")?.className,
    ).toContain("select-text");

    fireEvent.click(screen.getByRole("button", { name: "Copy all" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onCopyAll).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders no text while closed", () => {
    render(
      <TerminalTextSelectSheet
        open={false}
        text="hidden"
        onOpenChange={vi.fn()}
        onCopyAll={vi.fn()}
      />,
    );
    expect(document.querySelector("[data-terminal-text-snapshot]")).toBeNull();
  });
});

describe("TerminalMobileControls select key", () => {
  it("opens text selection from the extra keys", () => {
    const onSelectText = vi.fn();
    render(
      <TerminalMobileControls
        controlActive={false}
        disabled={false}
        onArrow={vi.fn()}
        onControlChange={vi.fn()}
        onInput={vi.fn()}
        onKeyboardToggle={vi.fn()}
        onPaste={vi.fn()}
        onSelectText={onSelectText}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "More terminal keys" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Select terminal text" }),
    );
    expect(onSelectText).toHaveBeenCalledTimes(1);
  });
});
