// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalMobileControls } from "./TerminalMobileControls";
import { TerminalTextSelectSheet } from "./TerminalTextSelectSheet";

afterEach(cleanup);

describe("TerminalTextSelectSheet", () => {
  it("shows the terminal text as selectable text and wires its buttons", () => {
    const onClose = vi.fn();
    const onCopyAll = vi.fn();
    render(
      <TerminalTextSelectSheet
        text={"first line\nsecond line"}
        onClose={onClose}
        onCopyAll={onCopyAll}
      />,
    );
    const text = document.querySelector("[data-terminal-text-snapshot]");
    expect(text?.textContent).toBe("first line\nsecond line");
    expect(text?.className).toContain("select-text");

    fireEvent.click(screen.getByRole("button", { name: "Copy all" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onCopyAll).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
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
