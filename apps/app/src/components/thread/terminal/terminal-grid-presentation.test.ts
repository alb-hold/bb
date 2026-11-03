// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTerminalSurfaceScale,
  attachTerminalScalePointerCoordinates,
  canRevealTerminalSurface,
  terminalSurfaceScale,
  terminalSurfaceScaleToWidth,
} from "./terminal-grid-presentation";

describe("terminal grid presentation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reveals a non-owner at the authoritative grid when it differs from local fit", () => {
    expect(
      canRevealTerminalSurface({
        fitGrid: { cols: 130, rows: 50 },
        isOwner: false,
        ptyGrid: { cols: 135, rows: 56 },
        rendererGrid: { cols: 135, rows: 56 },
      }),
    ).toBe(true);
  });

  it("keeps an owner hidden until its fitted PTY grid is authoritative", () => {
    expect(
      canRevealTerminalSurface({
        fitGrid: { cols: 51, rows: 47 },
        isOwner: true,
        ptyGrid: { cols: 135, rows: 56 },
        rendererGrid: { cols: 135, rows: 56 },
      }),
    ).toBe(false);
  });

  it("reveals immediately when the attached PTY grid already matches the local fit", () => {
    expect(
      canRevealTerminalSurface({
        fitGrid: { cols: 51, rows: 47 },
        isOwner: true,
        ptyGrid: { cols: 51, rows: 47 },
        rendererGrid: { cols: 51, rows: 47 },
      }),
    ).toBe(true);
  });

  it("scales a narrower non-owner surface to the fitted width", () => {
    const scale = terminalSurfaceScale(
      { cols: 135, rows: 56 },
      { cols: 51, rows: 47 },
    );
    const surface = document.createElement("div");

    applyTerminalSurfaceScale(surface, scale);

    expect(scale).toBeCloseTo(51 / 135);
    expect(surface.style.transform).toBe(
      "scale(min(var(--terminal-grid-scale, 1), calc(100cqw / var(--terminal-natural-width, 1px))))",
    );
    expect(surface.dataset.surfaceScale).toBe(String(scale));
  });

  it("caps the surface to the renderer width after a viewport resize", () => {
    const surface = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    surface.append(screen);
    let availableWidth = 964;
    Object.defineProperty(screen, "getBoundingClientRect", {
      value: () => ({ width: 975 * Number(surface.dataset.surfaceScale ?? "1") }),
    });
    const fitGrid = { cols: 135, rows: 56 };
    let scale = terminalSurfaceScaleToWidth(
      { cols: 135, rows: 56 },
      fitGrid,
      surface,
      availableWidth,
    );
    applyTerminalSurfaceScale(surface, scale);
    expect(surface.style.transform).toBe(
      "scale(min(var(--terminal-grid-scale, 1), calc(100cqw / var(--terminal-natural-width, 1px))))",
    );
    expect(975 * scale).toBeLessThanOrEqual(availableWidth + 1);

    availableWidth = 357;
    scale = terminalSurfaceScaleToWidth(
      { cols: 135, rows: 56 },
      fitGrid,
      surface,
      availableWidth,
    );
    applyTerminalSurfaceScale(surface, scale);
    expect(975 * scale).toBeLessThanOrEqual(availableWidth + 1);
    expect(surface.dataset.surfaceScale).toBe(String(scale));
  });

  it("compensates scaled terminal mouse coordinates and restores them for surrounding UI", () => {
    const surface = document.createElement("div");
    const child = document.createElement("div");
    surface.append(child);
    document.body.append(surface);
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      bottom: 70,
      height: 50,
      left: 10,
      right: 60,
      top: 20,
      width: 50,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    } as DOMRect);
    const readings: Array<{ listener: string; x: number; y: number }> = [];
    const detach = attachTerminalScalePointerCoordinates(surface, () => 0.5);
    child.addEventListener("mousedown", (event) => {
      readings.push({
        listener: "terminal",
        x: event.clientX,
        y: event.clientY,
      });
    });
    surface.parentElement?.addEventListener("mousedown", (event) => {
      readings.push({ listener: "app", x: event.clientX, y: event.clientY });
    });

    child.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        clientX: 30,
        clientY: 40,
      }),
    );

    expect(readings).toEqual([
      { listener: "terminal", x: 50, y: 60 },
      { listener: "app", x: 30, y: 40 },
    ]);
    detach();
    surface.remove();
  });
});
