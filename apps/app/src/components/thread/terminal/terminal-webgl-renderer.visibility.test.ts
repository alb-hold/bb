// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadTerminalWebglRenderer,
  observeTerminalWebglVisibility,
} from "./terminal-webgl-renderer";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function setupVisibility() {
  const root = document.createElement("div");
  document.body.append(root);
  let box = new DOMRect(10, 10, 300, 200);
  let panelOpen = true;
  let documentVisible = true;
  let resize = () => {};
  let intersect = (_visible: boolean) => {};
  const disconnectResize = vi.fn();
  const disconnectIntersection = vi.fn();
  vi.spyOn(root, "getBoundingClientRect").mockImplementation(() => box);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
    documentVisible ? "visible" : "hidden",
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnectResize;
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = (visible: boolean) =>
          callback(
            [
              {
                target: root,
                isIntersecting: visible,
                boundingClientRect: box,
                intersectionRect: visible ? box : new DOMRect(),
                intersectionRatio: visible ? 1 : 0,
                rootBounds: null,
                time: 0,
              },
            ],
            this as unknown as IntersectionObserver,
          );
      }
      observe() {}
      disconnect = disconnectIntersection;
    },
  );
  const createAddon = vi.fn(() => ({
    activate: vi.fn(),
    dispose: vi.fn(),
    onContextLoss: () => ({ dispose: vi.fn() }),
  }));
  const renderer = loadTerminalWebglRenderer(
    { loadAddon: vi.fn() },
    createAddon,
    {
      root,
      visible: false,
    },
  );
  const observer = observeTerminalWebglVisibility({
    root,
    renderer,
    isPanelOpen: () => panelOpen,
  });
  return {
    root,
    renderer,
    observer,
    createAddon,
    disconnectResize,
    disconnectIntersection,
    intersect: (visible: boolean) => intersect(visible),
    resize: (nextBox: DOMRect) => {
      box = nextBox;
      resize();
    },
    openPanel: (open: boolean) => {
      panelOpen = open;
      observer.sync();
    },
    showDocument: (visible: boolean) => {
      documentVisible = visible;
      document.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

describe("terminal visibility signals", () => {
  it("releases and reacquires the addon for closed panes and background documents", () => {
    const state = setupVisibility();
    expect(state.root.dataset.terminalRenderer).toBe("webgl");
    state.openPanel(false);
    expect(state.root.dataset.terminalRenderer).toBe("dom");
    state.showDocument(false);
    state.openPanel(true);
    expect(state.createAddon).toHaveBeenCalledOnce();
    state.showDocument(true);
    expect(state.createAddon).toHaveBeenCalledTimes(2);
    expect(state.root.dataset.terminalRenderer).toBe("webgl");
    state.observer.dispose();
    state.renderer.dispose();
  });

  it("releases contexts for zero-size, off-screen and clipped panes", () => {
    const state = setupVisibility();
    for (const box of [
      new DOMRect(0, 0, 0, 0),
      new DOMRect(-400, 0, 300, 200),
    ]) {
      state.resize(box);
      expect(state.root.dataset.terminalRenderer).toBe("dom");
      state.resize(new DOMRect(10, 10, 300, 200));
      expect(state.root.dataset.terminalRenderer).toBe("webgl");
    }
    state.intersect(false);
    expect(state.root.dataset.terminalRenderer).toBe("dom");
    state.intersect(true);
    expect(state.root.dataset.terminalRenderer).toBe("webgl");
    state.observer.dispose();
    state.renderer.dispose();
    state.showDocument(false);
    state.showDocument(true);
    state.intersect(true);
    expect(state.createAddon).toHaveBeenCalledTimes(4);
    expect(state.disconnectResize).toHaveBeenCalledOnce();
    expect(state.disconnectIntersection).toHaveBeenCalledOnce();
  });

  it("explicitly loses released GPU contexts without reporting a renderer failure", () => {
    const root = document.createElement("div");
    const canvas = document.createElement("canvas");
    root.append(canvas);
    const loseContext = vi.fn();
    const context = {
      getExtension: () => ({ loseContext }),
      isContextLost: () => false,
    };
    vi.spyOn(canvas, "getContext").mockReturnValue(
      context as unknown as WebGL2RenderingContext,
    );
    const renderer = loadTerminalWebglRenderer(
      { element: root, loadAddon: vi.fn() },
      () => ({
        activate: vi.fn(),
        dispose: vi.fn(),
        onContextLoss: () => ({ dispose: vi.fn() }),
      }),
      { root },
    );
    renderer.setVisible(false);
    expect(loseContext).toHaveBeenCalledOnce();
    expect(root.dataset.terminalContextLossCount).toBe("0");
    renderer.dispose();
    expect(loseContext).toHaveBeenCalledOnce();
  });
});
