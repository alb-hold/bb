import { describe, expect, it, vi } from "vitest";
import { createTerminalSearchController } from "./terminal-search-controller";

function makeAddon() {
  let listener: ((event: { resultIndex: number; resultCount: number }) => void) | null = null;
  let currentIndex = -1;
  const emit = (index: number) => listener?.({ resultIndex: index, resultCount: 3 });
  const calls: string[] = [];
  return {
    calls,
    addon: {
      clearDecorations: vi.fn(),
      findNext: vi.fn((query: string) => {
        calls.push(query);
        currentIndex = currentIndex === 2 ? 0 : currentIndex + 1;
        emit(currentIndex);
        return true;
      }),
      findPrevious: vi.fn((query: string) => {
        calls.push(query);
        currentIndex = currentIndex === 0 ? 2 : currentIndex - 1;
        emit(currentIndex);
        return true;
      }),
      onDidChangeResults: vi.fn((next: typeof listener) => {
        listener = next;
        return { dispose: () => (listener = null) };
      }),
    },
  };
}

describe("terminal search controller", () => {
  it("navigates next and previous and reports wrapping match positions", () => {
    const { addon } = makeAddon();
    const onChange = vi.fn();
    const controller = createTerminalSearchController(addon, onChange);
    controller.setQuery("needle");
    controller.next();
    controller.next();
    controller.next();
    controller.previous();
    expect(addon.findNext).toHaveBeenLastCalledWith("needle", expect.anything());
    expect(addon.findPrevious).toHaveBeenCalledWith("needle", expect.anything());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      query: "needle",
      resultIndex: 3,
      resultCount: 3,
      error: null,
    }));
  });

  it("clears matches for an empty query without searching", () => {
    const { addon } = makeAddon();
    const onChange = vi.fn();
    const controller = createTerminalSearchController(addon, onChange);
    controller.setQuery("");
    expect(addon.findNext).not.toHaveBeenCalled();
    expect(addon.clearDecorations).toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      query: "",
      resultIndex: 0,
      resultCount: 0,
      error: null,
    }));
  });

  it("shows regex errors inline instead of throwing", () => {
    const { addon } = makeAddon();
    addon.findNext.mockImplementation(() => { throw new Error("Invalid regular expression"); });
    const onChange = vi.fn();
    const controller = createTerminalSearchController(addon, onChange);
    expect(() => controller.setQuery("[")).not.toThrow();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      error: "Invalid regular expression",
    }));
  });

  it("disposes result listeners and restores terminal focus when closed", () => {
    const { addon } = makeAddon();
    const focus = vi.fn();
    const controller = createTerminalSearchController(addon, vi.fn(), focus);
    controller.close();
    expect(addon.clearDecorations).toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce();
  });
});
