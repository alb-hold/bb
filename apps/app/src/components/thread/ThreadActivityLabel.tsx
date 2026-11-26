import type { ThreadListIndicatorKind } from "@bb/client-core";
import { Icon } from "@bb/shared-ui/icon";
import { getThreadActivityLabel } from "@/lib/thread-activity-label";
import { SIDEBAR_SUCCESS_STATUS_COLOR_CLASS } from "@bb/shared-ui/sidebar-row-classes";
import { ThreadStatusGlyph } from "./ThreadStatusGlyph";

export function ThreadActivityLabel({
  error = false,
  exited = false,
  indicator,
  label = "Thread activity",
}: {
  error?: boolean;
  exited?: boolean;
  indicator: ThreadListIndicatorKind;
  label?: string;
}) {
  const showError = indicator === "none" && error && !exited;
  const showExited = indicator === "none" && exited;
  return (
    <div
      role="status"
      aria-label={label}
      className="flex h-4 shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground"
    >
      {showError ? (
        <Icon
          name="CircleX"
          className="pointer-events-none size-3.5 shrink-0 text-destructive"
          aria-hidden
        />
      ) : showExited ? (
        <span aria-hidden className="size-1.5 rounded-full bg-current text-muted-foreground" />
      ) : indicator === "none" ? (
        <span aria-hidden className={`size-1.5 rounded-full bg-current ${SIDEBAR_SUCCESS_STATUS_COLOR_CLASS}`} />
      ) : (
        <ThreadStatusGlyph
          indicator={indicator}
          size="compact"
          hideAccessibleLabel
        />
      )}
      <span>
        {showError
          ? "Error"
          : showExited
            ? "Exited"
            : getThreadActivityLabel(indicator)}
      </span>
    </div>
  );
}
