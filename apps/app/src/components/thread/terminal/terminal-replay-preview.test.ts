// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalGridMarker } from "@bb/domain";
import { createTerminalOutputPipeline } from "./terminal-output-pipeline";
import { mountTerminalReplayPreview } from "./terminal-replay-preview";

const originalGetContext = HTMLCanvasElement.prototype.getContext;

afterEach(() => {
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
      sourceTerminal: history,
      terminal: preview,
    });
    await vi.waitFor(() =>
      expect(
        getComputedStyle(
          parent.querySelector("[data-terminal-replay-preview]")!,
        ).visibility,
      ).toBe("visible"),
    );
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
    history.resize(51, 47);
    cover.resize(51, 47);
    await vi.waitFor(() =>
      expect(
        getComputedStyle(
          parent.querySelector("[data-terminal-replay-preview]")!,
        ).visibility,
      ).toBe("visible"),
    );
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
    await new Promise<void>((resolve) =>
      history.write(
        `${"\r\n".repeat(55)}phone frame at its fitted grid`,
        resolve,
      ),
    );
    const preview = new Terminal({ cols: 135, rows: 56 });
    const cover = mountTerminalReplayPreview({
      container: historyContainer,
      initialFitGrid: { cols: 51, rows: 47 },
      sourceTerminal: history,
      terminal: preview,
    });
    const previewElement = parent.querySelector<HTMLDivElement>(
      "[data-terminal-replay-preview]",
    )!;

    expect(preview.cols).toBe(135);
    expect(getComputedStyle(previewElement).visibility).toBe("hidden");
    expect(previewElement.getAttribute("data-grid-cols")).toBe("135");

    history.resize(51, 47);
    cover.resize(51, 47);
    await vi.waitFor(() =>
      expect(getComputedStyle(previewElement).visibility).toBe("visible"),
    );

    expect(preview.cols).toBe(51);
    expect(preview.rows).toBe(47);
    expect(cover.matchesFitGrid()).toBe(true);
    expect(getComputedStyle(previewElement).visibility).toBe("visible");
    expect(previewElement.getAttribute("data-grid-cols")).toBe("51");
    expect(previewElement.getAttribute("data-fit-cols")).toBe("51");
    const previewText = Array.from(
      { length: preview.rows },
      (_, index) =>
        preview.buffer.active
          .getLine(preview.buffer.active.viewportY + index)
          ?.translateToString(true) ?? "",
    ).join("\n");
    expect(previewText).toContain("phone frame at its fitted grid");

    cover.dispose();
    history.dispose();
    parent.remove();
  });

  it("shows a blank attached-grid frame while replay catches up", async () => {
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
    const preview = new Terminal({ cols: 135, rows: 56 });
    const cover = mountTerminalReplayPreview({
      container: historyContainer,
      initialFitGrid: { cols: 135, rows: 56 },
      sourceTerminal: history,
      terminal: preview,
    });
    const previewElement = parent.querySelector(
      "[data-terminal-replay-preview]",
    )!;

    expect(getComputedStyle(previewElement).visibility).toBe("visible");
    expect({ cols: preview.cols, rows: preview.rows }).toEqual({
      cols: 135,
      rows: 56,
    });
    expect(preview.buffer.active.getLine(0)?.translateToString(true)).toBe("");

    history.resize(135, 56);
    cover.resize(135, 56);
    await new Promise<void>((resolve) =>
      history.write("replay reached the attached grid", resolve),
    );
    cover.refresh();
    await vi.waitFor(() =>
      expect(
        preview.buffer.active.getLine(0)?.translateToString(true),
      ).toContain("replay reached the attached grid"),
    );

    cover.dispose();
    history.dispose();
    parent.remove();
  });

  it("shows a fitted-size snapshot after a non-owner fallback", async () => {
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
    await new Promise<void>((resolve) =>
      history.write(
        `${"\r\n".repeat(55)}snapshot content from the current frame`,
        resolve,
      ),
    );
    const sourceText = Array.from(
      { length: history.rows },
      (_, index) =>
        history.buffer.active
          .getLine(history.buffer.active.viewportY + index)
          ?.translateToString(true) ?? "",
    ).join("\n");
    expect(sourceText).toContain("snapshot content from the current frame");
    const preview = new Terminal({ cols: 135, rows: 56 });
    const cover = mountTerminalReplayPreview({
      container: historyContainer,
      initialFitGrid: { cols: 51, rows: 47 },
      sourceTerminal: history,
      terminal: preview,
    });
    const previewElement = parent.querySelector<HTMLDivElement>(
      "[data-terminal-replay-preview]",
    )!;

    expect(getComputedStyle(previewElement).visibility).toBe("hidden");
    cover.resize(135, 56);
    await new Promise((resolve) => setTimeout(resolve, 1550));
    await vi.waitFor(() =>
      expect(getComputedStyle(previewElement).visibility).toBe("visible"),
    );

    expect(getComputedStyle(previewElement).visibility).toBe("visible");
    expect(previewElement.getAttribute("data-preview-mode")).toBe("snapshot");
    expect(previewElement.getAttribute("data-grid-cols")).toBe("51");
    expect({ cols: preview.cols, rows: preview.rows }).toEqual({
      cols: 51,
      rows: 47,
    });
    expect(cover.matchesFitGrid()).toBe(false);
    const previewText = Array.from(
      { length: preview.rows },
      (_, index) =>
        preview.buffer.active
          .getLine(preview.buffer.active.viewportY + index)
          ?.translateToString(true) ?? "",
    ).join("\n");
    expect(previewText).toContain("snapshot content from the current frame");

    cover.dispose();
    history.dispose();
    parent.remove();
  });

  it("hides the previous snapshot until a changed fit grid is rendered", async () => {
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

    const history = new Terminal({ cols: 51, rows: 47 });
    history.open(historyContainer);
    await new Promise<void>((resolve) =>
      history.write("current snapshot", resolve),
    );
    const preview = new Terminal({ cols: 51, rows: 47 });
    const cover = mountTerminalReplayPreview({
      container: historyContainer,
      initialFitGrid: { cols: 51, rows: 47 },
      sourceTerminal: history,
      terminal: preview,
    });
    const previewElement = parent.querySelector<HTMLDivElement>(
      "[data-terminal-replay-preview]",
    )!;
    await vi.waitFor(() =>
      expect(getComputedStyle(previewElement).visibility).toBe("visible"),
    );

    cover.setFitGrid(218, 66);

    expect(getComputedStyle(previewElement).visibility).toBe("hidden");
    await vi.waitFor(() =>
      expect(getComputedStyle(previewElement).visibility).toBe("visible"),
    );
    expect(previewElement.dataset.gridCols).toBe("218");
    expect(previewElement.dataset.fitCols).toBe("218");

    cover.dispose();
    history.dispose();
    parent.remove();
  });
});
