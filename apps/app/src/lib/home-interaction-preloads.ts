import { requestBrowserIdle } from "./plugin-frontend-boot-schedule";
import { downloadSplit } from "./split-prefetch";

export const HOME_INTERACTION_SPLITS = [
  "thread-detail",
  "root-compose-panel-tab-content",
  "thread-action-menu-items",
  "prompt-voice-runtime",
  "model-reasoning-picker-body",
  "model-reasoning-menu",
  "extended-icons",
  "thread-terminal",
  "terminal-runtime",
  "terminal-fit",
  "terminal-unicode",
  "terminal-webgl",
  "terminal-search",
  "terminal-web-links",
] as const;

export function scheduleHomeInteractionPreloads(): () => void {
  if (window.location.pathname !== "/") return () => {};
  let stopped = false;
  let frame: number | null = null;
  let readyDelay: number | null = null;
  let cancelIdle: (() => void) | null = null;
  let observer: MutationObserver | null = null;
  const mounted = (selector: string) =>
    [...document.querySelectorAll<HTMLElement>(selector)].some((element) => {
      const visibility = getComputedStyle(element).visibility;
      const box = element.getBoundingClientRect();
      return (
        visibility !== "hidden" &&
        visibility !== "collapse" &&
        box.width > 0 &&
        box.height > 0 &&
        (typeof element.checkVisibility !== "function" ||
          element.checkVisibility())
      );
    });
  const ready = () =>
    window.location.pathname === "/" &&
    mounted("[data-sidebar-thread-id]") &&
    mounted("textarea, [contenteditable=true]");
  const check = () => {
    if (stopped || frame !== null || readyDelay !== null || !ready()) return;
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = null;
        if (stopped || !ready()) return;
        observer?.disconnect();
        observer = null;
        performance.mark("app-home-composer-ready");
        readyDelay = window.setTimeout(() => {
          readyDelay = null;
          if (stopped || !ready()) return;
          cancelIdle = requestBrowserIdle(() => {
            if (stopped || !ready()) return;
            const downloads = new Map<string, Promise<void>>(
              HOME_INTERACTION_SPLITS.map((id) => [id, downloadSplit(id)]),
            );
            void Promise.all(
              [
                "thread-terminal",
                "terminal-runtime",
                "terminal-fit",
                "terminal-unicode",
                "terminal-webgl",
                "terminal-search",
                "terminal-web-links",
              ].map((id) => downloads.get(id)),
            )
              .then(async () => {
                if (stopped || !ready()) return;
                const [{ LazyThreadTerminalPanel }, { importTerminalModules }] =
                  await Promise.all([
                    import("@/components/secondary-panel/lazySecondaryPanelComponents"),
                    import("@/components/thread/terminal/terminal-modules"),
                  ]);
                if (stopped || !ready()) return;
                await Promise.all([
                  LazyThreadTerminalPanel.preload(),
                  importTerminalModules(),
                ]);
              })
              .catch(() => undefined);
          });
        }, 250);
      });
    });
  };
  observer = new MutationObserver(check);
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden"],
  });
  check();
  return () => {
    stopped = true;
    observer?.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    if (readyDelay !== null) window.clearTimeout(readyDelay);
    cancelIdle?.();
  };
}
