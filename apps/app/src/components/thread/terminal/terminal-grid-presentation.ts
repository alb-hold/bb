import type { TerminalGrid } from "@bb/domain";

export function terminalSurfaceScale(
  grid: TerminalGrid,
  fitGrid: TerminalGrid,
): number {
  if (grid.cols <= fitGrid.cols || grid.cols <= 0 || fitGrid.cols <= 0) {
    return 1;
  }
  return fitGrid.cols / grid.cols;
}

export function canRevealTerminalSurface({
  fitGrid,
  isOwner,
  ptyGrid,
  rendererGrid,
}: {
  fitGrid: TerminalGrid;
  isOwner: boolean;
  ptyGrid: TerminalGrid;
  rendererGrid: TerminalGrid;
}): boolean {
  const matchesPty =
    rendererGrid.cols === ptyGrid.cols && rendererGrid.rows === ptyGrid.rows;
  const matchesFit =
    rendererGrid.cols === fitGrid.cols && rendererGrid.rows === fitGrid.rows;
  return matchesPty && (matchesFit || !isOwner);
}

export function applyTerminalSurfaceScale(
  surface: HTMLElement,
  scale: number,
): void {
  surface.style.transform = scale < 1 ? `scale(${scale})` : "";
  surface.style.transformOrigin = "top left";
  surface.dataset.surfaceScale = String(scale);
}

export function attachTerminalScalePointerCoordinates(
  surface: HTMLElement,
  getScale: () => number,
): () => void {
  let dragging = false;
  const adjustedEvents = new WeakSet<Event>();
  const originals = new WeakMap<Event, { clientX: number; clientY: number }>();
  const eventTypes = [
    "mousedown",
    "mousemove",
    "mouseup",
    "click",
    "dblclick",
  ] as const;
  const restore = (event: Event) => {
    const original = originals.get(event);
    if (!original) return;
    Object.defineProperties(event, {
      clientX: { configurable: true, value: original.clientX },
      clientY: { configurable: true, value: original.clientY },
    });
    originals.delete(event);
  };
  const handle = (event: Event) => {
    if (adjustedEvents.has(event)) return;
    const pointer = event as MouseEvent;
    const isInside =
      event.target instanceof Node && surface.contains(event.target);
    if (event.type === "mousedown" && isInside) dragging = true;
    const scale = getScale();
    if (scale >= 1 || (!isInside && !dragging)) {
      if (event.type === "mouseup") dragging = false;
      return;
    }
    const rect = surface.getBoundingClientRect();
    const original = { clientX: pointer.clientX, clientY: pointer.clientY };
    const clientX = rect.left + (pointer.clientX - rect.left) / scale;
    const clientY = rect.top + (pointer.clientY - rect.top) / scale;
    if (clientX !== original.clientX || clientY !== original.clientY) {
      originals.set(event, original);
      Object.defineProperties(event, {
        clientX: { configurable: true, value: clientX },
        clientY: { configurable: true, value: clientY },
      });
      adjustedEvents.add(event);
      if (isInside) {
        surface.addEventListener(event.type, () => restore(event), {
          once: true,
        });
      } else {
        queueMicrotask(() => restore(event));
      }
    }
    if (event.type === "mouseup") dragging = false;
  };
  for (const type of eventTypes) {
    document.addEventListener(type, handle, true);
  }
  return () => {
    for (const type of eventTypes) {
      document.removeEventListener(type, handle, true);
    }
    dragging = false;
  };
}
