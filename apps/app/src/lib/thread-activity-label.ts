import type { ThreadResponse } from "@bb/server-contract";
import {
  getThreadListIndicatorLabel,
  resolveThreadListIndicator,
  isNativeActivityUnconfirmed,
  isRunningThreadRuntimeDisplayStatus,
  type ThreadListIndicatorKind,
} from "@bb/client-core";

export function getThreadActivityLabel(
  indicator: ThreadListIndicatorKind,
): string {
  return getThreadListIndicatorLabel(indicator) ?? "Idle";
}

export function getThreadDetailActivityIndicator(
  thread: Pick<
    ThreadResponse,
    | "runtime"
    | "hasPendingInteraction"
    | "activeBackgroundAgentCount"
    | "queuedMessageCount"
  >,
): ThreadListIndicatorKind {
  const unconfirmed = isNativeActivityUnconfirmed(thread.runtime);
  const running = isRunningThreadRuntimeDisplayStatus(
    thread.runtime.displayStatus,
  );
  return resolveThreadListIndicator({
    hasPendingInteraction: thread.hasPendingInteraction,
    isRuntimeActive: running && !unconfirmed,
    isActivityUnreported: running && unconfirmed,
    isBackgroundAgentActive: thread.activeBackgroundAgentCount > 0,
    queuedWork: thread.queuedMessageCount > 0 ? "waiting" : "none",
    queuedFailedCount: 0,
    hasUnsubmittedDraft: false,
    hasUnreadError: false,
    hasUnreadSuccess: false,
    isAutomationWoken: false,
    isBackgroundCommandActive: false,
    isGoalActive: false,
    isPlanModeActive: false,
    isWorkflowActive: false,
  });
}
