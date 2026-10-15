import type { Terminal } from "@xterm/xterm";

interface TerminalRenderService {
  _isPaused: boolean;
  _needsFullRefresh: boolean;
}

interface TerminalRenderDemandState {
  setVisible: (visible: boolean) => void;
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
): TerminalRenderDemandState {
  const existing = demandStateByService.get(renderService);
  if (existing !== undefined) {
    return existing;
  }
  let rendererPaused = renderService._isPaused;
  let demandPaused = false;
  Object.defineProperty(renderService, "_isPaused", {
    configurable: true,
    enumerable: true,
    get: () => demandPaused || rendererPaused,
    set: (paused: boolean) => {
      rendererPaused = paused;
    },
  });
  const state = {
    setVisible: (visible: boolean) => {
      demandPaused = !visible;
      if (visible) {
        rendererPaused = false;
      }
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
  const demandState = demandStateFor(renderService);
  if (renderService._isPaused === !visible) {
    return false;
  }
  demandState.setVisible(visible);
  if (visible) {
    renderService._needsFullRefresh = false;
    terminal.refresh(0, terminal.rows - 1);
  }
  return true;
}
