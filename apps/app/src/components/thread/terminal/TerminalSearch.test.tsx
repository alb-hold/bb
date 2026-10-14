// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { TerminalSearchAddonInstance } from "./terminal-search-addon";
import { TerminalMobileControls } from "./TerminalMobileControls";
import { TerminalSearch } from "./TerminalSearch";
import { loadOptionalTerminalSearchAddon } from "./terminal-search-addon";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document
    .querySelectorAll("textarea")
    .forEach((textarea) => textarea.remove());
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "",
  });
});

function createSearchAddon(): TerminalSearchAddonInstance {
  return {
    clearDecorations: vi.fn(),
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
  } as unknown as TerminalSearchAddonInstance;
}

function renderSearch(
  open = false,
  addon: TerminalSearchAddonInstance | null = null,
) {
  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  const terminal = { textarea } as unknown as Terminal;
  let searchOpen = open;
  const updateOpen = (value: boolean) => {
    searchOpen = value;
    view.rerender(
      <div className="group/terminal-pane">
        <TerminalSearch
          addon={addon}
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
        addon={addon}
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
  it("does not open search shortcuts when the optional add-on failed to load", async () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    const addonModule = await loadOptionalTerminalSearchAddon(async () => {
      throw new Error("search add-on unavailable");
    });
    expect(addonModule).toBeNull();
    const { textarea } = renderSearch();

    const controlFind = sendKey("f", { ctrlKey: true });
    expect(controlFind.defaultPrevented).toBe(false);
    const commandFind = sendKey("f", { metaKey: true });
    expect.soft(commandFind.defaultPrevented).toBe(false);
    expect.soft(
      screen.queryByRole("search", { name: "Search terminal output" }),
    ).toBeNull();

    render(
      <TerminalMobileControls
        controlActive={false}
        disabled={false}
        onArrow={vi.fn()}
        onControlChange={vi.fn()}
        onInput={vi.fn()}
        onKeyboardToggle={vi.fn()}
        onPaste={vi.fn()}
        onSearch={vi.fn()}
        searchAvailable={addonModule !== null}
        onSelectText={vi.fn()}
      />,
    );
    const mobileControls = document.querySelector(
      "[data-terminal-mobile-controls]",
    );
    expect.soft(
      mobileControls?.querySelector(
        'button[aria-label="Search terminal output"]',
      ),
    ).toBeNull();
    expect(
      (screen.getByRole("button", {
        name: "Search terminal output",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);

    const terminalReceivedKey = vi.fn();
    textarea.addEventListener("keydown", terminalReceivedKey);
    const terminalKey = sendKey("x", {}, textarea);
    textarea.removeEventListener("keydown", terminalReceivedKey);
    expect(terminalKey.defaultPrevented).toBe(false);
    expect(terminalReceivedKey).toHaveBeenCalledOnce();
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

  it("opens on Cmd+F when the search add-on is available", () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    renderSearch(false, createSearchAddon());

    const commandFind = sendKey("f", { metaKey: true });

    expect(commandFind.defaultPrevented).toBe(true);
    expect(
      screen.getByRole("search", { name: "Search terminal output" }),
    ).toBeTruthy();
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

  it("opens from Ctrl+Shift+F outside macOS when the add-on is available", () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "Linux x86_64",
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    renderSearch(false, createSearchAddon());

    const button = screen.getByRole("button", {
      name: "Search terminal output",
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);
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
    expect(
      screen.getByRole("search", { name: "Search terminal output" }),
    ).toBeTruthy();
  });
});
