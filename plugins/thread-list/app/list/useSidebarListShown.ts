import {
  createContext,
  startTransition,
  useContext,
  useLayoutEffect,
  useState,
} from "react";
import { useSidebarContentElementRef } from "../ui/sidebar.js";
import { observeSharedResize } from "@/lib/shared-resize-observer";

export const SidebarListVisibleContext = createContext<boolean | undefined>(
  undefined,
);

export function useSidebarListShown(): boolean {
  const visible = useContext(SidebarListVisibleContext);
  const scrollElementRef = useSidebarContentElementRef();
  const canObserve = typeof ResizeObserver !== "undefined";
  const [shown, setShown] = useState(false);
  useLayoutEffect(() => {
    if (visible !== undefined || !canObserve) return;
    const element = scrollElementRef?.current ?? null;
    if (element === null) {
      const fallback = setTimeout(() => setShown(true));
      return () => clearTimeout(fallback);
    }
    return observeSharedResize(element, {
      read: (entry) =>
        entry === undefined ? undefined : entry.contentRect.height > 0,
      write: (nextShown) => {
        if (nextShown === undefined) return;
        startTransition(() => setShown(nextShown));
      },
    });
  }, [visible, canObserve, scrollElementRef]);
  return visible ?? (canObserve ? shown : true);
}
