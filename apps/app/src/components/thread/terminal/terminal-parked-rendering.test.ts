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
    const scrollbarPositions = scrollbars.map((scrollbar) => ({
      parent: scrollbar.parentNode,
      next: scrollbar.nextSibling,
    }));
    for (let cycle = 0; cycle < 3; cycle++) {
      host.style.display = "none";
      transport.setParked(true);
      const restoreRendering = releaseParkedTerminalRendering(terminal);
      expect(scrollbars.every((scrollbar) => !scrollbar.isConnected)).toBe(true);
      expect(rendered()).toBe("");
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("retained output");
      expect([terminal.cols, terminal.rows]).toEqual([44, 12]);
      expect(terminal.options.fontFamily).toBe(originalFont);
      expect(fontChanges).not.toHaveBeenCalled();
      expect(resized).not.toHaveBeenCalled();
      expect(claims()).toHaveLength(1);
      host.style.display = "";
      restoreRendering();
      expect(scrollbars.every((scrollbar) => scrollbar.isConnected)).toBe(true);
      expect(
        scrollbars.map((scrollbar) => ({
          parent: scrollbar.parentNode,
          next: scrollbar.nextSibling,
        })),
      ).toEqual(scrollbarPositions);
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

function openTerminal(): { host: HTMLElement; terminal: Terminal } {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    measureText: (text: string) => ({ width: text.length * 8 }),
  } as unknown as CanvasRenderingContext2D);
  const host = document.createElement("div");
  document.body.append(host);
  const terminal = new Terminal({ cols: 44, rows: 12, allowProposedApi: true });
  terminal.open(host);
  return { host, terminal };
}

function scrollbarsOf(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>(".xterm-scrollbar"));
}

it("keeps reveal and fade class writes of a parked scrollbar out of the document", async () => {
  const { host, terminal } = openTerminal();
  try {
    const scrollbars = scrollbarsOf(host);
    expect(scrollbars.length).toBeGreaterThan(0);
    const restore = releaseParkedTerminalRendering(terminal);
    let records = 0;
    const observer = new MutationObserver((batch) => {
      records += batch.length;
    });
    observer.observe(host, { attributes: true, subtree: true });
    try {
      for (let flip = 0; flip < 10; flip++) {
        for (const scrollbar of scrollbars) {
          scrollbar.className = "xterm-visible xterm-scrollbar xterm-vertical";
          scrollbar.className =
            "xterm-invisible xterm-scrollbar xterm-vertical xterm-fade";
        }
      }
      await Promise.resolve();
      records += observer.takeRecords().length;
      expect(records).toBe(0);
    } finally {
      observer.disconnect();
    }
    restore();
    expect(scrollbars.every((scrollbar) => scrollbar.isConnected)).toBe(true);
  } finally {
    terminal.dispose();
  }
});

it("does not insert a stale scrollbar when xterm created a new one while parked", () => {
  const { host, terminal } = openTerminal();
  try {
    const stale = scrollbarsOf(host);
    const parent = stale[0]?.parentNode;
    expect(parent).toBeTruthy();
    const restore = releaseParkedTerminalRendering(terminal);
    const fresh = document.createElement("div");
    fresh.className = "xterm-scrollbar xterm-vertical";
    parent?.appendChild(fresh);
    restore();
    expect(stale.every((scrollbar) => !scrollbar.isConnected)).toBe(true);
    expect(scrollbarsOf(host)).toEqual([fresh]);
  } finally {
    terminal.dispose();
  }
});

it("appends to the parent when the remembered sibling is gone and restores only once", () => {
  const { host, terminal } = openTerminal();
  try {
    const scrollbars = scrollbarsOf(host);
    const parent = scrollbars[0]?.parentNode as HTMLElement;
    const trailing = scrollbars.at(-1)?.nextSibling ?? null;
    const restore = releaseParkedTerminalRendering(terminal);
    trailing?.remove();
    restore();
    expect(scrollbars.every((scrollbar) => scrollbar.parentNode === parent)).toBe(true);
    expect(scrollbarsOf(host)).toEqual(scrollbars);
    expect(parent.lastChild).toBe(scrollbars.at(-1));
    const snapshot = Array.from(parent.childNodes);
    restore();
    expect(Array.from(parent.childNodes)).toEqual(snapshot);
  } finally {
    terminal.dispose();
  }
});

it("skips restoring scrollbars into a parent that xterm has disposed", () => {
  const { host, terminal } = openTerminal();
  const scrollbars = scrollbarsOf(host);
  const restore = releaseParkedTerminalRendering(terminal);
  terminal.dispose();
  expect(() => restore()).not.toThrow();
  expect(scrollbars.every((scrollbar) => !scrollbar.isConnected)).toBe(true);
});
