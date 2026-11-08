import { useEffect } from "react";
import { LazyThreadDetailView } from "@/views/thread-detail/LazyThreadDetailView";
import { downloadSplit } from "@/lib/split-prefetch";
import { warmSplitWhenQuiet } from "@/lib/settled-split-downloads";

export function prefetchThreadViewOnIntent(nativeTerminal = false): void {
  void LazyThreadDetailView.preload();
  if (nativeTerminal) {
    void downloadSplit("thread-terminal");
    void import("@/components/thread/terminal/terminal-modules")
      .then(({ preloadTerminalModules }) => preloadTerminalModules())
      .catch(() => undefined);
  }
}

export function prefetchThreadOpenOnIntent(
  threadId: string,
  nativeTerminal = false,
): void {
  prefetchThreadViewOnIntent(nativeTerminal);
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
      if (threadId)
        prefetchThreadOpenOnIntent(
          threadId,
          Boolean(
            (row ?? link)?.querySelector(
              '[role="img"][aria-label="Native terminal"]',
            ),
          ),
        );
      if (
        window.location.pathname === "/" &&
        event.target.closest("[data-app-composer]") &&
        (event.type === "input" ||
          event.type === "submit" ||
          (userInteracted &&
            (event.type === "focusin" ||
              event.type === "pointerdown" ||
              event.type === "touchstart")))
      ) {
        const nativeTerminal =
          event.target
            .closest("[data-app-composer]")
            ?.getAttribute("data-native-terminal") === "true";
        if (event.type === "submit" || nativeTerminal)
          prefetchThreadViewOnIntent(nativeTerminal);
        else {
          warmSplitWhenQuiet("thread-detail", () =>
            LazyThreadDetailView.preload(),
          );
        }
      }
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
