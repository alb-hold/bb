// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalMobileControls } from "./TerminalMobileControls";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderControls() {
  const onInput = vi.fn();
  const onSearch = vi.fn();
  render(
    <TerminalMobileControls
      controlMode="off"
      disabled={false}
      onArrow={vi.fn()}
      onControlChange={vi.fn()}
      onInput={onInput}
      onKeyboardToggle={vi.fn()}
      onPaste={vi.fn()}
      onSearch={onSearch}
      onSelectText={vi.fn()}
      fontSize={12}
      onFontSizeChange={vi.fn()}
    />,
  );
  return { onInput, onSearch };
}

describe("TerminalMobileControls", () => {
  it("pins to the visual keyboard edge as it resizes", () => {
    const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const viewport = Object.assign(new EventTarget(), { offsetTop: 0, height: 400 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    try {
      renderControls();
      const dock = document.querySelector("[data-terminal-mobile-controls]") as HTMLElement;
      expect(dock.style.getPropertyValue("--terminal-mobile-dock-bottom")).toBe("368px");
      viewport.height = 700;
      viewport.dispatchEvent(new Event("resize"));
      expect(dock.style.getPropertyValue("--terminal-mobile-dock-bottom")).toBe("68px");
    } finally {
      if (original) Object.defineProperty(window, "visualViewport", original);
      else Reflect.deleteProperty(window, "visualViewport");
    }
  });

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
    fireEvent.click(screen.getByRole("button", { name: "Search terminal output" }));
    expect(onSearch).toHaveBeenCalledOnce();
  });

  it("exposes font size controls that update the terminal preference", () => {
    const onFontSizeChange = vi.fn();
    render(<TerminalMobileControls {...controlProps({ onFontSizeChange })} />);
    fireEvent.click(screen.getByRole("button", { name: "Increase terminal text size" }));
    expect(onFontSizeChange).toHaveBeenCalledWith(1);
  });

  it("cycles Ctrl from one-shot to locked and then off with visible state", () => {
    function StatefulControls() {
      const [controlMode, setControlMode] = useState<"off" | "one-shot" | "locked">("off");
      return <TerminalMobileControls {...controlProps({ controlMode, onControlChange: setControlMode })} />;
    }
    render(<StatefulControls />);
    const ctrl = screen.getByRole("button", { name: "Control for next key" });
    fireEvent.click(ctrl);
    expect(screen.getByRole("button", { name: "Control for next key, active" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Control for next key, active" }));
    expect(screen.getByRole("button", { name: "Control locked" }).textContent).toContain("Ctrl·");
    fireEvent.click(screen.getByRole("button", { name: "Control locked" }));
    expect(screen.getByRole("button", { name: "Control for next key" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("repeats Backspace while its pointer remains held", () => {
    vi.useFakeTimers();
    const onInput = vi.fn();
    render(<TerminalMobileControls {...controlProps({ onInput })} />);
    const backspace = screen.getByRole("button", { name: "Backspace" });
    fireEvent.pointerDown(backspace);
    expect(onInput).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(550);
    expect(onInput.mock.calls.length).toBeGreaterThanOrEqual(3);
    const countAtRelease = onInput.mock.calls.length;
    fireEvent.pointerUp(backspace);
    fireEvent.click(backspace);
    expect(onInput).toHaveBeenCalledTimes(countAtRelease);
    vi.advanceTimersByTime(100);
    expect(onInput).toHaveBeenCalledTimes(countAtRelease);
    vi.useRealTimers();
  });
});

function controlProps(overrides: Partial<ComponentProps<typeof TerminalMobileControls>> = {}) {
  return {
    controlMode: "off" as const,
    disabled: false,
    onArrow: vi.fn(),
    onControlChange: vi.fn(),
    onInput: vi.fn(),
    onKeyboardToggle: vi.fn(),
    onPaste: vi.fn(),
    onSearch: vi.fn(),
    onSelectText: vi.fn(),
    fontSize: 12,
    onFontSizeChange: vi.fn(),
    ...overrides,
  };
}
