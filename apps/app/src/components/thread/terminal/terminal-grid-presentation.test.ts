// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTerminalSurfaceScale,
  attachTerminalScalePointerCoordinates,
  canRevealTerminalSurface,
  terminalSurfaceScale,
} from "./terminal-grid-presentation";

describe("terminal grid presentation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the local-fit grid hidden when it differs from the PTY grid after fallback", () => {
    expect(
      canRevealTerminalSurface({
        fallbackElapsed: true,
        fitGrid: { cols: 51, rows: 47 },
        isOwner: false,
        ptyGrid: { cols: 135, rows: 56 },
        rendererGrid: { cols: 51, rows: 47 },
      }),
    ).toBe(false);
  });

  it("reveals only the PTY grid after a non-owner fallback", () => {
    expect(
      canRevealTerminalSurface({
        fallbackElapsed: true,
        fitGrid: { cols: 51, rows: 47 },
        isOwner: false,
        ptyGrid: { cols: 135, rows: 56 },
        rendererGrid: { cols: 135, rows: 56 },
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
    expect(surface.style.transform).toBe(`scale(${scale})`);
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
