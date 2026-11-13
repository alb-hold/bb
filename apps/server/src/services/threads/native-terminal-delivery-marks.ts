import {
  clearQueuedMessageDispatchRetry,
  failQueuedThreadMessagesWithoutRetry,
  getThread,
  isNativeTerminalThread,
  listUnsettledNativeTerminalDeliveryMarks,
  markNativeTerminalDeliveriesUncertain,
  pruneOrphanedNativeTerminalDeliveryMarks,
  type NativeTerminalDeliveryMark,
  type QueuedThreadMessageRow,
} from "@bb/db";
import type { PromptInput } from "@bb/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { isQueuedMessageClaimActive } from "./queued-messages.js";
import { enqueueNativeParentNotice } from "./native-parent-notices.js";
import { queueParentSystemMessage } from "./parent-system-messages.js";

export const NATIVE_TERMINAL_DELIVERY_UNCERTAIN_REASON =
  "Delivery uncertain after a restart: send again or delete";

export function settleUncertainNativeTerminalDeliveries(
  deps: LoggedPendingInteractionWorkSessionDeps,
  marks: readonly NativeTerminalDeliveryMark[],
): QueuedThreadMessageRow[] {
  if (marks.length === 0) return [];
  const now = Date.now();
  const failed = failQueuedThreadMessagesWithoutRetry(deps.db, deps.hub, {
    failureReason: NATIVE_TERMINAL_DELIVERY_UNCERTAIN_REASON,
    now,
    rows: marks.map((mark) => ({
      claimToken: mark.claimToken,
      id: mark.queuedMessageId,
    })),
  });
  const failedIds = failed.map((row) => row.id);
  markNativeTerminalDeliveriesUncertain(deps.db, {
    now,
    queuedMessageIds: failedIds,
  });
  for (const mark of marks) {
    if (!failedIds.includes(mark.queuedMessageId)) continue;
    clearQueuedMessageDispatchRetry(deps.db, mark.queuedMessageId);
    deps.logger.warn(
      {
        queuedMessageId: mark.queuedMessageId,
        submittingAt: mark.submittingAt,
        threadId: mark.threadId,
      },
      "Native terminal message may not have been delivered; holding it until it is sent again or deleted",
    );
    notifySenderOfUncertainDelivery(deps, mark);
  }
  return failed;
}

export function recoverNativeTerminalDeliveries(
  deps: LoggedPendingInteractionWorkSessionDeps,
): number {
  pruneOrphanedNativeTerminalDeliveryMarks(deps.db);
  let settled = 0;
  for (const mark of listUnsettledNativeTerminalDeliveryMarks(deps.db)) {
    if (
      mark.claimToken !== null &&
      isQueuedMessageClaimActive(mark.claimToken)
    ) {
      continue;
    }
    try {
      settled += settleUncertainNativeTerminalDeliveries(deps, [mark]).length;
    } catch (error) {
      deps.logger.error(
        { err: error, queuedMessageId: mark.queuedMessageId },
        "Could not settle a native terminal message left mid-delivery",
      );
    }
  }
  return settled;
}

function notifySenderOfUncertainDelivery(
  deps: LoggedPendingInteractionWorkSessionDeps,
  mark: NativeTerminalDeliveryMark,
): void {
  const senderThreadId = mark.senderThreadId;
  if (senderThreadId === null || senderThreadId === mark.threadId) return;
  const target = getThread(deps.db, mark.threadId);
  const label = target?.title ? `"${target.title}" (${mark.threadId})` : mark.threadId;
  const input: PromptInput[] = [
    {
      type: "text",
      mentions: [],
      text: `A message you sent to thread ${label} may not have been delivered: bb restarted while typing it into that thread's terminal. It is held in that thread's queue; check the thread, then send it again or delete it.`,
    },
  ];
  try {
    if (isNativeTerminalThread(deps.db, senderThreadId)) {
      enqueueNativeParentNotice(deps, {
        input,
        parentThreadId: senderThreadId,
      });
      return;
    }
    void queueParentSystemMessage(deps, {
      input,
      parentThreadId: senderThreadId,
      systemMessageKind: "unlabeled",
      systemMessageSubject: null,
    }).catch((error: unknown) => {
      deps.logger.warn(
        { err: error, senderThreadId, threadId: mark.threadId },
        "Could not tell the sender that a native terminal message may not have been delivered",
      );
    });
  } catch (error) {
    deps.logger.warn(
      { err: error, senderThreadId, threadId: mark.threadId },
      "Could not tell the sender that a native terminal message may not have been delivered",
    );
  }
}
