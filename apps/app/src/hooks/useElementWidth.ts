import { useCallback, useState } from "react";

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
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((entry) => entry.target === element);
      if (entry)
        setWidth(entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width);
    });
    observer.observe(element, { box: "border-box" });
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}
