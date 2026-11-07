import { Terminal } from "@xterm/xterm";
import { createTerminalGridMarker } from "@bb/domain";
import { expect, it, vi } from "vitest";
import { createTerminalOutputPipeline } from "./terminal-output-pipeline";

it("preserves write barriers and grid notifications without same-grid resize or refresh work", async () => {
  const terminal = new Terminal({ cols: 80, rows: 24 });
  const resize = vi.spyOn(terminal, "resize");
  const beforeResize = vi.fn();
  const afterResize = vi.fn();
  const onResize = vi.fn();
  const pipeline = createTerminalOutputPipeline(terminal, undefined, onResize, {
    beforeResize,
    afterResize,
  });
  try {
    await new Promise<void>((resolve) => pipeline.setGrid(80, 24, resolve));
    expect(resize).not.toHaveBeenCalled();
    expect(beforeResize).not.toHaveBeenCalled();
    expect(afterResize).not.toHaveBeenCalled();
    expect(onResize).toHaveBeenLastCalledWith(80, 24);
    await new Promise<void>((resolve) => pipeline.setGrid(100, 30, resolve));
    await new Promise<void>((resolve) =>
      pipeline.push(
        Buffer.from(
          createTerminalGridMarker({ cols: 100, rows: 30 }) + "after barrier",
        ),
        resolve,
      ),
    );
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(100, 30);
    expect(beforeResize).toHaveBeenCalledTimes(1);
    expect(afterResize).toHaveBeenCalledTimes(1);
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(
      "after barrier",
    );
  } finally {
    terminal.dispose();
  }
});
