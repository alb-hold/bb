import {
  getThreadListIndicatorLabel,
  type ThreadListIndicatorKind,
} from "@bb/client-core";

export function getThreadActivityLabel(
  indicator: ThreadListIndicatorKind,
): string {
  return getThreadListIndicatorLabel(indicator) ?? "Idle";
}
