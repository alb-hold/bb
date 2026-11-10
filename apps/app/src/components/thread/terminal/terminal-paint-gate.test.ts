// @vitest-environment jsdom
import type { IDisposable } from "@xterm/xterm";
import { afterEach, expect, it, vi } from "vitest";
import {
  holdTerminalPaint,
  isTerminalPaintHeld,
  revealTerminalAfterRender,
} from "./terminal-paint-gate";

afterEach(() => {
  vi.useRealTimers();
});

function fakeTerminal() {
  const listeners = new Set<() => void>();
  return {
    rows: 12,
    refresh: vi.fn<(start: number, end: number) => void>(),
    onRender: vi.fn((listener: () => void): IDisposable => {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    }),
    render: () => {
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

it("keeps the returning terminal hidden until its first render after unpark", () => {
  const root = document.createElement("div");
  const terminal = fakeTerminal();
  holdTerminalPaint(root);
  expect(isTerminalPaintHeld(root)).toBe(true);
  revealTerminalAfterRender(terminal, root);
  expect(terminal.refresh).toHaveBeenCalledWith(0, 11);
  expect(isTerminalPaintHeld(root)).toBe(true);
  terminal.render();
  expect(isTerminalPaintHeld(root)).toBe(false);
  expect(terminal.listenerCount()).toBe(0);
});

it("reveals after the fallback when no render arrives and ignores later renders", () => {
  vi.useFakeTimers();
  const root = document.createElement("div");
  const terminal = fakeTerminal();
  holdTerminalPaint(root);
  revealTerminalAfterRender(terminal, root);
  vi.advanceTimersByTime(399);
  expect(isTerminalPaintHeld(root)).toBe(true);
  vi.advanceTimersByTime(1);
  expect(isTerminalPaintHeld(root)).toBe(false);
  holdTerminalPaint(root);
  terminal.render();
  expect(isTerminalPaintHeld(root)).toBe(true);
});

it("reveals and unsubscribes when disposed before a render", () => {
  const root = document.createElement("div");
  const terminal = fakeTerminal();
  holdTerminalPaint(root);
  const reveal = revealTerminalAfterRender(terminal, root);
  reveal.dispose();
  expect(isTerminalPaintHeld(root)).toBe(false);
  expect(terminal.listenerCount()).toBe(0);
});
