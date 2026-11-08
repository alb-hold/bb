// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { releaseParkedTerminalRendering } from "./terminal-parked-rendering";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("releases parked DOM rows and restores the same terminal buffer and grid", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    measureText: (text: string) => ({ width: text.length * 8 }),
  } as unknown as CanvasRenderingContext2D);
  const host = document.createElement("div");
  document.body.append(host);
  const terminal = new Terminal({ cols: 44, rows: 12, allowProposedApi: true });
  try {
    terminal.open(host);
    await new Promise<void>((resolve) => terminal.write("retained output", resolve));
    const rendered = () => host.querySelector(".xterm-rows")?.textContent ?? "";
    terminal.refresh(0, terminal.rows - 1);
    await vi.waitFor(() => expect(rendered()).toContain("retained output"));
    const resized = vi.fn();
    terminal.onResize(resized);
    const originalFont = terminal.options.fontFamily;
    for (let cycle = 0; cycle < 3; cycle++) {
      host.style.display = "none";
      releaseParkedTerminalRendering(terminal);
      expect(rendered()).toBe("");
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("retained output");
      expect([terminal.cols, terminal.rows]).toEqual([44, 12]);
      expect(terminal.options.fontFamily).toBe(originalFont);
      expect(resized).not.toHaveBeenCalled();
      host.style.display = "";
      terminal.refresh(0, terminal.rows - 1);
      await vi.waitFor(() => expect(rendered()).toContain("retained output"));
      expect(resized).not.toHaveBeenCalled();
    }
  } finally {
    terminal.dispose();
  }
});
