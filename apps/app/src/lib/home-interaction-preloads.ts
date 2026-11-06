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
  let cancelIdle: (() => void) | null = null;
  let observer: MutationObserver | null = null;
  const mounted = (selector: string) =>
    [...document.querySelectorAll<HTMLElement>(selector)].some(
      (element) =>
        typeof element.checkVisibility !== "function" ||
        element.checkVisibility(),
    );
  const check = () => {
    if (
      stopped ||
      !mounted("[data-sidebar-thread-id]") ||
      !mounted("textarea, [contenteditable=true]")
    )
      return;
    observer?.disconnect();
    observer = null;
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = null;
        if (stopped) return;
        cancelIdle = requestBrowserIdle(() => {
          if (stopped) return;
          for (const id of HOME_INTERACTION_SPLITS) void downloadSplit(id);
        });
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
    cancelIdle?.();
  };
}
