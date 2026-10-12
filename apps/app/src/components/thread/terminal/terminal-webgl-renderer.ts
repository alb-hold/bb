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

type TerminalAddonLoader = Pick<Terminal, "loadAddon"> &
  Partial<Pick<Terminal, "element">>;
const WEBGL_RECOVERY_LIMIT = 3;
const WEBGL_RECOVERY_DELAY_MS = 100;
const WEBGL_STABLE_PERIOD_MS = 10_000;

export async function loadOptionalTerminalWebglAddon(
  importAddon: () => Promise<TerminalWebglAddonModule>,
): Promise<TerminalWebglAddonModule | null> {
  try {
    return await importAddon();
  } catch {
    return null;
  }
}

function captureWebglContextRelease(
  terminal: TerminalAddonLoader,
): (() => void) | null {
  for (const canvas of terminal.element?.querySelectorAll("canvas") ?? []) {
    const context = canvas.getContext("webgl2");
    if (context !== null) {
      const extension = context.getExtension("WEBGL_lose_context");
      return () => {
        if (!context.isContextLost()) {
          extension?.loseContext();
        }
      };
    }
  }
  return null;
}

export function loadTerminalWebglRenderer(
  terminal: TerminalAddonLoader,
  createAddon: () => WebglRendererAddon,
  { root, visible = true }: TerminalWebglRendererOptions = {},
): TerminalWebglRenderer {
  let renderer: "webgl" | "dom" = "dom";
  let contextLossCount = 0;
  let addon: WebglRendererAddon | null = null;
  let contextLossDisposable: IDisposable | null = null;
  let releaseContext: (() => void) | null = null;
  let recoveryTimeout: ReturnType<typeof setTimeout> | null = null;
  let recoveryAttempts = 0;
  let recovering = false;
  let hasLoaded = false;
  let loadedAt = 0;
  let disabled = false;
  let disposed = false;
  const reportRenderer = () => {
    if (root !== undefined) {
      root.dataset.terminalRenderer = renderer;
      root.dataset.terminalContextLossCount = String(contextLossCount);
    }
  };
  const cancelRecovery = () => {
    if (recoveryTimeout !== null) {
      clearTimeout(recoveryTimeout);
      recoveryTimeout = null;
    }
  };
  const release = () => {
    const previousAddon = addon;
    const previousListener = contextLossDisposable;
    const previousContext = releaseContext;
    addon = null;
    contextLossDisposable = null;
    releaseContext = null;
    try {
      previousListener?.dispose();
      previousAddon?.dispose();
    } finally {
      previousContext?.();
      renderer = "dom";
      reportRenderer();
    }
  };
  const scheduleRecovery = () => {
    if (recoveryAttempts >= WEBGL_RECOVERY_LIMIT) {
      disabled = true;
    }
    if (disposed || disabled || !visible || recoveryTimeout !== null) {
      return;
    }
    recoveryTimeout = setTimeout(
      () => {
        recoveryTimeout = null;
        acquire();
      },
      WEBGL_RECOVERY_DELAY_MS * 2 ** recoveryAttempts,
    );
  };
  const acquire = () => {
    if (disposed || disabled || !visible || addon !== null) {
      return;
    }
    if (recovering) {
      if (recoveryAttempts >= WEBGL_RECOVERY_LIMIT) {
        disabled = true;
        return;
      }
      recoveryAttempts += 1;
    }
    try {
      const candidate = createAddon();
      addon = candidate;
      contextLossDisposable = candidate.onContextLoss(() => {
        if (disposed || addon !== candidate) {
          return;
        }
        if (Date.now() - loadedAt >= WEBGL_STABLE_PERIOD_MS) {
          recoveryAttempts = 0;
        }
        contextLossCount += 1;
        console.debug("Terminal WebGL context lost", {
          count: contextLossCount,
        });
        recovering = true;
        release();
        scheduleRecovery();
      });
      terminal.loadAddon(candidate);
      if (addon !== candidate) {
        return;
      }
      releaseContext = captureWebglContextRelease(terminal);
      hasLoaded = true;
      loadedAt = Date.now();
      recovering = false;
      renderer = "webgl";
      reportRenderer();
    } catch {
      release();
      if (hasLoaded) {
        recovering = true;
        scheduleRecovery();
      } else {
        disabled = true;
      }
    }
  };
  reportRenderer();
  acquire();
  return {
    get renderer() {
      return renderer;
    },
    setVisible: (nextVisible) => {
      if (disposed || visible === nextVisible) {
        return;
      }
      visible = nextVisible;
      cancelRecovery();
      if (visible) {
        acquire();
      } else {
        release();
      }
    },
    dispose: () => {
      disposed = true;
      cancelRecovery();
      release();
    },
  };
}

