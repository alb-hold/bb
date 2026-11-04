import { useEffect } from "react";
import { LazyThreadDetailView } from "@/views/thread-detail/LazyThreadDetailView";

export function prefetchThreadOpenOnIntent(threadId: string): void {
  void LazyThreadDetailView.preload();
  void import("@/lib/thread-open-prefetch")
    .then(({ prefetchThreadOpen }) => prefetchThreadOpen(threadId))
    .catch(() => undefined);
}

export function useThreadOpenIntent(): void {
  useEffect(() => {
    const intent = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const row = event.target.closest("[data-sidebar-thread-id]");
      if (
        event instanceof MouseEvent &&
        event.relatedTarget instanceof Node &&
        row?.contains(event.relatedTarget)
      )
        return;
      const threadId = row?.getAttribute("data-sidebar-thread-id");
      if (threadId) prefetchThreadOpenOnIntent(threadId);
    };
    document.addEventListener("pointerover", intent);
    document.addEventListener("focusin", intent);
    return () => {
      document.removeEventListener("pointerover", intent);
      document.removeEventListener("focusin", intent);
    };
  }, []);
}
