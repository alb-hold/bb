interface PluginFrontendBootScheduleDeps {
  whenRoutePainted: () => Promise<void>;
  requestIdle: (callback: () => void) => () => void;
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  timeoutMs: number;
}

export const PLUGIN_FRONTEND_BOOT_TIMEOUT_MS = 1_500;
export const PLUGIN_FRONTEND_THREAD_SURFACE_TIMEOUT_MS = 10_000;
const HOME_COMPOSER_SELECTOR = "textarea, [contenteditable=true]";
const THREAD_CONTENT_SELECTOR = ".xterm-screen, [data-timeline-row-id]";

function hasMountedSurface(selector: string): boolean {
  return [...document.querySelectorAll<HTMLElement>(selector)].some(
    (element) =>
      typeof element.checkVisibility !== "function" ||
      element.checkVisibility(),
  );
}

export function whenRouteSurfaceMounted(): Promise<void> {
  const pathname = window.location.pathname;
  const selector =
    pathname === "/"
      ? HOME_COMPOSER_SELECTOR
      : /^(?:\/projects\/[^/]+)?\/threads\/[^/]+\/?$/.test(pathname)
        ? THREAD_CONTENT_SELECTOR
        : null;
  if (selector === null) return Promise.resolve();
  return whenSurfaceMounted(
    pathname,
    () => hasMountedSurface(selector),
    pathname === "/"
      ? PLUGIN_FRONTEND_BOOT_TIMEOUT_MS
      : PLUGIN_FRONTEND_THREAD_SURFACE_TIMEOUT_MS,
  );
}

export function whenHomeComposerReady(): Promise<void> {
  const pathname = window.location.pathname;
  if (pathname !== "/") return Promise.resolve();
  return whenSurfaceMounted(
    pathname,
    () => hasMountedSurface(HOME_COMPOSER_SELECTOR),
    PLUGIN_FRONTEND_BOOT_TIMEOUT_MS,
  );
}

function whenSurfaceMounted(
  pathname: string,
  isReady: () => boolean,
  timeoutMs: number,
): Promise<void> {
  if (isReady()) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      observer.disconnect();
      window.clearTimeout(timeout);
      resolve();
    };
    const observer = new MutationObserver(() => {
      if (window.location.pathname !== pathname || isReady()) finish();
    });
    const timeout = window.setTimeout(finish, timeoutMs);
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
    });
  });
}

export function scheduleDeferredPluginFrontendBoot(
  boot: () => void,
  deps: PluginFrontendBootScheduleDeps,
): () => void {
  let settled = false;
  let cancelIdle: (() => void) | null = null;
  const fire = () => {
    if (settled) return;
    settled = true;
    deps.clearTimeout(timeoutId);
    cancelIdle?.();
    cancelIdle = null;
    boot();
  };
  const timeoutId = deps.setTimeout(fire, deps.timeoutMs);
  void deps.whenRoutePainted().then(() => {
    if (settled) return;
    cancelIdle = deps.requestIdle(fire);
  });
  return () => {
    if (settled) return;
    settled = true;
    deps.clearTimeout(timeoutId);
    cancelIdle?.();
    cancelIdle = null;
  };
}

export function requestBrowserIdle(callback: () => void): () => void {
  if (
    typeof window.requestIdleCallback === "function" &&
    typeof window.cancelIdleCallback === "function"
  ) {
    const id = window.requestIdleCallback(callback, { timeout: 1_000 });
    return () => window.cancelIdleCallback(id);
  }
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timeout);
    window.cancelAnimationFrame(frame);
    callback();
  };
  const timeout = window.setTimeout(finish, 1_000);
  let frame = window.requestAnimationFrame(() => {
    frame = window.requestAnimationFrame(finish);
  });
  return () => {
    settled = true;
    window.clearTimeout(timeout);
    window.cancelAnimationFrame(frame);
  };
}
