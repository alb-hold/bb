import { requestBrowserIdle } from "./plugin-frontend-boot-schedule";
import { downloadSplit } from "./split-prefetch";
import {
  createSettledWorkSchedule,
  scheduleSettledSplitDownloads,
} from "./settled-split-downloads";
import { markHomeComposerReady } from "./home-composer-ready";

export const HOME_INTERACTION_SPLITS = [
  "model-reasoning-picker-body",
  "model-reasoning-menu",
] as const;

export const HOME_SETTLED_SPLITS = [
  "thread-detail",
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
  const activity = createSettledWorkSchedule(() => true);
  let stopped = false;
  let frame: number | null = null;
  let readyDelay: number | null = null;
  let cancelIdle: (() => void) | null = null;
  let observer: MutationObserver | null = null;
  let cancelSettled: (() => void) | null = null;
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
        markHomeComposerReady();
        cancelSettled = scheduleSettledSplitDownloads(
          HOME_SETTLED_SPLITS,
          ready,
        );
        readyDelay = window.setTimeout(() => {
          readyDelay = null;
          if (stopped || !ready()) return;
          cancelIdle = requestBrowserIdle(() => {
            if (stopped || !ready()) return;
            for (const id of HOME_INTERACTION_SPLITS) void downloadSplit(id);
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
    activity.cancel();
    observer?.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    if (readyDelay !== null) window.clearTimeout(readyDelay);
    cancelIdle?.();
    cancelSettled?.();
  };
}
