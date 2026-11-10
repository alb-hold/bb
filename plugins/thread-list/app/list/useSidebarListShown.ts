import { createContext, useContext, useLayoutEffect, useState } from "react";
import { useSidebarContentElementRef } from "../ui/sidebar.js";

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
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((entry) => entry.target === element);
      if (entry) setShown(entry.contentRect.height > 0);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible, canObserve, scrollElementRef]);
  return visible ?? (canObserve ? shown : true);
}
