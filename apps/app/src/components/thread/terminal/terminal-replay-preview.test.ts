// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalGridMarker } from "@bb/domain";
import { createTerminalOutputPipeline } from "./terminal-output-pipeline";
import {
  mountTerminalReplayPreview,
  TERMINAL_REPLAY_PREVIEW_FALLBACK_MS,
} from "./terminal-replay-preview";

const originalGetContext = HTMLCanvasElement.prototype.getContext;

afterEach(() => {
  vi.useRealTimers();
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

describe("terminal replay preview", () => {
  it("keeps the attached grid visible while replay hides historical grids", async () => {
    const context = new Proxy(
      {
        measureText: (text: string) => ({ width: text.length * 8 }),
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        createImageData: () => ({ data: new Uint8ClampedArray(4) }),
      } as Record<string, unknown>,
      {
        get(target, property) {
          const value = target[property as string];
          return value ?? (() => undefined);
        },
        set(target, property, value) {
          target[property as string] = value;
          return true;
        },
      },
    );
    HTMLCanvasElement.prototype.getContext = (() =>
      context) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    const parent = document.createElement("div");
    const historyContainer = document.createElement("div");
    parent.append(historyContainer);
    document.body.append(parent);

    const history = new Terminal({ cols: 120, rows: 36 });
    history.open(historyContainer);
    const preview = new Terminal({ cols: 120, rows: 36 });
    const cover = mountTerminalReplayPreview({
      container: historyContainer,
      initialFitGrid: { cols: 120, rows: 36 },
      canShowMismatchedFallback: () => false,
      terminal: preview,
    });
    expect(historyContainer.style.opacity).toBe("0");
    expect(getComputedStyle(historyContainer).opacity).toBe("0");
    expect(
      getComputedStyle(parent.querySelector("[data-terminal-replay-preview]")!)
        .visibility,
    ).toBe("visible");
    expect(preview.cols).toBe(120);
    expect(preview.rows).toBe(36);

    const pipeline = createTerminalOutputPipeline(history);
    for (const [cols, rows, text] of [
      [120, 36, "oldest historical frame"],
      [55, 56, "middle historical frame"],
      [51, 47, "current frame"],
    ] as const) {
      await new Promise<void>((resolve) =>
        pipeline.push(
          Buffer.from(`${createTerminalGridMarker({ cols, rows })}${text}\r\n`),
          resolve,
        ),
      );
      expect({ cols: history.cols, rows: history.rows }).toEqual({
        cols,
        rows,
      });
      expect(historyContainer.style.opacity).toBe("0");
      expect(getComputedStyle(historyContainer).opacity).toBe("0");
      expect({ cols: preview.cols, rows: preview.rows }).toEqual({
        cols: 120,
        rows: 36,
      });
    }

    cover.setFitGrid(51, 47);
    await cover.resize(51, 47);
    expect(
      getComputedStyle(parent.querySelector("[data-terminal-replay-preview]")!)
        .visibility,
    ).toBe("visible");
    expect(
      getComputedStyle(parent.querySelector("[data-terminal-replay-preview]")!)
        .visibility,
    ).toBe("visible");
    expect({ cols: preview.cols, rows: preview.rows }).toEqual({
      cols: 51,
      rows: 47,
    });
    cover.dispose();
    expect(historyContainer.style.opacity).toBe("");
    expect(parent.querySelector("[data-terminal-replay-preview]")).toBeNull();
    expect({ cols: history.cols, rows: history.rows }).toEqual({
      cols: 51,
      rows: 47,
    });
    const rendered = Array.from(
      { length: history.buffer.active.length },
      (_, index) => history.buffer.active.getLine(index)?.translateToString(),
    ).join("\n");
    expect(rendered).toContain("oldest historical frame");
    expect(rendered).toContain("middle historical frame");
    expect(rendered).toContain("current frame");

    history.dispose();
    parent.remove();
  });

  it("keeps a phone preview hidden until the PTY grid matches its fit", async () => {
    const context = new Proxy(
      {
        measureText: (text: string) => ({ width: text.length * 8 }),
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        createImageData: () => ({ data: new Uint8ClampedArray(4) }),
      } as Record<string, unknown>,
      {
        get(target, property) {
          const value = target[property as string];
          return value ?? (() => undefined);
        },
        set(target, property, value) {
          target[property as string] = value;
          return true;
        },
      },
    );
    HTMLCanvasElement.prototype.getContext = (() =>
      context) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    const parent = document.createElement("div");
    const historyContainer = document.createElement("div");
    parent.append(historyContainer);
    document.body.append(parent);

    const history = new Terminal({ cols: 135, rows: 56 });
    history.open(historyContainer);
    const preview = new Terminal({ cols: 135, rows: 56 });
    const cover = mountTerminalReplayPreview({
      container: historyContainer,
      initialFitGrid: { cols: 51, rows: 47 },
      canShowMismatchedFallback: () => false,
      terminal: preview,
    });
    const previewElement = parent.querySelector(
      "[data-terminal-replay-preview]",
    )!;
    expect(preview.cols).toBe(135);
    expect(getComputedStyle(previewElement).visibility).toBe("hidden");
    expect(previewElement.getAttribute("data-grid-cols")).toBe("135");

    await cover.resize(51, 47);

    expect(preview.cols).toBe(51);
    expect(preview.rows).toBe(47);
    expect(getComputedStyle(previewElement).visibility).toBe("visible");
    expect(previewElement.getAttribute("data-grid-cols")).toBe("51");

    cover.dispose();
    history.dispose();
    parent.remove();
  });

  it("keeps a focused phone blank until its fitted grid arrives", async () => {
    vi.useFakeTimers();
    const context = new Proxy(
      {
        measureText: (text: string) => ({ width: text.length * 8 }),
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        createImageData: () => ({ data: new Uint8ClampedArray(4) }),
      } as Record<string, unknown>,
      {
        get(target, property) {
          const value = target[property as string];
          return value ?? (() => undefined);
        },
        set(target, property, value) {
          target[property as string] = value;
          return true;
        },
      },
    );
    HTMLCanvasElement.prototype.getContext = (() =>
      context) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    const parent = document.createElement("div");
    const container = document.createElement("div");
    parent.append(container);
    document.body.append(parent);

    const preview = new Terminal({ cols: 135, rows: 56 });
    const cover = mountTerminalReplayPreview({
      container,
      initialFitGrid: { cols: 51, rows: 47 },
      canShowMismatchedFallback: () => false,
      terminal: preview,
    });
    const previewElement = parent.querySelector(
      "[data-terminal-replay-preview]",
    )!;

    vi.advanceTimersByTime(TERMINAL_REPLAY_PREVIEW_FALLBACK_MS);
    expect(getComputedStyle(previewElement).visibility).toBe("hidden");

    const resized = cover.resize(51, 47);
    await vi.advanceTimersByTimeAsync(100);
    await resized;
    expect(getComputedStyle(previewElement).visibility).toBe("visible");
    expect(previewElement.getAttribute("data-grid-cols")).toBe("51");

    cover.dispose();
    parent.remove();
    vi.useRealTimers();
  });

  it("reveals the current replay frame at the PTY grid after fallback for a non-owner", async () => {
    vi.useFakeTimers();
    const context = new Proxy(
      {
        measureText: (text: string) => ({ width: text.length * 8 }),
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        createImageData: () => ({ data: new Uint8ClampedArray(4) }),
      } as Record<string, unknown>,
      {
        get(target, property) {
          const value = target[property as string];
          return value ?? (() => undefined);
        },
        set(target, property, value) {
          target[property as string] = value;
          return true;
        },
      },
    );
    HTMLCanvasElement.prototype.getContext = (() =>
      context) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    const parent = document.createElement("div");
    const container = document.createElement("div");
    parent.append(container);
    document.body.append(parent);

    const preview = new Terminal({ cols: 135, rows: 56 });
    let nonOwner = true;
    const cover = mountTerminalReplayPreview({
      container,
      initialFitGrid: { cols: 51, rows: 47 },
      canShowMismatchedFallback: () => nonOwner,
      terminal: preview,
    });
    const previewElement = parent.querySelector(
      "[data-terminal-replay-preview]",
    )!;
    expect(getComputedStyle(previewElement).visibility).toBe("hidden");
    const parsed = new Promise<void>((resolve) =>
      cover.push(
        Buffer.from(
          `${createTerminalGridMarker({ cols: 135, rows: 56 })}current frame\r\n`,
        ),
        resolve,
      ),
    );
    await vi.advanceTimersByTimeAsync(100);
    await parsed;

    await vi.advanceTimersByTimeAsync(TERMINAL_REPLAY_PREVIEW_FALLBACK_MS);
    await vi.advanceTimersByTimeAsync(100);
    expect(getComputedStyle(previewElement).visibility).toBe("visible");
    expect(previewElement.getAttribute("data-grid-cols")).toBe("135");
    expect(previewElement.getAttribute("data-grid-rows")).toBe("56");
    expect({ cols: preview.cols, rows: preview.rows }).toEqual({
      cols: 135,
      rows: 56,
    });
    expect(preview.element?.style.transform).toBe("scale(0.37777777777777777)");
    expect(
      Array.from({ length: preview.buffer.active.length }, (_, index) =>
        preview.buffer.active.getLine(index)?.translateToString(),
      ).join("\n"),
    ).toContain("current frame");

    nonOwner = false;
    document.dispatchEvent(new Event("focusin"));
    expect(getComputedStyle(previewElement).visibility).toBe("hidden");

    cover.dispose();
    parent.remove();
    vi.useRealTimers();
  });
});
