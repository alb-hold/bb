// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { Panel } from "react-resizable-panels";
import { afterEach, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { SecondaryPanelLayout } from "./SecondaryPanelLayout";
import { secondaryPanelWidthPercentAtom } from "./threadSecondaryPanelAtoms";

const originalAnimate = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "animate",
);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalAnimate)
    Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

function setup({ compact = false, reducedMotion = false } = {}) {
  const observers: (() => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: (entries: ResizeObserverEntry[]) => void) {
        observers.push(() => callback([]));
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query === "(prefers-reduced-motion: reduce)" && reducedMotion,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => false,
  }));
  const animations: Animation[] = [];
  const animate = vi.fn<HTMLElement["animate"]>().mockImplementation(() => {
    const animation = {
      cancel: vi.fn(),
      onfinish: null,
    } as unknown as Animation;
    animations.push(animation);
    return animation;
  });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const panel = this.closest<HTMLElement>('[data-panel-id="main"]');
      const width = compact
        ? 390
        : panel
          ? (960 * Number(panel.style.flexGrow)) / 100
          : 480;
      const isAnchor = this.hasAttribute("data-panel-layout-anchor");
      return new DOMRect(
        320 + (isAnchor ? Math.max(0, (width - 760) / 2) : 0),
        48,
        isAnchor ? Math.min(760, width) : width,
        604,
      );
    },
  );
  const store = createStore();
  store.set(secondaryPanelWidthPercentAtom, 50);
  const noop = () => {};
  const content = (activeTerminalId: string | null) => (
    <Provider store={store}>
      <CompactViewportOverrideProvider isCompactViewport={compact}>
        <SecondaryPanelLayout
          open={activeTerminalId !== null}
          onToggle={noop}
          onClose={noop}
          resetKey="thread"
          contentKey="thread"
          drawerLabel="Terminal"
          drawerFallback={null}
          mainPanelId="main"
          main={
            <>
              <div data-testid="conversation" data-panel-layout-anchor="">
                Conversation
              </div>
              <form data-testid="composer" data-panel-layout-anchor="">
                <textarea />
              </form>
            </>
          }
          composerHost={null}
          widthPercentAtom={secondaryPanelWidthPercentAtom}
          renderPanel={(args) =>
            args.presentation === "drawer" ? (
              <div>Terminal</div>
            ) : (
              <Panel
                id="terminal"
                defaultSize={activeTerminalId === null ? 0 : 50}
                collapsible
                collapsedSize={0}
                minSize={0}
              >
                <div data-testid="terminal">{activeTerminalId}</div>
              </Panel>
            )
          }
        />
      </CompactViewportOverrideProvider>
    </Provider>
  );
  const view = render(content(null));
  return {
    animate,
    animations,
    open: (id: string | null) => {
      view.rerender(content(id));
      observers.forEach((callback) => callback());
    },
    view,
  };
}

it("compensates the first frame of remote opens and closes without transforming the terminal", () => {
  const { animate, animations, open } = setup();
  const textarea = screen.getByRole("textbox");
  textarea.focus();
  open("terminal-1");
  expect(animate).toHaveBeenCalledTimes(2);
  expect(animate).toHaveBeenLastCalledWith(
    [{ transform: "translateX(100px)" }, { transform: "translateX(0px)" }],
    { duration: 200, easing: "cubic-bezier(0.32,0.72,0,1)" },
  );
  expect(animate.mock.contexts).toEqual([
    screen.getByTestId("conversation"),
    screen.getByTestId("composer"),
  ]);
  expect(
    Number(
      screen.getByTestId("terminal").closest<HTMLElement>("[data-panel]")?.style
        .flexGrow,
    ),
  ).toBe(50);
  expect(document.activeElement).toBe(textarea);
  for (const animation of animations)
    animation.onfinish?.call(
      animation,
      new Event("finish") as AnimationPlaybackEvent,
    );
  for (const animation of animations)
    expect(animation.cancel).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("conversation").style.transform).toBe("");
  for (let index = 2; index <= 8; index++) open(`terminal-${index}`);
  expect(animate).toHaveBeenCalledTimes(2);
  open(null);
  expect(animate).toHaveBeenLastCalledWith(
    [{ transform: "translateX(-100px)" }, { transform: "translateX(0px)" }],
    { duration: 200, easing: "cubic-bezier(0.32,0.72,0,1)" },
  );
});

it.each([
  "reduced motion",
  "compact",
  "recent pointer input",
  "recent keyboard input",
])("does not compensate panel opens for %s", (mode) => {
  const { animate, open } = setup({
    compact: mode === "compact",
    reducedMotion: mode === "reduced motion",
  });
  if (mode === "recent pointer input") fireEvent.pointerDown(window);
  if (mode === "recent keyboard input") fireEvent.keyDown(window, { key: "t" });
  open("terminal-1");
  expect(animate).not.toHaveBeenCalled();
});

it("cancels active compensation when the layout unmounts", () => {
  const { animations, open, view } = setup();
  open("terminal-1");
  expect(animations).toHaveLength(2);
  view.unmount();
  for (const animation of animations)
    expect(animation.cancel).toHaveBeenCalledTimes(1);
});
