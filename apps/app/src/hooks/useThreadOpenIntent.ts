import { useEffect } from "react";
import { LazyThreadDetailView } from "@/views/thread-detail/LazyThreadDetailView";
import { downloadSplit } from "@/lib/split-prefetch";

export function prefetchThreadViewOnIntent(nativeTerminal = false): void {
  void LazyThreadDetailView.preload();
  if (nativeTerminal) {
    void downloadSplit("thread-terminal");
    void import("@/components/thread/terminal/terminal-modules")
      .then(({ preloadTerminalModules }) => preloadTerminalModules())
      .catch(() => undefined);
  }
}

export function prefetchThreadOpenOnIntent(threadId: string): void {
  prefetchThreadViewOnIntent();
  void import("@/lib/thread-open-prefetch")
    .then(({ prefetchThreadOpen }) => prefetchThreadOpen(threadId))
    .catch(() => undefined);
}

export function useThreadOpenIntent(): void {
  useEffect(() => {
    let userInteracted = false;
    const intent = (event: Event) => {
      if (
        event.type === "pointerdown" ||
        event.type === "keydown" ||
        event.type === "touchstart"
      )
        userInteracted = true;
      if (!(event.target instanceof Element)) return;
      const row = event.target.closest("[data-sidebar-thread-id]");
      if (
        event instanceof MouseEvent &&
        event.relatedTarget instanceof Node &&
        row?.contains(event.relatedTarget)
      )
        return;
      const link = event.target.closest<HTMLAnchorElement>("a[href]");
      const destination = link ? new URL(link.href, document.baseURI) : null;
      const threadId =
        row?.getAttribute("data-sidebar-thread-id") ??
        (destination?.origin === window.location.origin
          ? destination.pathname.match(
              /^\/(?:projects\/[^/]+\/)?threads\/([^/]+)\/?$/,
            )?.[1]
          : null);
      if (threadId) prefetchThreadOpenOnIntent(threadId);
      if (
        window.location.pathname === "/" &&
        event.target.closest("[data-app-composer]") &&
        (event.type === "input" ||
          event.type === "submit" ||
          (userInteracted &&
            (event.type === "focusin" ||
              event.type === "pointerdown" ||
              event.type === "touchstart")))
      )
        prefetchThreadViewOnIntent(
          event.target
            .closest("[data-app-composer]")
            ?.getAttribute("data-native-terminal") === "true",
        );
    };
    document.addEventListener("pointerover", intent);
    document.addEventListener("focusin", intent);
    document.addEventListener("touchstart", intent, { passive: true });
    document.addEventListener("pointerdown", intent, true);
    document.addEventListener("keydown", intent, true);
    document.addEventListener("input", intent);
    document.addEventListener("submit", intent);
    document.addEventListener("click", intent);
    return () => {
      document.removeEventListener("pointerover", intent);
      document.removeEventListener("focusin", intent);
      document.removeEventListener("touchstart", intent);
      document.removeEventListener("pointerdown", intent, true);
      document.removeEventListener("keydown", intent, true);
      document.removeEventListener("input", intent);
      document.removeEventListener("submit", intent);
      document.removeEventListener("click", intent);
    };
  }, []);
}
