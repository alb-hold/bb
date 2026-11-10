import { useLayoutEffect, useRef } from "react";

export function usePanelContentLayoutTransition(
  open: boolean,
  enabled: boolean,
) {
  const ref = useRef<HTMLDivElement>(null);
  const lastInputAt = useRef(Number.NEGATIVE_INFINITY);
  const previousOpen = useRef(open);
  const pending = useRef(false);
  const measure = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const recordInput = () => {
      lastInputAt.current = performance.now();
      pending.current = false;
    };
    const events = ["pointerdown", "keydown", "touchstart", "mousedown"];
    for (const event of events)
      window.addEventListener(event, recordInput, true);
    return () => {
      for (const event of events)
        window.removeEventListener(event, recordInput, true);
    };
  }, []);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!enabled || root === null) return;
    let previousWidth = root.getBoundingClientRect().width;
    const positions = new Map<HTMLElement, number>();
    const animations = new Set<Animation>();
    const readPositions = () => {
      positions.clear();
      for (const element of root.querySelectorAll<HTMLElement>(
        "[data-panel-layout-anchor]",
      )) {
        positions.set(element, element.getBoundingClientRect().left);
      }
    };
    readPositions();
    const update = () => {
      const width = root.getBoundingClientRect().width;
      if (width === previousWidth) {
        if (pending.current) readPositions();
        return;
      }
      for (const animation of animations) animation.cancel();
      animations.clear();
      const shouldAnimate =
        pending.current &&
        performance.now() - lastInputAt.current >= 500 &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      pending.current = false;
      previousWidth = width;
      const nextPositions = new Map<HTMLElement, number>();
      for (const element of root.querySelectorAll<HTMLElement>(
        "[data-panel-layout-anchor]",
      )) {
        const left = element.getBoundingClientRect().left;
        nextPositions.set(element, left);
        const previousLeft = positions.get(element);
        if (
          !shouldAnimate ||
          previousLeft === undefined ||
          previousLeft === left
        )
          continue;
        const animation = element.animate(
          [
            { transform: `translateX(${previousLeft - left}px)` },
            { transform: "translateX(0px)" },
          ],
          { duration: 200, easing: "cubic-bezier(0.32,0.72,0,1)" },
        );
        animations.add(animation);
        animation.onfinish = () => {
          animation.cancel();
          animations.delete(animation);
        };
      }
      positions.clear();
      for (const [element, left] of nextPositions) positions.set(element, left);
    };
    measure.current = update;
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => {
      observer.disconnect();
      measure.current = null;
      pending.current = false;
      for (const animation of animations) animation.cancel();
    };
  }, [enabled]);

  useLayoutEffect(() => {
    if (previousOpen.current === open) return;
    previousOpen.current = open;
    if (!enabled) return;
    pending.current = enabled && performance.now() - lastInputAt.current >= 500;
    measure.current?.();
    let secondFrame: number | null = null;
    const frame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        pending.current = false;
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (secondFrame !== null) cancelAnimationFrame(secondFrame);
    };
  }, [enabled, open]);

  return ref;
}
