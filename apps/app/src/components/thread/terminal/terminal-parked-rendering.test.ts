// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { TerminalWebSocketTransport, type TerminalBrowserSocket } from "@bb/client-core";
import { releaseParkedTerminalRendering } from "./terminal-parked-rendering";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("releases parked DOM rows and restores the same buffer and grid without resizing or claiming size", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    measureText: (text: string) => ({ width: text.length * 8 }),
  } as unknown as CanvasRenderingContext2D);
  const host = document.createElement("div");
  document.body.append(host);
  const terminal = new Terminal({ cols: 44, rows: 12, allowProposedApi: true });
  const sent: string[] = [];
  const socket: TerminalBrowserSocket = {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: (data) => sent.push(data),
    close: () => {},
  };
  const transport = new TerminalWebSocketTransport({
    url: "ws://localhost/fixture-terminal",
    createSocket: () => socket,
    shouldReconnect: () => false,
    onMessage: () => {},
  });
  try {
    terminal.open(host);
    await new Promise<void>((resolve) => terminal.write("retained output", resolve));
    const rendered = () => host.querySelector(".xterm-rows")?.textContent ?? "";
    terminal.refresh(0, terminal.rows - 1);
    await vi.waitFor(() => expect(rendered()).toContain("retained output"));
    const resized = vi.fn();
    terminal.onResize(resized);
    terminal.onResize(({ cols, rows }) => transport.sendResize(cols, rows, true));
    transport.start();
    socket.onopen?.(new Event("open"));
    transport.sendResize(terminal.cols, terminal.rows, true);
    const claims = () => sent.map((data) => JSON.parse(data)).filter((message) => message.type === "resize" && message.claim);
    expect(claims()).toHaveLength(1);
    const originalFont = terminal.options.fontFamily;
    const fontChanges = vi.spyOn(terminal.options, "fontFamily", "set");
    const scrollbars = Array.from(host.querySelectorAll<HTMLElement>(".xterm-scrollbar"));
    expect(scrollbars.length).toBeGreaterThan(0);
    const scrollbarDisplays = scrollbars.map((scrollbar) => scrollbar.style.display);
    for (let cycle = 0; cycle < 3; cycle++) {
      host.style.display = "none";
      transport.setParked(true);
      const restoreRendering = releaseParkedTerminalRendering(terminal);
      expect(scrollbars.every((scrollbar) => scrollbar.style.display === "none")).toBe(true);
      expect(rendered()).toBe("");
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("retained output");
      expect([terminal.cols, terminal.rows]).toEqual([44, 12]);
      expect(terminal.options.fontFamily).toBe(originalFont);
      expect(fontChanges).not.toHaveBeenCalled();
      expect(resized).not.toHaveBeenCalled();
      expect(claims()).toHaveLength(1);
      host.style.display = "";
      restoreRendering();
      expect(scrollbars.map((scrollbar) => scrollbar.style.display)).toEqual(scrollbarDisplays);
      transport.setParked(false);
      transport.setVisible(true);
      terminal.refresh(0, terminal.rows - 1);
      await vi.waitFor(() => expect(rendered()).toContain("retained output"));
      expect(resized).not.toHaveBeenCalled();
      expect(claims()).toHaveLength(1);
    }
  } finally {
    transport.dispose();
    terminal.dispose();
  }
});
