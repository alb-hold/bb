import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTerminalWebglRenderer } from "./terminal-webgl-renderer";

function setupRenderer({ visible = true, failLoads = false } = {}) {
  vi.useFakeTimers();
  const root: Pick<HTMLElement, "dataset"> = { dataset: {} };
  const addons: Array<{
    activate: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    onContextLoss: (listener: () => void) => { dispose: () => void };
    lose: () => void;
  }> = [];
  const createAddon = vi.fn(() => {
    let listener = () => {};
    const addon = {
      activate: vi.fn(),
      dispose: vi.fn(),
      onContextLoss: (nextListener: () => void) => {
        listener = nextListener;
        return { dispose: vi.fn() };
      },
      lose: () => listener(),
    };
    addons.push(addon);
    return addon;
  });
  const terminal = {
    loadAddon: vi.fn(() => {
      if (failLoads) {
        throw new Error("WebGL unavailable");
      }
    }),
  };
  const renderer = loadTerminalWebglRenderer(terminal, createAddon, {
    root,
    visible,
  });
  return { root, addons, createAddon, terminal, renderer };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("terminal WebGL lifecycle", () => {
  it("recreates a lost context and reports the active renderer", () => {
    const { addons, renderer, root, terminal } = setupRenderer();
    expect(root.dataset.terminalRenderer).toBe("webgl");

    addons[0]!.lose();

    expect(root.dataset.terminalRenderer).toBe("dom");
    expect(root.dataset.terminalContextLossCount).toBe("1");
    expect(addons[0]!.dispose).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(100);

    expect(terminal.loadAddon).toHaveBeenCalledTimes(2);
    expect(root.dataset.terminalRenderer).toBe("webgl");
    expect(renderer.renderer).toBe("webgl");
    renderer.dispose();
  });

  it("backs off and stops when replacement contexts keep failing", () => {
    const { addons, renderer, root, terminal } = setupRenderer();
    terminal.loadAddon.mockImplementation(() => {
      throw new Error("GPU unavailable");
    });
    addons[0]!.lose();
    vi.advanceTimersByTime(99);
    expect(terminal.loadAddon).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(terminal.loadAddon).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(199);
    expect(terminal.loadAddon).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(terminal.loadAddon).toHaveBeenCalledTimes(3);
    vi.runAllTimers();

    expect(terminal.loadAddon).toHaveBeenCalledTimes(4);
    expect(root.dataset.terminalRenderer).toBe("dom");
    expect(addons.every((addon) => addon.dispose.mock.calls.length === 1)).toBe(
      true,
    );
    renderer.dispose();
  });

  it("bounds recovery even when every replacement immediately loses its context", () => {
    const { addons, renderer, root, terminal } = setupRenderer();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      addons.at(-1)!.lose();
      vi.runAllTimers();
    }
    expect(terminal.loadAddon).toHaveBeenCalledTimes(4);
    expect(root.dataset.terminalRenderer).toBe("dom");
    expect(root.dataset.terminalContextLossCount).toBe("4");
    renderer.dispose();
  });

  it("keeps unsupported WebGL on DOM without repeated initialization", () => {
    const { addons, createAddon, renderer, root } = setupRenderer({
      failLoads: true,
    });
    vi.runAllTimers();
    renderer.setVisible(false);
    renderer.setVisible(true);
    vi.runAllTimers();
    expect(createAddon).toHaveBeenCalledOnce();
    expect(addons[0]!.dispose).toHaveBeenCalledOnce();
    expect(root.dataset.terminalRenderer).toBe("dom");
    renderer.dispose();
  });

  it("starts a fresh recovery budget after a stable period", () => {
    const { addons, renderer, root, terminal } = setupRenderer();
    for (let loss = 0; loss < 5; loss += 1) {
      vi.advanceTimersByTime(10_000);
      addons.at(-1)!.lose();
      vi.advanceTimersByTime(100);
    }
    expect(terminal.loadAddon).toHaveBeenCalledTimes(6);
    expect(root.dataset.terminalRenderer).toBe("webgl");
    expect(root.dataset.terminalContextLossCount).toBe("5");
    renderer.dispose();
  });

  it("does not allocate a context for an initially hidden terminal", () => {
    const { renderer, root, terminal } = setupRenderer({ visible: false });
    expect(terminal.loadAddon).not.toHaveBeenCalled();
    expect(root.dataset.terminalRenderer).toBe("dom");
    renderer.setVisible(true);
    expect(terminal.loadAddon).toHaveBeenCalledOnce();
    expect(root.dataset.terminalRenderer).toBe("webgl");
    renderer.dispose();
  });

  it("releases hidden contexts and reacquires exactly once on visibility", () => {
    const { addons, renderer, root, terminal } = setupRenderer();
    renderer.setVisible(false);
    expect(addons[0]!.dispose).toHaveBeenCalledOnce();
    expect(root.dataset.terminalRenderer).toBe("dom");
    renderer.setVisible(false);
    renderer.setVisible(true);
    renderer.setVisible(true);
    expect(terminal.loadAddon).toHaveBeenCalledTimes(2);
    expect(root.dataset.terminalRenderer).toBe("webgl");
    renderer.dispose();
  });

  it("cancels recovery while hidden and resumes it when shown", () => {
    const { addons, renderer, root, terminal } = setupRenderer();
    addons[0]!.lose();
    renderer.setVisible(false);
    vi.runAllTimers();
    expect(terminal.loadAddon).toHaveBeenCalledOnce();
    renderer.setVisible(true);
    expect(terminal.loadAddon).toHaveBeenCalledTimes(2);
    expect(root.dataset.terminalRenderer).toBe("webgl");
    renderer.dispose();
  });

  it("does not recover after teardown or from a stale context-loss callback", () => {
    const { addons, renderer, root, terminal } = setupRenderer();
    renderer.setVisible(false);
    renderer.setVisible(true);
    addons[0]!.lose();
    expect(root.dataset.terminalRenderer).toBe("webgl");
    addons[1]!.lose();
    renderer.dispose();
    renderer.setVisible(true);
    vi.runAllTimers();
    expect(terminal.loadAddon).toHaveBeenCalledTimes(2);
    expect(root.dataset.terminalRenderer).toBe("dom");
    expect(addons[1]!.dispose).toHaveBeenCalledOnce();
  });
});
