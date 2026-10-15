import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { writeTerminalOutput } from "./ThreadTerminalView";
import { setTerminalRenderDemand } from "./terminal-render-demand";

function makeTerminal(paused = false) {
  const renderService = { _isPaused: paused, _needsFullRefresh: false };
  const refresh = vi.fn();
  const terminal = {
    _core: { _renderService: renderService },
    refresh,
    rows: 24,
  } as unknown as Terminal;
  return { renderService, refresh, terminal };
}

describe("setTerminalRenderDemand", () => {
  it("pauses rendering while preserving the terminal parser", () => {
    const { renderService, refresh, terminal } = makeTerminal();

    expect(setTerminalRenderDemand(terminal, false)).toBe(true);

    expect(renderService._isPaused).toBe(true);
    renderService._isPaused = false;
    expect(renderService._isPaused).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("requests one full render when visibility returns", () => {
    const { renderService, refresh, terminal } = makeTerminal(true);

    expect(setTerminalRenderDemand(terminal, true)).toBe(true);
    expect(setTerminalRenderDemand(terminal, true)).toBe(false);

    expect(renderService._isPaused).toBe(true);
    expect(refresh).not.toHaveBeenCalled();

    renderService._isPaused = false;

    expect(renderService._isPaused).toBe(false);
    expect(renderService._needsFullRefresh).toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(0, 23);
  });

  it("keeps hidden demand latched when the renderer was already paused", () => {
    const { renderService, refresh, terminal } = makeTerminal(true);

    expect(setTerminalRenderDemand(terminal, false)).toBe(true);

    renderService._isPaused = false;

    expect(renderService._isPaused).toBe(true);
    expect(setTerminalRenderDemand(terminal, false)).toBe(false);
    expect(renderService._isPaused).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps xterm's pause active when visibility returns until xterm resumes", () => {
    const { renderService, refresh, terminal } = makeTerminal();

    setTerminalRenderDemand(terminal, false);
    renderService._isPaused = true;
    expect(setTerminalRenderDemand(terminal, true)).toBe(true);

    expect(renderService._isPaused).toBe(true);
    expect(refresh).not.toHaveBeenCalled();

    renderService._isPaused = false;

    expect(renderService._isPaused).toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(0, 23);
  });

  it("leaves terminals without the pinned renderer service untouched", () => {
    const refresh = vi.fn();
    const terminal = { refresh, rows: 24 } as unknown as Terminal;

    expect(setTerminalRenderDemand(terminal, false)).toBe(false);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("continues parsing and acknowledging output while rendering is paused", () => {
    const { terminal } = makeTerminal();
    const write = vi.fn((_data: string, callback?: () => void) => callback?.());
    const acknowledge = vi.fn();
    const replayWriteState = { suppressedWriteCount: 0 };
    Object.assign(terminal, { write });
    setTerminalRenderDemand(terminal, false);

    writeTerminalOutput({
      data: "output while hidden",
      isReplay: false,
      onParsed: acknowledge,
      replayWriteState,
      terminal,
    });

    expect(write).toHaveBeenCalledWith(
      "output while hidden",
      expect.any(Function),
    );
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(replayWriteState.suppressedWriteCount).toBe(0);
  });
});
