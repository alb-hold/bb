import type { IDisposable, ITerminalAddon, Terminal } from "@xterm/xterm";

interface WebglRendererAddon extends ITerminalAddon {
  onContextLoss: (listener: () => void) => IDisposable;
}

interface TerminalWebglAddonModule {
  WebglAddon: new () => WebglRendererAddon;
}

interface TerminalWebglRenderer extends IDisposable {
  readonly renderer: "webgl" | "dom";
  setVisible: (visible: boolean) => void;
}

interface TerminalWebglRendererOptions {
  root?: Pick<HTMLElement, "dataset">;
  visible?: boolean;
}

export async function loadOptionalTerminalWebglAddon(
  importAddon: () => Promise<TerminalWebglAddonModule>,
): Promise<TerminalWebglAddonModule | null> {
  try {
    return await importAddon();
  } catch {
    return null;
  }
}

export function loadTerminalWebglRenderer(
  terminal: Pick<Terminal, "loadAddon">,
  createAddon: () => WebglRendererAddon,
  { root }: TerminalWebglRendererOptions = {},
): TerminalWebglRenderer {
  let renderer: "webgl" | "dom" = "dom";
  let contextLossCount = 0;
  let addon: WebglRendererAddon | null = null;
  let contextLossDisposable: IDisposable | null = null;
  const reportRenderer = () => {
    if (root !== undefined) {
      root.dataset.terminalRenderer = renderer;
      root.dataset.terminalContextLossCount = String(contextLossCount);
    }
  };
  const release = () => {
    contextLossDisposable?.dispose();
    contextLossDisposable = null;
    addon?.dispose();
    addon = null;
    renderer = "dom";
    reportRenderer();
  };
  reportRenderer();
  try {
    addon = createAddon();
    contextLossDisposable = addon.onContextLoss(() => {
      contextLossCount += 1;
      release();
    });
    terminal.loadAddon(addon);
    renderer = "webgl";
    reportRenderer();
  } catch {
    release();
  }
  return {
    get renderer() {
      return renderer;
    },
    setVisible: () => {},
    dispose: release,
  };
}
