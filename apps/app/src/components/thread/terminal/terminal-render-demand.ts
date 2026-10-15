import type { Terminal } from "@xterm/xterm";

interface TerminalRenderService {
  _isPaused: boolean;
  _needsFullRefresh: boolean;
}

interface TerminalRenderDemandState {
  setVisible: (visible: boolean) => boolean;
}

interface TerminalCore {
  _renderService?: TerminalRenderService;
}

interface TerminalWithRenderService extends Terminal {
  _core?: TerminalCore;
}

const demandStateByService = new WeakMap<
  TerminalRenderService,
  TerminalRenderDemandState
>();

function demandStateFor(
  renderService: TerminalRenderService,
  requestFullRefresh: () => void,
): TerminalRenderDemandState {
  const existing = demandStateByService.get(renderService);
  if (existing !== undefined) {
    return existing;
  }
  let rendererPaused = renderService._isPaused;
  let demandPaused = false;
  let pendingVisibilityRefresh = false;
  Object.defineProperty(renderService, "_isPaused", {
    configurable: true,
    enumerable: true,
    get: () => demandPaused || rendererPaused,
    set: (paused: boolean) => {
      rendererPaused = paused;
      if (!paused && !demandPaused && pendingVisibilityRefresh) {
        pendingVisibilityRefresh = false;
        requestFullRefresh();
      }
    },
  });
  const state = {
    setVisible: (visible: boolean) => {
      const wasDemandPaused = demandPaused;
      demandPaused = !visible;
      if (visible) {
        if (rendererPaused) {
          const wasRefreshPending = pendingVisibilityRefresh;
          pendingVisibilityRefresh = true;
          return wasDemandPaused || !wasRefreshPending;
        }
        if (wasDemandPaused) {
          requestFullRefresh();
        }
      }
      return wasDemandPaused !== demandPaused;
    },
  };
  demandStateByService.set(renderService, state);
  return state;
}

export function setTerminalRenderDemand(
  terminal: Terminal,
  visible: boolean,
): boolean {
  const renderService = (terminal as TerminalWithRenderService)._core
    ?._renderService;
  if (renderService === undefined) {
    return false;
  }
  const demandState = demandStateFor(renderService, () => {
    renderService._needsFullRefresh = false;
    terminal.refresh(0, terminal.rows - 1);
  });
  if (!demandState.setVisible(visible)) {
    return false;
  }
  return true;
}
