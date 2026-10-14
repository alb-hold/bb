// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { TerminalSearch } from "./TerminalSearch";

afterEach(() => {
  cleanup();
  document
    .querySelectorAll("textarea")
    .forEach((textarea) => textarea.remove());
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "",
  });
});

function renderSearch(open = false) {
  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  const terminal = { textarea } as unknown as Terminal;
  let searchOpen = open;
  const updateOpen = (value: boolean) => {
    searchOpen = value;
    view.rerender(
      <div className="group/terminal-pane">
        <TerminalSearch
          addon={null}
          terminal={terminal}
          open={searchOpen}
          onOpenChange={updateOpen}
        />
      </div>,
    );
  };
  const view = render(
    <div className="group/terminal-pane">
      <TerminalSearch
        addon={null}
        terminal={terminal}
        open={searchOpen}
        onOpenChange={updateOpen}
      />
    </div>,
  );
  textarea.focus();
  return { textarea, view };
}

function sendKey(
  key: string,
  modifiers: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {},
  target: EventTarget = document,
) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  target.dispatchEvent(event);
  return event;
}

describe("TerminalSearch shortcuts and closed controls", () => {
  it("leaves macOS Ctrl+F unprevented for the terminal and opens on Cmd+F", () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    renderSearch();

    const controlFind = sendKey("f", { ctrlKey: true });
    expect(controlFind.defaultPrevented).toBe(false);
    expect(
      screen.queryByRole("search", { name: "Search terminal output" }),
    ).toBeNull();

    const commandFind = sendKey("f", { metaKey: true });
    expect(commandFind.defaultPrevented).toBe(true);
    expect(
      screen.getByRole("search", { name: "Search terminal output" }),
    ).toBeTruthy();
  });

  it("keeps macOS Ctrl+G available to the terminal while search is open", () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    renderSearch(true);

    expect(sendKey("g", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(sendKey("g", { metaKey: true }).defaultPrevented).toBe(true);
    expect(
      sendKey("g", { metaKey: true, shiftKey: true }).defaultPrevented,
    ).toBe(true);
  });

  it("leaves Escape in its terminal unprevented while search is open", () => {
    const { textarea } = renderSearch(true);
    textarea.focus();

    const escape = sendKey("Escape", {}, textarea);

    expect(escape.defaultPrevented).toBe(false);
    expect(
      screen.getByRole("search", { name: "Search terminal output" }),
    ).toBeTruthy();
  });

  it("does not let one pane consume another pane's Escape or Cmd+G", () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    renderSearch(true);
    const { textarea } = renderSearch(false);
    textarea.focus();

    const escape = sendKey("Escape", {}, textarea);
    const commandG = sendKey("g", { metaKey: true }, textarea);

    expect(escape.defaultPrevented).toBe(false);
    expect(commandG.defaultPrevented).toBe(false);
    expect(
      screen.getAllByRole("search", { name: "Search terminal output" }),
    ).toHaveLength(1);
  });

  it("closes with Escape when focus has moved to a search control", () => {
    renderSearch(true);
    const next = screen.getByRole("button", { name: "Next match" });
    next.focus();

    const escape = sendKey("Escape", {}, next);

    expect(escape.defaultPrevented).toBe(true);
    expect(
      screen.queryByRole("search", { name: "Search terminal output" }),
    ).toBeNull();
  });

  it("uses Ctrl+Shift+F outside macOS and reveals its closed button on hover or focus", () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "Linux x86_64",
    });
    renderSearch();

    const button = screen.getByRole("button", {
      name: "Search terminal output",
    });
    expect(button.className).toContain("opacity-0");
    expect(button.className).toContain("pointer-events-none");
    expect(button.className).toContain("group-hover/terminal-pane:opacity-100");
    expect(button.className).toContain(
      "group-focus-within/terminal-pane:opacity-100",
    );
    expect(sendKey("f", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(
      sendKey("f", { ctrlKey: true, shiftKey: true }).defaultPrevented,
    ).toBe(true);
  });
});
