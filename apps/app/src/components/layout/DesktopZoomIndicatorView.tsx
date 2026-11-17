import {
  BB_DESKTOP_MAX_ZOOM_PERCENT,
  BB_DESKTOP_MIN_ZOOM_PERCENT,
} from "@bb/desktop-contract";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { APP_OVERLAY_LAYER } from "@/components/ui/app-overlay-layers";
import { MACOS_APP_REGION_NO_DRAG_CLASS } from "@/lib/bb-desktop";

export interface DesktopZoomIndicatorViewProps {
  zoomFactor: number;
  fading: boolean;
  zoom: ((direction: "in" | "out" | "reset") => void) | undefined;
  onHoverChange: (hovered: boolean) => void;
}

export function DesktopZoomIndicatorView({
  zoomFactor,
  fading,
  zoom,
  onHoverChange,
}: DesktopZoomIndicatorViewProps) {
  const zoomPercent = Math.round(zoomFactor * 100);
  return (
    <div
      className={`fixed right-0 top-(--bb-app-chrome-row-height) ${MACOS_APP_REGION_NO_DRAG_CLASS}`}
      style={{ zIndex: APP_OVERLAY_LAYER.sharedPortaledOverlay }}
    >
      <div
        role="toolbar"
        aria-label="Zoom"
        className={cn(
          "mt-2 mr-3 flex items-center gap-1 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md",
          fading &&
            "opacity-0 motion-safe:transition-opacity motion-safe:duration-150",
        )}
        style={{ zoom: 1 / zoomFactor }}
        onPointerEnter={() => onHoverChange(true)}
        onPointerLeave={() => onHoverChange(false)}
      >
        <span
          aria-live="polite"
          className="min-w-12 text-center text-sm font-medium tabular-nums"
        >
          {zoomPercent}%
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Zoom out"
          disabled={zoomPercent <= BB_DESKTOP_MIN_ZOOM_PERCENT}
          onClick={() => zoom?.("out")}
        >
          <Icon name="Minus" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Zoom in"
          disabled={zoomPercent >= BB_DESKTOP_MAX_ZOOM_PERCENT}
          onClick={() => zoom?.("in")}
        >
          <Icon name="Plus" />
        </Button>
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          aria-label="Reset zoom"
          disabled={zoomPercent === 100}
          onClick={() => zoom?.("reset")}
        >
          Reset
        </Button>
      </div>
    </div>
  );
}
