import type { ThreadListIndicatorKind } from "@bb/client-core";
import { getThreadActivityLabel } from "@/lib/thread-activity-label";
import { SIDEBAR_SUCCESS_STATUS_COLOR_CLASS } from "@bb/shared-ui/sidebar-row-classes";
import { ThreadStatusGlyph } from "./ThreadStatusGlyph";

export function ThreadActivityLabel({
  indicator,
  label = "Thread activity",
}: {
  indicator: ThreadListIndicatorKind;
  label?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className="flex h-4 shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground"
    >
      {indicator === "none" ? (
        <span aria-hidden className={`size-1.5 rounded-full bg-current ${SIDEBAR_SUCCESS_STATUS_COLOR_CLASS}`} />
      ) : (
        <ThreadStatusGlyph
          indicator={indicator}
          size="compact"
          hideAccessibleLabel
        />
      )}
      <span>{getThreadActivityLabel(indicator)}</span>
    </div>
  );
}