function intersectsClippingAncestors(
  root: HTMLElement,
  box: DOMRect,
  window: Window | null,
): boolean {
  let left = Math.max(box.left, 0);
  let right = Math.min(box.right, window?.innerWidth ?? 0);
  let top = Math.max(box.top, 0);
  let bottom = Math.min(box.bottom, window?.innerHeight ?? 0);
  for (
    let parent = root.parentElement;
    parent !== null;
    parent = parent.parentElement
  ) {
    const style = window?.getComputedStyle(parent);
    const clipsX = /^(auto|scroll|hidden|clip)$/.test(
      style?.overflowX || style?.overflow || "",
    );
    const clipsY = /^(auto|scroll|hidden|clip)$/.test(
      style?.overflowY || style?.overflow || "",
    );
    if (!clipsX && !clipsY) continue;
    const bounds = parent.getBoundingClientRect();
    const scaleX =
      parent.offsetWidth > 0 ? bounds.width / parent.offsetWidth : 1;
    const scaleY =
      parent.offsetHeight > 0 ? bounds.height / parent.offsetHeight : 1;
    if (clipsX) {
      const clipLeft = bounds.left + parent.clientLeft * scaleX;
      left = Math.max(left, clipLeft);
      right = Math.min(right, clipLeft + parent.clientWidth * scaleX);
    }
    if (clipsY) {
      const clipTop = bounds.top + parent.clientTop * scaleY;
      top = Math.max(top, clipTop);
      bottom = Math.min(bottom, clipTop + parent.clientHeight * scaleY);
    }
    if (right <= left || bottom <= top) return false;
  }
  return right > left && bottom > top;
}

export function observeTerminalWebglVisibility({
  root,
  renderer,
  isPanelOpen,
}: {
  root: HTMLElement;
  renderer: TerminalWebglRenderer;
  isPanelOpen: () => boolean;
}): IDisposable & { sync: () => void } {
  const document = root.ownerDocument;
  const window = document.defaultView;
  let disposed = false;
  const supportsIntersectionObserver =
    typeof IntersectionObserver !== "undefined";
  let intersects = !supportsIntersectionObserver;
  const sync = () => {
    if (disposed) {
      return;
    }
    const box = root.getBoundingClientRect();
    const style = window?.getComputedStyle(root);
    renderer.setVisible(
      isPanelOpen() &&
        intersects &&
        document.visibilityState === "visible" &&
        box.width > 0 &&
        box.height > 0 &&
        box.bottom > 0 &&
        box.right > 0 &&
        box.top < (window?.innerHeight ?? 0) &&
        box.left < (window?.innerWidth ?? 0) &&
        (supportsIntersectionObserver ||
          intersectsClippingAncestors(root, box, window)) &&
        style?.visibility !== "hidden" &&
        style?.visibility !== "collapse",
    );
  };
  const resizeObserver = new ResizeObserver(sync);
  const intersectionObserver = !supportsIntersectionObserver
    ? null
    : new IntersectionObserver((entries) => {
        const entry = entries.find((entry) => entry.target === root);
        if (entry !== undefined) {
          intersects =
            entry.isIntersecting &&
            entry.intersectionRect.width > 0 &&
            entry.intersectionRect.height > 0;
        }
        sync();
      });
  resizeObserver.observe(root);
  intersectionObserver?.observe(root);
  if (intersectionObserver === null) {
    for (
      let parent = root.parentElement;
      parent !== null;
      parent = parent.parentElement
    ) {
      resizeObserver.observe(parent);
    }
    window?.addEventListener("scroll", sync, { capture: true, passive: true });
    window?.addEventListener("resize", sync);
  }
  document.addEventListener("visibilitychange", sync);
  sync();
  return {
    sync,
    dispose: () => {
      disposed = true;
      resizeObserver.disconnect();
      intersectionObserver?.disconnect();
      if (intersectionObserver === null) {
        window?.removeEventListener("scroll", sync, true);
        window?.removeEventListener("resize", sync);
      }
      document.removeEventListener("visibilitychange", sync);
    },
  };
}
