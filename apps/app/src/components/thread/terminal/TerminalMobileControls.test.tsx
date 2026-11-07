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
  it.each([360, 390])(
    "preserves key names and reserves room for five scroller keys at %s px",
    (width) => {
      const clientWidth = vi
        .spyOn(HTMLElement.prototype, "clientWidth", "get")
        .mockImplementation(function (this: HTMLElement) {
          return this.hasAttribute("data-terminal-mobile-controls") ? width : 0;
        });
      try {
        renderControls();
        const enter = screen.getByRole("button", { name: "Enter" });
        const more = screen.getByRole("button", { name: "More terminal keys" });
        const compact = width === 360;
        for (const key of [enter, more]) {
          expect(key.classList.contains("w-11")).toBe(compact);
          expect(key.classList.contains("min-w-11")).toBe(true);
          expect(key.classList.contains("shrink-0")).toBe(true);
        }
        expect(
          enter.querySelector('[data-icon="CornerDownLeft"]') !== null,
        ).toBe(compact);
        if (compact) {
          expect(
            more.querySelector('[data-icon="Keyboard"]')?.getAttribute("class"),
          ).toContain("scale-y-75");
        }
        expect(more.querySelector('[data-icon="Keyboard"]') !== null).toBe(
          compact,
        );
        expect(more.querySelector('[data-icon="ChevronDown"]')).not.toBeNull();
        const scroller = document.querySelector(
          "[data-terminal-key-scroller]",
        )!;
        expect(scroller.querySelectorAll("button")).toHaveLength(5);
        expect(scroller.classList.contains("flex-nowrap")).toBe(true);
        fireEvent.click(more);
        expect(more.getAttribute("aria-pressed")).toBe("true");
        expect(more.querySelector('[data-icon="ChevronUp"]')).not.toBeNull();
      } finally {
        clientWidth.mockRestore();
      }
    },
  );

  it("keeps touch targets wide enough to press on a narrow phone", () => {
    renderControls();

    const controls = screen.getByRole("group", {
      name: "Terminal keyboard controls",
    });
    expect(
      screen.getByRole("button", { name: "More terminal keys" }).textContent,
    ).toBe("Keys");
    const more = screen.getByRole("button", { name: "More terminal keys" });
    expect(more.querySelector('[data-icon="ChevronDown"]')).not.toBeNull();
    fireEvent.click(more);
    expect(more.getAttribute("aria-pressed")).toBe("true");
    expect(more.querySelector('[data-icon="ChevronUp"]')).not.toBeNull();
    fireEvent.click(more);
    const buttons = Array.from(controls.querySelectorAll("button"));
    expect(controls.querySelector(".bg-gradient-to-l")).toBeNull();

    expect(
      buttons.slice(0, 3).map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Interrupt (Control C)", "Escape", "Arrow up"]);
    expect(buttons[0]?.parentElement?.className.split(/\s+/u)).toEqual(
      expect.arrayContaining(["flex-nowrap", "overflow-x-auto"]),
    );
    expect(buttons[0]?.parentElement?.className.split(/\s+/u)).not.toContain(
      "flex-wrap",
    );
    for (const label of ["Enter", "More terminal keys"]) {
      expect(
        screen
          .getByRole("button", { name: label })
          .closest("[data-terminal-key-scroller]"),
      ).toBeNull();
    }
    expect(buttons[0]?.closest("[data-terminal-key-scroller]")).not.toBeNull();
    for (const button of buttons) {
      expect(button.className.split(/\s+/u)).toEqual(
        expect.arrayContaining([
          "h-11",
          "w-max",
          "shrink-0",
          "whitespace-nowrap",
          "rounded-full",
          "bg-[image:var(--pill-surface)]",
          "active:bg-none",
          "active:bg-state-active",
        ]),
      );
      expect(button.className.split(/\s+/u)).toContain("min-w-11");
      expect(button.className.split(/\s+/u)).toContain("flex-none");
    }
  });

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

  it("shows an overflow cue only on edges with hidden keys", () => {
    renderControls();
    const scroller = document.querySelector<HTMLElement>(
      "[data-terminal-key-scroller]",
    )!;
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 240 },
      scrollWidth: { configurable: true, value: 380 },
    });
    fireEvent.scroll(scroller);
    expect(scroller.dataset.moreRight).toBe("");
    expect(scroller.dataset.moreLeft).toBeUndefined();
    scroller.scrollLeft = 70;
    fireEvent.scroll(scroller);
    expect(scroller.dataset.moreLeft).toBe("");
    expect(scroller.dataset.moreRight).toBe("");
    scroller.scrollLeft = 140;
    fireEvent.scroll(scroller);
    expect(scroller.dataset.moreRight).toBeUndefined();
    Object.defineProperty(scroller, "clientWidth", { value: 400 });
    scroller.scrollLeft = 0;
    fireEvent.scroll(scroller);
    expect(scroller.dataset.moreLeft).toBeUndefined();
    expect(scroller.dataset.moreRight).toBeUndefined();
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

it("keeps both vertical arrows together before the narrow row overflow", () => {
  renderControls();
  const up = screen.getByRole("button", { name: "Arrow up" });
  const down = screen.getByRole("button", { name: "Arrow down" });
  expect(up.nextElementSibling).toBe(down);
  expect(
    screen.queryByRole("button", { name: "Control for next key" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "More terminal keys" }));
  expect(
    screen.getByRole("button", { name: "Control for next key" }),
  ).toBeTruthy();
});
