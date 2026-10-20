export interface TerminalGestureTouch {
  identifier: number;
  x: number;
  y: number;
}

export interface TerminalGestureTimer {
  cancel: () => void;
}

export const TERMINAL_TOUCH_SELECT_DELAY_MS = 500;
export const TERMINAL_TOUCH_GESTURE_MOVEMENT_PX = 10;
export const TERMINAL_TOUCH_FONT_MIN = 8;
export const TERMINAL_TOUCH_FONT_MAX = 28;

export function terminalFontSizeForPinch(
  initialFontSize: number,
  scale: number,
): number {
  return Math.min(
    TERMINAL_TOUCH_FONT_MAX,
    Math.max(TERMINAL_TOUCH_FONT_MIN, Math.round(initialFontSize * scale)),
  );
}

export function terminalZoomLevelForPinch(
  initialZoomLevel: number,
  scale: number,
): number {
  return Math.min(
    TERMINAL_TOUCH_FONT_MAX,
    Math.max(TERMINAL_TOUCH_FONT_MIN, initialZoomLevel * scale),
  );
}

export function terminalPinchDistance(
  touches: readonly TerminalGestureTouch[],
): number | null {
  if (touches.length !== 2) return null;
  return Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y);
}

export function startTerminalLongPress(
  touches: readonly TerminalGestureTouch[],
  lineAtPoint: (point: TerminalGestureTouch) => number,
  onLongPress: (line: number) => void,
  setTimer: (callback: () => void, delay: number) => TerminalGestureTimer,
): {
  cancel: () => void;
  move: (touches: readonly TerminalGestureTouch[]) => void;
} {
  const touch = touches.length === 1 ? touches[0] : undefined;
  if (touch === undefined) return { cancel: () => {}, move: () => {} };
  const line = lineAtPoint(touch);
  let active = true;
  const timer = setTimer(() => {
    if (active) onLongPress(line);
  }, TERMINAL_TOUCH_SELECT_DELAY_MS);
  return {
    cancel() {
      active = false;
      timer.cancel();
    },
    move(currentTouches) {
      const current =
        currentTouches.length === 1 ? currentTouches[0] : undefined;
      if (
        current === undefined ||
        current.identifier !== touch.identifier ||
        Math.hypot(current.x - touch.x, current.y - touch.y) >
          TERMINAL_TOUCH_GESTURE_MOVEMENT_PX
      ) {
        active = false;
        timer.cancel();
      }
    },
  };
}

export function createTerminalPinchGesture({
  getZoomLevel,
  setZoomLevel,
  fitAndResize,
}: {
  getZoomLevel: () => number;
  setZoomLevel: (zoomLevel: number) => void;
  fitAndResize: () => void;
}) {
  let initialDistance: number | null = null;
  let initialZoomLevel = 0;
  let initialFontSize = 0;
  return {
    cancel() {
      this.end();
    },
    end() {
      if (initialDistance === null) return;
      initialDistance = null;
      if (terminalFontSizeForPinch(getZoomLevel(), 1) !== initialFontSize) {
        fitAndResize();
      }
    },
    move(touches: readonly TerminalGestureTouch[]) {
      if (initialDistance === null) return;
      const distance = terminalPinchDistance(touches);
      if (distance === null || initialDistance <= 0) return;
      const nextZoomLevel = terminalZoomLevelForPinch(
        initialZoomLevel,
        distance / initialDistance,
      );
      if (nextZoomLevel !== getZoomLevel()) {
        setZoomLevel(nextZoomLevel);
      }
    },
    start(touches: readonly TerminalGestureTouch[]) {
      const distance = terminalPinchDistance(touches);
      if (distance === null) return;
      initialDistance = distance;
      initialZoomLevel = getZoomLevel();
      initialFontSize = terminalFontSizeForPinch(initialZoomLevel, 1);
    },
  };
}
