interface PluginFrontendBootScheduleDeps {
  whenRoutePainted: () => Promise<void>;
  requestIdle: (callback: () => void) => () => void;
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  timeoutMs: number;
}

export const PLUGIN_FRONTEND_BOOT_TIMEOUT_MS = 1_500;
const HOME_COMPOSER_SELECTOR = "textarea, [contenteditable=true]";

export function whenHomeComposerInputOrTimeout(): Promise<void> {
  if (window.location.pathname !== "/") return Promise.resolve();
  const composer = document.querySelector(HOME_COMPOSER_SELECTOR);
  if (!composer) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      composer.removeEventListener("input", finish);
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(finish, 2_000);
    composer.addEventListener("input", finish, { once: true });
  });
}

export function whenHomeComposerMounted(): Promise<void> {
  if (
    window.location.pathname !== "/" ||
    document.querySelector(HOME_COMPOSER_SELECTOR)
  )
    return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      observer.disconnect();
      window.clearTimeout(timeout);
      resolve();
    };
    const observer = new MutationObserver(() => {
      if (document.querySelector(HOME_COMPOSER_SELECTOR)) finish();
    });
    const timeout = window.setTimeout(finish, PLUGIN_FRONTEND_BOOT_TIMEOUT_MS);
    observer.observe(document, { childList: true, subtree: true });
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
