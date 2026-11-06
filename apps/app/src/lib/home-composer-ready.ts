let markedAt: number | null = null;
const READY_EVENT = "app-home-composer-ready";

export function markHomeComposerReady(): void {
  performance.mark(READY_EVENT);
  markedAt = Date.now();
  document.dispatchEvent(new Event(READY_EVENT));
}

export function whenHomeBackgroundWorkMayStart(): Promise<number | null> {
  if (window.location.pathname !== "/") return Promise.resolve(null);
  if (markedAt !== null) return Promise.resolve(markedAt + 15_000);
  return new Promise((resolve) => {
    const finish = (settledAt: number | null) => {
      observer.disconnect();
      document.removeEventListener(READY_EVENT, ready);
      document.removeEventListener("input", input);
      window.removeEventListener("popstate", routeChanged);
      resolve(settledAt);
    };
    const ready = () => finish((markedAt ?? Date.now()) + 15_000);
    const input = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-app-composer]")
      )
        finish(Date.now() + 1_000);
    };
    const routeChanged = () => {
      if (window.location.pathname !== "/") finish(null);
    };
    const observer = new MutationObserver(routeChanged);
    observer.observe(document, { childList: true, subtree: true });
    document.addEventListener(READY_EVENT, ready);
    document.addEventListener("input", input);
    window.addEventListener("popstate", routeChanged);
  });
}
