// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalMobileControls } from "./TerminalMobileControls";

function buttonDisabled(label: string): boolean {
  return (screen.getByRole("button", { name: label }) as HTMLButtonElement)
    .disabled;
}

afterEach(cleanup);

function renderControls() {
  const onInput = vi.fn();
  const onSearch = vi.fn();
  render(
    <TerminalMobileControls
      controlActive={false}
      disabled={false}
      onArrow={vi.fn()}
      onControlChange={vi.fn()}
      onInput={onInput}
      onKeyboardToggle={vi.fn()}
      onPaste={vi.fn()}
      onSearch={onSearch}
      onSelectText={vi.fn()}
    />,
  );
  return { onInput, onSearch };
}

describe("TerminalMobileControls", () => {
  it("hides the extra keys until the user expands them", () => {
    renderControls();
    expect(screen.queryByRole("button", { name: "Shift Tab" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More terminal keys" }));

    expect(screen.getByRole("button", { name: "Shift Tab" })).toBeTruthy();
  });

  it.each([
    ["Shift Tab", "\x1b[Z"],
    ["Interrupt (Control C)", "\x03"],
    ["End of input (Control D)", "\x04"],
    ["Page up", "\x1b[5~"],
    ["Page down", "\x1b[6~"],
    ["Home", "\x1b[H"],
    ["End", "\x1b[F"],
  ])("sends the %s sequence a TUI expects", (label, sequence) => {
    const { onInput } = renderControls();
    fireEvent.click(screen.getByRole("button", { name: "More terminal keys" }));
    fireEvent.click(screen.getByRole("button", { name: label }));

    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledWith(sequence);
  });

  it("opens terminal output search from the touch controls", () => {
    const { onSearch } = renderControls();
    fireEvent.click(
      screen.getByRole("button", { name: "Search terminal output" }),
    );
    expect(onSearch).toHaveBeenCalledOnce();
  });

  it("keeps read-only controls enabled when the terminal has exited", () => {
    render(
      <TerminalMobileControls
        controlActive={false}
        disabled
        readOnlyDisabled={false}
        onArrow={vi.fn()}
        onControlChange={vi.fn()}
        onInput={vi.fn()}
        onKeyboardToggle={vi.fn()}
        onPaste={vi.fn()}
        onPreviousPrompt={vi.fn()}
        onNextPrompt={vi.fn()}
        onSearch={vi.fn()}
        onSelectText={vi.fn()}
      />,
    );

    expect(buttonDisabled("Search terminal output")).toBe(false);
    expect(buttonDisabled("Previous prompt")).toBe(false);
    expect(buttonDisabled("Next prompt")).toBe(false);
    expect(buttonDisabled("Select terminal text")).toBe(false);
    expect(buttonDisabled("Escape")).toBe(true);
    expect(buttonDisabled("Tab")).toBe(true);
    expect(buttonDisabled("Control for next key")).toBe(true);
    expect(buttonDisabled("Arrow left")).toBe(true);
    expect(buttonDisabled("Enter")).toBe(true);
    expect(buttonDisabled("More terminal keys")).toBe(true);
  });
});
