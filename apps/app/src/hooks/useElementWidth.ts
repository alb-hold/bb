import { useCallback, useState } from "react";
import { observeSharedResize } from "@bb/shared-ui/lib/shared-resize-observer";

export function useElementWidth() {
  const [width, setWidth] = useState(0);
  const ref = useCallback((element: HTMLDivElement | null) => {
    if (element === null) return;
    if (typeof ResizeObserver === "undefined") {
      const frame = requestAnimationFrame(() =>
        setWidth(element.getBoundingClientRect().width),
      );
      return () => cancelAnimationFrame(frame);
    }
    return observeSharedResize(element, {
      read: (entry) =>
        entry?.borderBoxSize[0]?.inlineSize ?? entry?.contentRect.width ?? 0,
      write: setWidth,
    });
  }, []);
  return { ref, width };
}
