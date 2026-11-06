// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetPluginLogoStoreForTest,
  setPluginLogoUrls,
} from "@/lib/plugin-logos";
import { COMPACT_VIEWPORT_QUERY } from "@bb/shared-ui/hooks/use-compact-viewport";
import { POINTER_COARSE_QUERY } from "@bb/shared-ui/hooks/use-pointer-coarse";
import {
  findMessageActionTooltipCollisionBoundary,
  MessageActionBar,
} from "./MessageActionBar";

const TIMESTAMP = Date.UTC(2026, 8, 30, 16, 5);

afterEach(() => {
  cleanup();
  resetPluginLogoStoreForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function installControlledResizeObserver() {
  const observations: { callback: ResizeObserverCallback; node: Element }[] =
    [];
  class ControlledResizeObserver {
    readonly #callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }
    observe(node: Element) {
      observations.push({ callback: this.#callback, node });
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  return {
    reportWidth(width: number) {
      act(() => {
        for (const { callback, node } of observations) {
          callback(
            [
              {
                target: node,
                contentRect: { width, height: 20 },
              } as unknown as ResizeObserverEntry,
            ],
            undefined as unknown as ResizeObserver,
          );
        }
      });
    },
  };
}

function mockMobileCoarsePointer() {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query === COMPACT_VIEWPORT_QUERY || query === POINTER_COARSE_QUERY,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

function openDesktopMenu() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Message actions" }),
  );
  return screen.getByRole("menu");
}

describe("MessageActionBar", () => {
  it("keeps revealed phone action extensions unclipped and disjoint", () => {
    mockMobileCoarsePointer();
    const { container } = render(
      <div data-touch-actions-visible="true">
        <MessageActionBar
          timestamp={TIMESTAMP}
          messageText="An answer."
          alignment="start"
          mobileActionDisplay="inline"
        />
      </div>,
    );
    const trigger = screen.getByRole("button", { name: "Message actions" });
    expect(trigger.getAttribute("data-compact-touch")).toBe("action-menu");
    expect(trigger.classList.contains("max-md:pointer-coarse:ml-0")).toBe(true);
    for (
      let node: HTMLElement | null = trigger;
      node && node !== container;
      node = node.parentElement
    ) {
      expect(node.className).not.toMatch(
        /(?:^| )overflow-(?:hidden|clip)(?: |$)/,
      );
      expect(node.style.overflow).not.toMatch(/hidden|clip/);
      expect(node.style.clipPath).toBe("");
    }
  });

  it.each([
    [360, "idle"],
    [390, "touch"],
    [390, "focus"],
    [1280, "idle"],
    [1280, "hover"],
    [1280, "focus"],
  ])(
    "aligns the token summary with the message column at %s px with %s actions",
    (width, state) => {
      const { container } = render(
        <div
          style={{ width }}
          data-touch-actions-visible={state === "touch" ? "true" : "false"}
        >
          <MessageActionBar
            timestamp={TIMESTAMP}
            messageText="An answer."
            alignment="start"
            mobileActionDisplay="inline"
            footerAdornment={<span data-thread-turn-tokens>Σ 2.8M</span>}
          />
        </div>,
      );
      const tokenSummary = container.querySelector("[data-thread-turn-tokens]");
      const actionButton = screen.getByRole("button", {
        name: "Message actions",
      });

      if (state === "hover") fireEvent.mouseEnter(actionButton.parentElement!);
      if (state === "focus") actionButton.focus();
      expect(tokenSummary).toBeTruthy();
      expect(tokenSummary?.parentElement).toBe(
        container.querySelector("[data-message-action-slot]"),
      );
      expect(tokenSummary?.closest("[data-message-action-row]")).toBeNull();
      expect(tokenSummary?.parentElement?.className).not.toMatch(/-m[ls]-/);
      expect(actionButton.getAttribute("data-compact-touch")).toBe(
        "action-menu",
      );
      expect(
        screen
          .getByRole("button", { name: "Copy message" })
          .getAttribute("data-compact-touch"),
      ).toBe("action");
    },
  );

  it("uses the nearest thread window as the tooltip collision boundary", () => {
    const threadWindow = document.createElement("div");
    threadWindow.setAttribute("data-thread-window", "");
    const sidePanel = document.createElement("aside");
    const actionBar = document.createElement("div");
    threadWindow.append(actionBar);
    document.body.append(threadWindow, sidePanel);

    expect(findMessageActionTooltipCollisionBoundary(actionBar)).toBe(
      threadWindow,
    );
    expect(
      findMessageActionTooltipCollisionBoundary(sidePanel),
    ).toBeUndefined();
  });

  it("keeps candidates inline in priority order and reserves the menu for trailing actions", () => {
    const resizeObserver = installControlledResizeObserver();
    setPluginLogoUrls(
      new Map([
        [
          "demo",
          {
            displayName: "Demo",
            icon: "Check",
            compactIconUrl: "/demo.svg",
            logoUrl: null,
            logoDarkUrl: null,
            icons: new Map(),
          },
        ],
      ]),
    );
    const onPluginSelect = vi.fn();
    const onCopyLink = vi.fn();
    const { container } = render(
      <MessageActionBar
        timestamp={TIMESTAMP}
        messageText="An answer."
        alignment="start"
        mobileActionDisplay="inline"
        onEdit={vi.fn()}
        onCopyLink={onCopyLink}
        onAddToChat={vi.fn()}
        onFork={vi.fn()}
        pluginActions={[
          {
            key: "demo/summarize/1",
            pluginId: "demo",
            icon: "Zap",
            label: "Summarize",
            onSelect: onPluginSelect,
          },
        ]}
      />,
    );
    resizeObserver.reportWidth(100);

    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button[aria-label]")]
        .map((button) => button.getAttribute("aria-label"))
        .filter((label) => label !== "Message actions"),
    ).toEqual(["Copy message", "Edit message", "Summarize"]);
    expect(
      screen
        .getByRole("button", { name: "Summarize" })
        .querySelector('[data-icon="Zap"]'),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Summarize" }));
    expect(onPluginSelect).toHaveBeenCalledTimes(1);

    const menu = openDesktopMenu();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Copy link", "Add to chat", "Fork into new thread"]);
    expect(menu.getAttribute("data-side")).toBe("bottom");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy link" }));
    expect(onCopyLink).toHaveBeenCalledTimes(1);
  });

  it("moves candidates that do not fit into the menu from the end", () => {
    const resizeObserver = installControlledResizeObserver();
    render(
      <MessageActionBar
        timestamp={TIMESTAMP}
        messageText="An answer."
        alignment="end"
        mobileActionDisplay="inline"
        onEdit={vi.fn()}
        onCopyLink={vi.fn()}
        onAddToChat={vi.fn()}
        onFork={vi.fn()}
        pluginActions={[
          {
            key: "demo/summarize/1",
            pluginId: null,
            icon: "Zap",
            label: "Summarize",
            onSelect: vi.fn(),
          },
          {
            key: "demo/translate/1",
            pluginId: null,
            icon: "Languages",
            label: "Translate",
            onSelect: vi.fn(),
          },
        ]}
      />,
    );
    resizeObserver.reportWidth(72);

    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit message" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Summarize" })).toBeNull();

    expect(
      within(openDesktopMenu())
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Copy link",
      "Summarize",
      "Translate",
      "Add to chat",
      "Fork into new thread",
    ]);
  });

  it("puts every candidate in the menu when none fit", () => {
    const resizeObserver = installControlledResizeObserver();
    render(
      <MessageActionBar
        timestamp={TIMESTAMP}
        messageText="An answer."
        alignment="end"
        mobileActionDisplay="inline"
        onEdit={vi.fn()}
        onAddToChat={vi.fn()}
        onFork={vi.fn()}
      />,
    );
    resizeObserver.reportWidth(30);

    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
    expect(
      within(openDesktopMenu())
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Copy message",
      "Edit message",
      "Add to chat",
      "Fork into new thread",
    ]);
  });

  it("shows a timestamp-only footer in the menu", () => {
    render(
      <MessageActionBar
        timestamp={TIMESTAMP}
        messageText="An answer."
        alignment="start"
        mobileActionDisplay="inline"
      />,
    );

    const menu = openDesktopMenu();
    const metadata = menu.querySelector<HTMLElement>("[data-message-metadata]");
    const time = within(metadata!).getByRole("time");
    expect(time.getAttribute("datetime")).toBe("2026-09-30T16:05:00.000Z");
    expect(time.textContent).not.toBe("");
    expect(metadata?.textContent).not.toMatch(/model|reasoning/i);
  });

  it("lists every action in the latest touch message drawer even when actions fit inline", async () => {
    mockMobileCoarsePointer();
    const resizeObserver = installControlledResizeObserver();
    const onFork = vi.fn();
    const onPluginSelect = vi.fn();
    render(
      <main data-testid="app-root">
        <MessageActionBar
          timestamp={TIMESTAMP}
          messageText="An answer."
          alignment="start"
          mobileActionDisplay="inline"
          onEdit={vi.fn()}
          onAddToChat={vi.fn()}
          onFork={onFork}
          pluginActions={[
            {
              key: "demo/summarize/1",
              pluginId: null,
              icon: "Zap",
              label: "Summarize",
              onSelect: onPluginSelect,
            },
          ]}
        />
      </main>,
    );
    resizeObserver.reportWidth(200);

    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Summarize" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));

    const drawer = await screen.findByRole("dialog", {
      name: "Message actions",
    });
    const menuItems = await within(drawer).findAllByRole("menuitem");
    expect(menuItems.map((item) => item.textContent)).toEqual([
      "Copy message",
      "Edit message",
      "Summarize",
      "Add to chat",
      "Fork into new thread",
    ]);
    resizeObserver.reportWidth(60);
    expect(screen.queryByRole("button", { name: "Summarize" })).toBeNull();
    expect(
      within(drawer)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Copy message",
      "Edit message",
      "Summarize",
      "Add to chat",
      "Fork into new thread",
    ]);
    expect(document.body.querySelector('[data-side="top"]')).toBeNull();
    expect(screen.getByTestId("app-root").hasAttribute("inert")).toBe(false);
    expect(screen.getByTestId("app-root").hasAttribute("aria-hidden")).toBe(
      false,
    );
    fireEvent.click(
      within(drawer).getByRole("menuitem", { name: "Fork into new thread" }),
    );
    expect(onFork).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
    fireEvent.click(
      await within(drawer).findByRole("menuitem", { name: "Summarize" }),
    );
    expect(onPluginSelect).toHaveBeenCalledTimes(1);
  });

  it("shows only the menu trigger on older touch messages", async () => {
    mockMobileCoarsePointer();
    const onCopyLink = vi.fn();
    render(
      <MessageActionBar
        timestamp={TIMESTAMP}
        messageText="An earlier answer."
        alignment="start"
        mobileActionDisplay="overflow"
        onEdit={vi.fn()}
        onCopyLink={onCopyLink}
        onAddToChat={vi.fn()}
        onFork={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));

    const drawer = await screen.findByRole("dialog", {
      name: "Message actions",
    });
    const menuItems = await within(drawer).findAllByRole("menuitem");
    expect(menuItems.map((item) => item.textContent)).toEqual([
      "Copy link",
      "Copy message",
      "Edit message",
      "Add to chat",
      "Fork into new thread",
    ]);
    fireEvent.click(
      within(drawer).getByRole("menuitem", { name: "Copy link" }),
    );
    expect(onCopyLink).toHaveBeenCalledTimes(1);
  });

  it("marks the action row while the menu is open", () => {
    render(
      <MessageActionBar
        timestamp={TIMESTAMP}
        messageText="An answer."
        alignment="end"
        mobileActionDisplay="inline"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Message actions" });
    const row = trigger.closest("[data-message-action-row]");

    expect(row?.hasAttribute("data-menu-open")).toBe(false);
    fireEvent.pointerDown(trigger);
    expect(row?.hasAttribute("data-menu-open")).toBe(true);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(row?.hasAttribute("data-menu-open")).toBe(false);
  });
});
