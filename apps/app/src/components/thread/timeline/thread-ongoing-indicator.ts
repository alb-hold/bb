import { isRunningThreadRuntimeDisplayStatus } from "@bb/client-core";
import type { ThreadRuntimeDisplayStatus, ThreadStatus } from "@bb/domain";

export function resolveThreadOngoingIndicator({
  activeBackgroundAgentCount,
  activeBackgroundCommandCount,
  activeWorkflowCount,
  displayStatus,
  isStopping,
  isTurnSubmitting,
  nativeActivityUnconfirmed,
  timelineLoading,
  threadStatus,
}: {
  activeBackgroundAgentCount: number;
  activeBackgroundCommandCount: number;
  activeWorkflowCount: number;
  displayStatus: ThreadRuntimeDisplayStatus;
  isStopping: boolean;
  isTurnSubmitting: boolean;
  nativeActivityUnconfirmed: boolean;
  timelineLoading: boolean;
  threadStatus: ThreadStatus | undefined;
}): { label: string | undefined; show: boolean } {
  const isProvisioningDisplayStatus =
    displayStatus === "provisioning" || displayStatus === "starting";
  const hasActiveBackgroundWork =
    activeWorkflowCount > 0 ||
    activeBackgroundCommandCount > 0 ||
    activeBackgroundAgentCount > 0;
  const backgroundOnlyIndicatorLabel =
    (displayStatus === "idle" || nativeActivityUnconfirmed) &&
    hasActiveBackgroundWork
      ? "Background work running"
      : undefined;
  return {
    label: isProvisioningDisplayStatus
      ? "Provisioning thread..."
      : backgroundOnlyIndicatorLabel,
    show:
      !isStopping &&
      (isProvisioningDisplayStatus ||
        (!timelineLoading &&
          (isTurnSubmitting ||
            (threadStatus !== "idle" &&
              isRunningThreadRuntimeDisplayStatus(displayStatus) &&
              !nativeActivityUnconfirmed) ||
            backgroundOnlyIndicatorLabel !== undefined))),
  };
}
