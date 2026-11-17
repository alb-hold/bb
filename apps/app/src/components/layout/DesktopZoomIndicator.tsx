import { useCallback, useEffect, useRef, useState } from "react";
import { defineSplit } from "@/lib/define-split";
import { getBbDesktopInfo } from "@/lib/bb-desktop";

const DesktopZoomIndicatorView = defineSplit<
  import("./DesktopZoomIndicatorView").DesktopZoomIndicatorViewProps
>({
  id: "desktop-zoom-indicator-view",
  load: () =>
    import("./DesktopZoomIndicatorView").then(
      (module) => module.DesktopZoomIndicatorView,
    ),
  loading: () => null,
  error: () => null,
  tier: "intent",
});

const HIDE_DELAY_MS = 2000;
const FADE_OUT_MS = 150;

export function DesktopZoomIndicator() {
  const desktop = getBbDesktopInfo();
  const onZoomChange = desktop?.onZoomChange;
  const zoom = desktop?.zoom;
  const [zoomFactor, setZoomFactor] = useState<number | null>(null);
  const [fading, setFading] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hovered = useRef(false);

  const restartHideTimer = useCallback(() => {
    clearTimeout(hideTimer.current);
    setFading(false);
    if (!hovered.current) {
      hideTimer.current = setTimeout(() => {
        setFading(true);
        hideTimer.current = setTimeout(() => setZoomFactor(null), FADE_OUT_MS);
      }, HIDE_DELAY_MS);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onZoomChange?.((factor) => {
      setZoomFactor(factor);
      restartHideTimer();
    });
    return () => {
      unsubscribe?.();
      clearTimeout(hideTimer.current);
    };
  }, [onZoomChange, restartHideTimer]);

  const onHoverChange = useCallback(
    (next: boolean) => {
      hovered.current = next;
      restartHideTimer();
    },
    [restartHideTimer],
  );

  if (zoomFactor === null) {
    return null;
  }

  return (
    <DesktopZoomIndicatorView
      zoomFactor={zoomFactor}
      fading={fading}
      zoom={zoom}
      onHoverChange={onHoverChange}
    />
  );
}
