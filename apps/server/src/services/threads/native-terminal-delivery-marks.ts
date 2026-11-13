import {
  clearNativeTerminalDeliveryWarning,
  clearQueuedMessageDispatchRetry,
  createQueuedThreadMessageInTransaction,
  failQueuedThreadMessagesWithoutRetry,
  getThread,
  isNativeTerminalThread,
  listPendingNativeTerminalDeliveryWarnings,
  listUnsettledNativeTerminalDeliveryMarks,
  markNativeTerminalDeliveriesUncertain,
  pruneOrphanedNativeTerminalDeliveryMarks,
  type NativeTerminalDeliveryMark,
  type PendingNativeTerminalDeliveryWarning,
  type QueuedThreadMessageRow,
} from "@bb/db";
import type { PromptInput } from "@bb/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { isQueuedMessageClaimActive } from "./queued-messages.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import { enqueueNativeParentNotice } from "./native-parent-notices.js";
import { buildExecutionOptions } from "./thread-commands.js";

export const NATIVE_TERMINAL_DELIVERY_UNCERTAIN_REASON =
  "Delivery uncertain after a restart: send again or delete";

export async function settleUncertainNativeTerminalDeliveries(
  deps: LoggedPendingInteractionWorkSessionDeps,
  marks: readonly NativeTerminalDeliveryMark[],
): Promise<QueuedThreadMessageRow[]> {
  if (marks.length === 0) return [];
  const now = Date.now();
  const failed = failQueuedThreadMessagesWithoutRetry(deps.db, deps.hub, {
    failureReason: NATIVE_TERMINAL_DELIVERY_UNCERTAIN_REASON,
    now,
    onFailedInTransaction: (rows) => {
      const failedIds = new Set(rows.map((row) => row.id));
      markNativeTerminalDeliveriesUncertain(deps.db, {
        deliveries: marks
          .filter((mark) => failedIds.has(mark.queuedMessageId))
          .map((mark) => ({
            queuedMessageId: mark.queuedMessageId,
            warnSenderThreadId:
              mark.senderThreadId === null ||
              mark.senderThreadId === mark.threadId
                ? null
                : mark.senderThreadId,
          })),
        now,
      });
    },
    rows: marks.map((mark) => ({
      claimToken: mark.claimToken,
      id: mark.queuedMessageId,
    })),
  });
  const failedIds = new Set(failed.map((row) => row.id));
  for (const mark of marks) {
    if (!failedIds.has(mark.queuedMessageId)) continue;
    clearQueuedMessageDispatchRetry(deps.db, mark.queuedMessageId);
    deps.logger.warn(
      {
        queuedMessageId: mark.queuedMessageId,
        submittingAt: mark.submittingAt,
        threadId: mark.threadId,
      },
      "Native terminal message may not have been delivered; holding it until it is sent again or deleted",
    );
  }
  await sendPendingNativeTerminalDeliveryWarnings(deps);
  return failed;
}

export async function recoverNativeTerminalDeliveries(
  deps: LoggedPendingInteractionWorkSessionDeps,
): Promise<number> {
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
      settled += (await settleUncertainNativeTerminalDeliveries(deps, [mark]))
        .length;
    } catch (error) {
      deps.logger.error(
        { err: error, queuedMessageId: mark.queuedMessageId },
        "Could not settle a native terminal message left mid-delivery",
      );
    }
  }
  await sendPendingNativeTerminalDeliveryWarnings(deps);
  return settled;
}

export async function sendPendingNativeTerminalDeliveryWarnings(
  deps: LoggedPendingInteractionWorkSessionDeps,
): Promise<void> {
  for (const warning of listPendingNativeTerminalDeliveryWarnings(deps.db)) {
    try {
      await sendDeliveryWarning(deps, warning);
    } catch (error) {
      deps.logger.warn(
        {
          err: error,
          queuedMessageId: warning.queuedMessageId,
          senderThreadId: warning.senderThreadId,
          threadId: warning.threadId,
        },
        "Could not tell the sender that a native terminal message may not have been delivered; will retry",
      );
    }
  }
}

function deliveryWarningInput(
  deps: LoggedPendingInteractionWorkSessionDeps,
  warning: PendingNativeTerminalDeliveryWarning,
): PromptInput[] {
  const target = getThread(deps.db, warning.threadId);
  const label = target?.title
    ? `"${target.title}" (${warning.threadId})`
    : warning.threadId;
  return [
    {
      type: "text",
      mentions: [],
      text: `A message you sent to thread ${label} may not have been delivered: bb restarted while typing it into that thread's terminal. It is held in that thread's queue; check the thread, then send it again or delete it.`,
    },
  ];
}

async function sendDeliveryWarning(
  deps: LoggedPendingInteractionWorkSessionDeps,
  warning: PendingNativeTerminalDeliveryWarning,
): Promise<void> {
  const sender = getThread(deps.db, warning.senderThreadId);
  if (
    sender === null ||
    sender.archivedAt !== null ||
    sender.deletedAt !== null
  ) {
    clearNativeTerminalDeliveryWarning(deps.db, warning.queuedMessageId);
    return;
  }
  const input = deliveryWarningInput(deps, warning);
  if (isNativeTerminalThread(deps.db, sender.id)) {
    deps.db.transaction(
      () => {
        if (
          clearNativeTerminalDeliveryWarning(deps.db, warning.queuedMessageId)
        ) {
          enqueueNativeParentNotice(deps, {
            input,
            parentThreadId: sender.id,
          });
        }
      },
      { behavior: "immediate" },
    );
    return;
  }
  const execution = await buildExecutionOptions(
    deps,
    {},
    { threadId: sender.id },
  );
  const queued = deps.db.transaction(
    (tx) => {
      if (
        !clearNativeTerminalDeliveryWarning(deps.db, warning.queuedMessageId)
      ) {
        return false;
      }
      createQueuedThreadMessageInTransaction(tx, {
        threadId: sender.id,
        content: input,
        senderThreadId: null,
        origin: null,
        originPluginId: null,
        model: execution.model,
        reasoningLevel: execution.reasoningLevel,
        permissionMode: execution.permissionMode,
        serviceTier: execution.serviceTier,
        waitingOn: { kind: "thread-busy" },
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: { kind: "unlabeled", subject: null },
      });
      return true;
    },
    { behavior: "immediate" },
  );
  if (!queued) return;
  deps.hub.notifyThread(sender.id, ["queue-changed"]);
  requestQueuedMessageDispatch(deps, {
    kind: "thread-ready",
    threadId: sender.id,
  });
}
