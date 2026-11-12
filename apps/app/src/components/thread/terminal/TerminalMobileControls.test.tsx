// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalMobileControls } from "./TerminalMobileControls";

function buttonDisabled(label: string): boolean {
  return (screen.getByRole("button", { name: label }) as HTMLButtonElement)
    .disabled;
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderControls() {
  const onInput = vi.fn();
  const onSearch = vi.fn();
  const onArrow = vi.fn();
  render(
    <TerminalMobileControls
      controlActive={false}
      disabled={false}
      onArrow={onArrow}
      onControlChange={vi.fn()}
      onInput={onInput}
      onKeyboardToggle={vi.fn()}
      onPaste={vi.fn()}
      onSearch={onSearch}
      onSelectText={vi.fn()}
    />,
  );
  return { onInput, onSearch, onArrow };
}

describe("TerminalMobileControls", () => {
  it("allows touch click synthesis while preventing mouse focus changes", () => {
    const { onInput } = renderControls();
    const tab = screen.getByRole("button", { name: "Tab" });
    expect(fireEvent.pointerDown(tab, { pointerType: "touch" })).toBe(true);
    expect(fireEvent.mouseDown(tab)).toBe(false);
    fireEvent.click(tab);
    expect(onInput).toHaveBeenCalledExactlyOnceWith("\t");
  });

  it.each([
    [288, 3],
    [320, 4],
    [344, 4],
    [360, 5],
    [375, 5],
    [390, 5],
    [600, 6],
  ])(
    "keeps every key reachable with uniform targets at %i px",
    (width, count) => {
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
        width,
      );
      renderControls();
      const row = document.querySelector<HTMLElement>(
        "[data-terminal-key-scroller]",
      )!;
      const priority = [
        "Interrupt (Control C)",
        "Escape",
        "Tab",
        "Enter",
        "Arrow up",
        "Arrow down",
      ];
      const labels = () =>
        Array.from(row.querySelectorAll("button"), (key) =>
          key.getAttribute("aria-label"),
        );
      expect(labels().slice(0, count)).toEqual(priority.slice(0, count));
      expect(labels().at(-1)).toBe("More terminal keys");
      expect(row.classList.contains("pt-1.5")).toBe(true);
      expect(row.classList.contains("overflow-x-auto")).toBe(false);
      const more = screen.getByRole("button", { name: "More terminal keys" });
      expect(more.querySelector('[data-icon="MoreHorizontal"]')).not.toBeNull();
      expect(more.querySelector('[data-icon="ChevronDown"]')).not.toBeNull();
      for (const label of priority.slice(count)) {
        expect(screen.queryByRole("button", { name: label })).toBeNull();
      }
      fireEvent.click(more);
      const allKeys = screen.getAllByRole("button");
      const allLabels = allKeys.map((key) => key.getAttribute("aria-label"));
      const fullSet = [
        ...priority,
        "More terminal keys",
        "Search terminal output",
        "Control for next key",
        "Arrow left",
        "Arrow right",
        "Shift Tab",
        "Function key F2",
        "End of input (Control D)",
        "Page up",
        "Page down",
        "Home",
        "End",
        "Paste",
        "Select terminal text",
        "Show or hide keyboard",
      ];
      expect(allLabels.sort()).toEqual(fullSet.sort());
      for (const key of allKeys) {
        expect(key.classList.contains("min-w-11")).toBe(true);
        expect(key.classList.contains("h-11")).toBe(true);
        expect(key.classList.contains("text-xs")).toBe(true);
        expect(key.classList.contains("text-2xs")).toBe(false);
        expect(key.classList.contains("shrink-0")).toBe(true);
      }
      fireEvent.click(more);
      expect(labels().slice(0, count)).toEqual(priority.slice(0, count));
    },
  );

  it("labels Enter visibly and sends a carriage return", () => {
    const { onInput } = renderControls();
    const enter = screen.getByRole("button", { name: "Enter" });
    expect(enter.textContent).toBe("Enter");
    fireEvent.click(enter);
    expect(onInput).toHaveBeenCalledExactlyOnceWith("\r");
  });

  it("interrupts without expanding or scrolling the key bar", () => {
    const { onInput } = renderControls();
    const interrupt = screen.getByRole("button", {
      name: "Interrupt (Control C)",
    });
    expect(
      interrupt.closest("[data-terminal-key-scroller]")?.firstElementChild,
    ).toBe(interrupt);
    fireEvent.click(interrupt);
    expect(onInput).toHaveBeenCalledExactlyOnceWith("\x03");
    expect(screen.queryByRole("button", { name: "Shift Tab" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Function key F2" }),
    ).toBeNull();
  });

  it("hides the extra keys until the user expands them", () => {
    renderControls();
    expect(screen.queryByRole("button", { name: "Shift Tab" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More terminal keys" }));

    expect(screen.getByRole("button", { name: "Shift Tab" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Function key F2" }).textContent,
    ).toBe("F2");
  });

  it.each([
    ["Shift Tab", "\x1b[Z"],
    ["Function key F2", "\x1bOQ"],
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
    fireEvent.click(screen.getByRole("button", { name: "More terminal keys" }));
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

it("keeps the overflowed vertical arrow reachable through Keys", () => {
  const { onArrow } = renderControls();
  expect(screen.queryByRole("button", { name: "Arrow down" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Control for next key" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "More terminal keys" }));
  fireEvent.click(screen.getByRole("button", { name: "Arrow down" }));
  expect(onArrow).toHaveBeenCalledExactlyOnceWith("down");
  expect(
    screen.getByRole("button", { name: "Control for next key" }),
  ).toBeTruthy();
});
