// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalGridMarker } from "@bb/domain";
import { createTerminalOutputPipeline } from "./terminal-output-pipeline";
import {
  mountTerminalReplayPreview,
  updateTerminalReplayPreviewPtyGrid,
} from "./terminal-replay-preview";
import { writeTerminalOutput } from "./ThreadTerminalView";

const originalGetContext = HTMLCanvasElement.prototype.getContext;

afterEach(() => {
  vi.useRealTimers();
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

function installPreviewCanvasContext() {
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
}

async function createPreviewHarness({
  cols,
  rows,
  fitCols,
  fitRows,
}: {
  cols: number;
  rows: number;
  fitCols: number;
  fitRows: number;
}) {
  installPreviewCanvasContext();
  const parent = document.createElement("div");
  const container = document.createElement("div");
  parent.append(container);
  document.body.append(parent);
  Object.defineProperty(container, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(0, 0, 960, 940),
  });
  Object.defineProperty(container, "clientWidth", {
    configurable: true,
    value: 960,
  });
  const terminal = new Terminal({ cols, rows });
  const cover = mountTerminalReplayPreview({
    container,
    initialFitGrid: { cols: fitCols, rows: fitRows },
    isOwner: () => false,
    terminal,
  });
  await new Promise<void>((resolve) =>
    cover.push(Buffer.from("\u001b[12;9Hscreenshot snapshot"), resolve),
  );
  const expectedCursor = {
    x: terminal.buffer.active.cursorX,
    y: terminal.buffer.active.cursorY,
  };
  return {
    container,
    cover,
    expectedCursor,
    parent,
    previewElement: parent.querySelector<HTMLElement>(
      "[data-terminal-replay-preview]",
    )!,
    terminal,
  };
}

describe("terminal replay preview", () => {
  it("preserves xterm focus when mounting the snapshot preview surface", () => {
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

    const history = new Terminal({ cols: 80, rows: 24 });
    history.open(historyContainer);
    history.textarea?.focus();
    const focusedElement = history.textarea;
    if (
      focusedElement === undefined ||
      document.activeElement !== focusedElement
    ) {
      throw new Error("Expected the active terminal to own focus");
    }

    const preview = new Terminal({ cols: 80, rows: 24 });
    const openPreview = preview.open;
    vi.spyOn(preview, "open").mockImplementation((element) => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      openPreview.call(preview, element);
    });
    const cover = mountTerminalReplayPreview({
      container: historyContainer,
      initialFitGrid: { cols: 80, rows: 24 },
      isOwner: () => false,
      terminal: preview,
    });

    expect(document.activeElement).toBe(focusedElement);

    cover.dispose();
    history.dispose();
    parent.remove();
  });

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
      isOwner: () => true,
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

  it("keeps snapshot columns until the authoritative PTY grid matches the phone fit", async () => {
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
      isOwner: () => true,
      terminal: preview,
    });
    const previewElement = parent.querySelector(
      "[data-terminal-replay-preview]",
    )!;
    expect(preview.cols).toBe(135);
    expect(getComputedStyle(previewElement).visibility).toBe("visible");
    expect({ cols: preview.cols, rows: preview.rows }).toEqual({
      cols: 135,
      rows: 56,
    });
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

  it("waits for the phone fit before revealing and scaling an attached-grid preview", () => {
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
      initialFitGrid: null,
      isOwner: () => false,
      terminal: preview,
    });
    const previewElement = parent.querySelector(
      "[data-terminal-replay-preview]",
    )!;

    expect(getComputedStyle(previewElement).visibility).toBe("hidden");

    cover.setFitGrid(51, 47);

    const scale = 51 / 135;
    expect({ cols: preview.cols, rows: preview.rows }).toEqual({
      cols: 135,
      rows: 56,
    });
    expect(getComputedStyle(previewElement).visibility).toBe("visible");
    expect(preview.element?.style.transform).toBe(
      "scale(min(var(--terminal-grid-scale, 1), calc(100cqw / var(--terminal-natural-width, 1px))))",
    );
    expect(135 * scale).toBe(51);

    cover.dispose();
    parent.remove();
  });

  it("keeps a visible 135-column preview inside the renderer across a desktop-to-phone resize", () => {
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
    let availableWidth = 964;
    const preview = new Terminal({ cols: 135, rows: 56 });
    const cover = mountTerminalReplayPreview({
      container,
      initialFitGrid: { cols: 135, rows: 56 },
      isOwner: () => false,
      terminal: preview,
    });
    const previewElement = parent.querySelector<HTMLElement>(
      "[data-terminal-replay-preview]",
    )!;
    Object.defineProperty(container, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(0, 0, availableWidth, 800),
    });
    const screen = preview.element?.querySelector<HTMLElement>(".xterm-screen");
    expect(screen).not.toBeNull();
    Object.defineProperty(screen!, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        const scale = Number(preview.element?.dataset.surfaceScale ?? "1");
        const widthScale = Math.min(1, availableWidth / 975);
        return new DOMRect(
          0,
          0,
          975 * Math.min(scale, widthScale),
          784 * Math.min(scale, widthScale),
        );
      },
    });
    const paintedWidth = () => screen!.getBoundingClientRect().width;

    window.dispatchEvent(new Event("resize"));
    expect(previewElement.style.visibility).toBe("visible");
    expect(paintedWidth()).toBeLessThanOrEqual(availableWidth + 1);

    availableWidth = 357;
    window.dispatchEvent(new Event("resize"));

    expect(previewElement.style.visibility).toBe("visible");
    expect(paintedWidth()).toBeLessThanOrEqual(availableWidth + 1);
    expect(container.style.containerType).toBe("inline-size");
    expect(preview.element?.style.transform).toBe(
      "scale(min(var(--terminal-grid-scale, 1), calc(100cqw / var(--terminal-natural-width, 1px))))",
    );
    expect(
      preview.element?.style.getPropertyValue("--terminal-grid-scale"),
    ).toBe("1");

    cover.dispose();
    parent.remove();
  });

  it("keeps the preview painted while the authoritative PTY grid is applied", async () => {
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
      isOwner: () => false,
      terminal: preview,
    });
    const previewElement = parent.querySelector(
      "[data-terminal-replay-preview]",
    )!;
    expect(getComputedStyle(previewElement).visibility).toBe("visible");

    const markerPipeline = createTerminalOutputPipeline(
      {
        resize: () => undefined,
        write: (_bytes, callback) => callback(),
      },
      (grid, apply) => updateTerminalReplayPreviewPtyGrid(cover, grid, apply),
    );
    const newGrid = { cols: 51, rows: 47 };
    markerPipeline.push(
      Buffer.from(createTerminalGridMarker(newGrid)),
      () => undefined,
    );

    expect(getComputedStyle(previewElement).visibility).toBe("visible");
    expect(previewElement.getAttribute("data-grid-cols")).toBe("135");

    await cover.resize(newGrid.cols, newGrid.rows);

    expect(preview.cols).toBe(51);
    expect(preview.rows).toBe(47);
    expect(getComputedStyle(previewElement).visibility).toBe("visible");

    cover.dispose();
    parent.remove();
  });

  it("shows an owner the snapshot grid until the authoritative fitted grid arrives", async () => {
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
      isOwner: () => true,
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

    const resized = cover.resize(51, 47);
    await resized;
    expect(getComputedStyle(previewElement).visibility).toBe("visible");
    expect(previewElement.getAttribute("data-grid-cols")).toBe("51");

    cover.dispose();
    parent.remove();
  });

  it("keeps the fitted snapshot visible when its viewer becomes the owner", async () => {
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
      isOwner: () => !nonOwner,
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
    const parsed = new Promise<void>((resolve) =>
      cover.push(
        Buffer.from(
          `${createTerminalGridMarker({ cols: 135, rows: 56 })}current frame\r\n`,
        ),
        resolve,
      ),
    );
    await parsed;

    expect(getComputedStyle(previewElement).visibility).toBe("visible");
    expect(previewElement.getAttribute("data-grid-cols")).toBe("135");
    expect(previewElement.getAttribute("data-grid-rows")).toBe("56");
    expect({ cols: preview.cols, rows: preview.rows }).toEqual({
      cols: 135,
      rows: 56,
    });
    expect(preview.element?.style.transform).toBe(
      "scale(min(var(--terminal-grid-scale, 1), calc(100cqw / var(--terminal-natural-width, 1px))))",
    );
    expect(
      Array.from({ length: preview.buffer.active.length }, (_, index) =>
        preview.buffer.active.getLine(index)?.translateToString(),
      ).join("\n"),
    ).toContain("current frame");

    nonOwner = false;
    document.dispatchEvent(new Event("focusin"));
    expect(getComputedStyle(previewElement).visibility).toBe("visible");

    cover.dispose();
    parent.remove();
  });

  it("does not show a short first frame while the pane waits for the PTY resize", async () => {
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
    Object.defineProperty(container, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(0, 0, 960, 940),
    });

    const preview = new Terminal({ cols: 120, rows: 36 });
    await new Promise<void>((resolve) =>
      preview.write("\u001b[12;9Hcurrent screen", resolve),
    );
    const expectedCursor = {
      x: preview.buffer.active.cursorX,
      y: preview.buffer.active.cursorY,
    };
    const cover = mountTerminalReplayPreview({
      container,
      initialFitGrid: { cols: 120, rows: 47 },
      isOwner: () => false,
      terminal: preview,
    });
    const previewElement = parent.querySelector<HTMLElement>(
      "[data-terminal-replay-preview]",
    )!;
    const screen = preview.element?.querySelector<HTMLElement>(".xterm-screen");
    expect(screen).not.toBeNull();
    Object.defineProperty(screen!, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(0, 0, 960, preview.rows * 20),
    });
    const firstFrame = {
      paneHeight: container.getBoundingClientRect().height,
      screenHeight: screen!.getBoundingClientRect().height,
      visibility: getComputedStyle(previewElement).visibility,
      rows: preview.rows,
      snapshotText: Array.from(
        { length: preview.buffer.active.length },
        (_, index) =>
          preview.buffer.active.getLine(index)?.translateToString(true),
      ).join("\n"),
      cursorX: preview.buffer.active.cursorX,
      cursorY: preview.buffer.active.cursorY,
    };

    cover.setPtyGrid(120, 47);
    await cover.resize(120, 47);
    const finalFrame = {
      visibility: getComputedStyle(previewElement).visibility,
      cols: preview.cols,
      rows: preview.rows,
      cursorX: preview.buffer.active.cursorX,
      cursorY: preview.buffer.active.cursorY,
    };

    cover.dispose();
    parent.remove();

    expect(firstFrame.visibility).toBe("visible");
    expect(firstFrame.rows).toBe(47);
    expect(firstFrame.screenHeight).toBeGreaterThanOrEqual(
      firstFrame.paneHeight,
    );
    expect(firstFrame.snapshotText).toContain("current screen");
    expect({ x: firstFrame.cursorX, y: firstFrame.cursorY }).toEqual(
      expectedCursor,
    );
    expect(finalFrame.visibility).toBe("visible");
    expect({ cols: finalFrame.cols, rows: finalFrame.rows }).toEqual({
      cols: 120,
      rows: 47,
    });
    expect({ x: finalFrame.cursorX, y: finalFrame.cursorY }).toEqual(
      expectedCursor,
    );
  });

  it("keeps snapshot columns and content while fitting a wider pane", async () => {
    const harness = await createPreviewHarness({
      cols: 100,
      rows: 36,
      fitCols: 120,
      fitRows: 47,
    });
    harness.cover.setFitGrid(120, 47);

    expect(getComputedStyle(harness.previewElement).visibility).toBe("visible");
    expect({ cols: harness.terminal.cols, rows: harness.terminal.rows }).toEqual({
      cols: 100,
      rows: 47,
    });
    expect(
      Array.from({ length: harness.terminal.buffer.active.length }, (_, index) =>
        harness.terminal.buffer.active.getLine(index)?.translateToString(true),
      ).join("\n"),
    ).toContain("screenshot snapshot");
    expect({
      x: harness.terminal.buffer.active.cursorX,
      y: harness.terminal.buffer.active.cursorY,
    }).toEqual(harness.expectedCursor);
    expect(harness.previewElement.style.overflow).toBe("hidden");
    expect(harness.previewElement.style.overflowX).toBe("hidden");

    harness.cover.dispose();
    harness.parent.remove();
  });

  it("keeps the local frame painted until the authoritative smaller grid is applied", async () => {
    const harness = await createPreviewHarness({
      cols: 120,
      rows: 36,
      fitCols: 120,
      fitRows: 47,
    });

    expect(harness.terminal.rows).toBe(47);
    expect(getComputedStyle(harness.previewElement).visibility).toBe("visible");
    harness.cover.setPtyGrid(120, 40);
    expect(getComputedStyle(harness.previewElement).visibility).toBe("visible");
    expect(harness.terminal.rows).toBe(47);
    await harness.cover.resize(120, 40);
    expect(getComputedStyle(harness.previewElement).visibility).toBe("visible");
    expect({
      cols: harness.terminal.cols,
      rows: harness.terminal.rows,
    }).toEqual({ cols: 120, rows: 40 });

    harness.cover.dispose();
    harness.parent.remove();
  });

  it("keeps an expanded snapshot visible when no authoritative grid arrives", async () => {
    const harness = await createPreviewHarness({
      cols: 120,
      rows: 36,
      fitCols: 120,
      fitRows: 47,
    });
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(harness.terminal.rows).toBe(47);
    expect(getComputedStyle(harness.previewElement).visibility).toBe("visible");
    expect(
      Array.from({ length: harness.terminal.buffer.active.length }, (_, index) =>
        harness.terminal.buffer.active.getLine(index)?.translateToString(true),
      ).join("\n"),
    ).toContain("screenshot snapshot");
    expect({
      x: harness.terminal.buffer.active.cursorX,
      y: harness.terminal.buffer.active.cursorY,
    }).toEqual(harness.expectedCursor);

    harness.cover.dispose();
    harness.parent.remove();
  });

  it("keeps snapshot rows visible when the pane fit is smaller and no grid arrives", async () => {
    const harness = await createPreviewHarness({
      cols: 120,
      rows: 47,
      fitCols: 120,
      fitRows: 36,
    });
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(harness.terminal.rows).toBe(47);
    expect(getComputedStyle(harness.previewElement).visibility).toBe("visible");

    harness.cover.dispose();
    harness.parent.remove();
  });

  it("holds post-snapshot output until the authoritative grid arrives", async () => {
    const harness = await createPreviewHarness({
      cols: 120,
      rows: 36,
      fitCols: 120,
      fitRows: 47,
    });
    const terminalWrite = vi.spyOn(harness.terminal, "write");
    let liveWriteCompleted = false;
    harness.cover.push(Buffer.from("\r\nlive after marker"), () => {
      liveWriteCompleted = true;
    });

    expect(liveWriteCompleted).toBe(false);
    expect(terminalWrite).not.toHaveBeenCalled();
    expect(
      Array.from({ length: harness.terminal.buffer.active.length }, (_, index) =>
        harness.terminal.buffer.active.getLine(index)?.translateToString(true),
      ).join("\n"),
    ).not.toContain("live after marker");

    harness.cover.setPtyGrid(120, 40);
    await vi.waitFor(() => expect(liveWriteCompleted).toBe(true));
    expect(terminalWrite).toHaveBeenCalledOnce();
    expect(
      Array.from({ length: harness.terminal.buffer.active.length }, (_, index) =>
        harness.terminal.buffer.active.getLine(index)?.translateToString(true),
      ).join("\n"),
    ).toContain("live after marker");

    harness.cover.dispose();
    harness.parent.remove();
  });

  it("hands held output off at the last-known grid after the deadline", async () => {
    const harness = await createPreviewHarness({
      cols: 120,
      rows: 36,
      fitCols: 120,
      fitRows: 47,
    });
    const terminalWrite = vi.spyOn(harness.terminal, "write");
    let firstCompleted = false;
    let secondCompleted = false;
    harness.cover.push(Buffer.from("\r\nfirst queued chunk"), () => {
      firstCompleted = true;
    });
    updateTerminalReplayPreviewPtyGrid(
      harness.cover,
      { cols: 120, rows: 40 },
      false,
    );
    harness.cover.push(Buffer.from("\r\nsecond queued chunk"), () => {
      secondCompleted = true;
    });

    expect(firstCompleted).toBe(false);
    expect(secondCompleted).toBe(false);
    expect(terminalWrite).not.toHaveBeenCalled();
    expect(getComputedStyle(harness.previewElement).visibility).toBe("visible");

    await vi.waitFor(() => {
      expect(firstCompleted).toBe(true);
      expect(secondCompleted).toBe(true);
    }, { timeout: 1500 });

    const rendered = Array.from(
      { length: harness.terminal.buffer.active.length },
      (_, index) =>
        harness.terminal.buffer.active.getLine(index)?.translateToString(true),
    ).join("\n");
    expect(rendered.indexOf("first queued chunk")).toBeGreaterThanOrEqual(0);
    expect(rendered.indexOf("second queued chunk")).toBeGreaterThan(
      rendered.indexOf("first queued chunk"),
    );
    expect({ cols: harness.terminal.cols, rows: harness.terminal.rows }).toEqual({
      cols: 120,
      rows: 47,
    });
    expect(getComputedStyle(harness.previewElement).visibility).toBe("visible");

    harness.cover.dispose();
    harness.parent.remove();
  });

  it("keeps chunks in order while the deadline handoff is pending", async () => {
    const captured: { frame: FrameRequestCallback | null } = { frame: null };
    const frameRequest = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        captured.frame = callback;
        return 1;
      });
    const harness = await createPreviewHarness({
      cols: 120,
      rows: 36,
      fitCols: 120,
      fitRows: 47,
    });
    frameRequest.mockRestore();
    if (captured.frame === null) throw new Error("Expected preview frame");
    vi.useFakeTimers();
    let firstCallbackCount = 0;
    let secondCallbackCount = 0;
    harness.cover.push(Buffer.from("\r\nchunk A"), () => {
      firstCallbackCount += 1;
    });
    captured.frame(0);
    const terminalResize = harness.terminal.resize.bind(harness.terminal);
    vi.spyOn(harness.terminal, "resize").mockImplementation((cols, rows) => {
      terminalResize(cols, rows);
      harness.cover.push(Buffer.from("\r\nchunk B"), () => {
        secondCallbackCount += 1;
      });
    });
    vi.advanceTimersByTime(500);
    await vi.advanceTimersByTimeAsync(0);
    expect(firstCallbackCount).toBe(1);
    expect(secondCallbackCount).toBe(1);
    const rendered = Array.from(
      { length: harness.terminal.buffer.active.length },
      (_, index) =>
        harness.terminal.buffer.active.getLine(index)?.translateToString(true),
    ).join("\n");
    expect(rendered.indexOf("chunk A")).toBeGreaterThanOrEqual(0);
    expect(rendered.indexOf("chunk B")).toBeGreaterThan(
      rendered.indexOf("chunk A"),
    );

    harness.cover.dispose();
    harness.parent.remove();
  });

  it("hands held output off when an equal-grid attach arrives", async () => {
    const harness = await createPreviewHarness({
      cols: 120,
      rows: 36,
      fitCols: 120,
      fitRows: 47,
    });
    const terminalWrite = vi.spyOn(harness.terminal, "write");
    let completed = false;
    harness.cover.push(Buffer.from("\r\nequal-grid attach output"), () => {
      completed = true;
    });
    updateTerminalReplayPreviewPtyGrid(
      harness.cover,
      { cols: 120, rows: 36 },
      false,
    );

    expect(completed).toBe(false);
    expect(terminalWrite).not.toHaveBeenCalled();

    await harness.cover.resize(120, 36);
    await vi.waitFor(() => expect(completed).toBe(true));
    expect(terminalWrite).toHaveBeenCalledOnce();
    expect(
      Array.from({ length: harness.terminal.buffer.active.length }, (_, index) =>
        harness.terminal.buffer.active.getLine(index)?.translateToString(true),
      ).join("\n"),
    ).toContain("equal-grid attach output");

    harness.cover.dispose();
    harness.parent.remove();
  });

  it("hands held output off when the process exits", async () => {
    const harness = await createPreviewHarness({
      cols: 120,
      rows: 36,
      fitCols: 120,
      fitRows: 47,
    });
    let completed = false;
    harness.cover.push(Buffer.from("\r\nfinal process output"), () => {
      completed = true;
    });
    const terminalWrite = vi.spyOn(harness.terminal, "write");
    terminalWrite.mockClear();

    harness.cover.processExited();

    await vi.waitFor(() => expect(completed).toBe(true));
    expect(terminalWrite).toHaveBeenCalled();
    expect(
      Array.from({ length: harness.terminal.buffer.active.length }, (_, index) =>
        harness.terminal.buffer.active.getLine(index)?.translateToString(true),
      ).join("\n"),
    ).toContain("final process output");

    harness.cover.dispose();
    harness.parent.remove();
  });

  it("completes held callbacks without writing when disposed", async () => {
    const harness = await createPreviewHarness({
      cols: 120,
      rows: 36,
      fitCols: 120,
      fitRows: 47,
    });
    const terminalWrite = vi.spyOn(harness.terminal, "write");
    terminalWrite.mockClear();
    let completed = false;
    harness.cover.push(Buffer.from("\r\nheld then disposed"), () => {
      completed = true;
    });

    harness.cover.dispose();

    expect(completed).toBe(true);
    expect(terminalWrite).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(terminalWrite).not.toHaveBeenCalled();
    harness.parent.remove();
  });

  it("hands off without dropping output when the pending byte bound is exceeded", async () => {
    const harness = await createPreviewHarness({
      cols: 120,
      rows: 36,
      fitCols: 120,
      fitRows: 47,
    });
    const queuedOutput = `${"x".repeat(256 * 1024)} overflow tail`;
    let completed = false;
    harness.cover.push(Buffer.from(`\r\n${queuedOutput}`), () => {
      completed = true;
    });

    await vi.waitFor(() => expect(completed).toBe(true), { timeout: 5000 });
    const rendered = Array.from(
      { length: harness.terminal.buffer.active.length },
      (_, index) =>
        harness.terminal.buffer.active.getLine(index)?.translateToString(true),
    ).join("\n");
    expect(rendered).toContain("overflow tail");
    expect(getComputedStyle(harness.previewElement).visibility).toBe("visible");

    harness.cover.dispose();
    harness.parent.remove();
  });

  it("allows a frame to paint during a 61,929-byte 1,019-chunk replay", async () => {
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

    const terminal = new Terminal({ cols: 120, rows: 36, scrollback: 10_000 });
    terminal.open(container);
    const preview = new Terminal({ cols: 120, rows: 36, scrollback: 10_000 });
    const cover = mountTerminalReplayPreview({
      container,
      initialFitGrid: { cols: 120, rows: 36 },
      isOwner: () => false,
      terminal: preview,
    });
    await new Promise<void>((resolve) =>
      cover.push(Buffer.from("snapshot\r\n"), resolve),
    );
    let parsedChunks = 0;
    const previewElement = parent.querySelector<HTMLElement>(
      "[data-terminal-replay-preview]",
    )!;
    const previewPaint = new Promise<{
      parsedChunks: number;
      screenPresent: boolean;
      visible: boolean;
    }>((resolve) =>
      window.requestAnimationFrame(() =>
        resolve({
          parsedChunks,
          screenPresent: Boolean(
            preview.element?.querySelector(".xterm-screen"),
          ),
          visible: getComputedStyle(previewElement).visibility === "visible",
        }),
      ),
    );
    const replayWriteState = { suppressedWriteCount: 0 };
    const pipeline = createTerminalOutputPipeline(terminal);
    const chunkSizes = Array.from({ length: 1_019 }, (_, index) =>
      index < 789 ? 61 : 60,
    );
    let finishReplay!: () => void;
    const replayDone = new Promise<void>((resolve) => {
      finishReplay = resolve;
    });
    for (const [sequence, size] of chunkSizes.entries()) {
      writeTerminalOutput({
        data: new Uint8Array(size).fill(65),
        isReplay: true,
        onParsed: () => {
          parsedChunks += 1;
          if (parsedChunks === chunkSizes.length) finishReplay();
        },
        outputSequence: sequence,
        replayCheckpointSequence: 0,
        replayWriteState,
        terminal,
        pipeline,
        replayPipeline: cover,
      });
    }

    const frameAtFirstPaint = await previewPaint;
    await replayDone;
    const parsedCount = parsedChunks;
    const suppressedWriteCount = replayWriteState.suppressedWriteCount;
    const previewBuffer = Array.from(
      { length: preview.buffer.active.length },
      (_, index) => preview.buffer.active.getLine(index)?.translateToString(true),
    ).join("\n");

    cover.dispose();
    terminal.dispose();
    parent.remove();

    expect(chunkSizes.reduce((total, size) => total + size, 0)).toBe(61_929);
    expect(frameAtFirstPaint.visible).toBe(true);
    expect(frameAtFirstPaint.screenPresent).toBe(true);
    expect(frameAtFirstPaint.parsedChunks).toBeLessThan(chunkSizes.length);
    expect(parsedCount).toBe(chunkSizes.length);
    expect(suppressedWriteCount).toBe(0);
    expect(previewBuffer).toContain("snapshot");
  });
});
