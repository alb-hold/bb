import {
  clearQueuedMessageDispatchRetry,
  createQueuedThreadMessageInTransaction,
  deleteNativeTerminalDeliveryWarning,
  failQueuedThreadMessagesWithoutRetry,
  getThread,
  insertNativeTerminalDeliveryWarning,
  isNativeTerminalThread,
  listLegacyNativeTerminalDeliveryTables,
  listNativeTerminalDeliveryWarnings,
  listUnsettledNativeTerminalDeliveryMarks,
  markNativeTerminalDeliveryUncertain,
  pruneSettledOrphanedNativeTerminalDeliveryMarks,
  type NativeTerminalDeliveryMark,
  type NativeTerminalDeliveryWarning,
  type QueuedThreadMessageRow,
} from "@bb/db";
import type { PromptInput, Thread } from "@bb/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { isQueuedMessageClaimActive } from "./queued-messages.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import { enqueueNativeParentNotice } from "./native-parent-notices.js";
import { buildProviderThreadExecutionDefaults } from "./thread-default-policy.js";
import { tryResolveExistingThreadExecutionPlan } from "./thread-execution-plan.js";

export const NATIVE_TERMINAL_DELIVERY_UNCERTAIN_REASON =
  "Delivery uncertain after a restart: send again or delete";

const DELIVERY_WARNINGS_PAGE_SIZE = 100;
const DELIVERY_WARNINGS_SWEEP_BUDGET_MS = 5_000;

export async function settleUncertainNativeTerminalDeliveries(
  deps: LoggedPendingInteractionWorkSessionDeps,
  marks: readonly NativeTerminalDeliveryMark[],
): Promise<QueuedThreadMessageRow[]> {
  if (marks.length === 0) return [];
  const now = Date.now();
  const settled: NativeTerminalDeliveryMark[] = [];
  const recordUncertain = (mark: NativeTerminalDeliveryMark) => {
    if (
      !markNativeTerminalDeliveryUncertain(deps.db, {
        now,
        queuedMessageId: mark.queuedMessageId,
      })
    ) {
      return;
    }
    settled.push(mark);
    clearQueuedMessageDispatchRetry(deps.db, mark.queuedMessageId);
    if (mark.senderThreadId === null || mark.senderThreadId === mark.threadId) {
      return;
    }
    insertNativeTerminalDeliveryWarning(deps.db, {
      now,
      queuedMessageId: mark.queuedMessageId,
      senderThreadId: mark.senderThreadId,
      targetThreadId: mark.threadId,
      text: deliveryWarningText(deps, mark.threadId),
    });
  };
  const withRow = marks.filter((mark) => mark.rowExists);
  const withoutRow = marks.filter((mark) => !mark.rowExists);
  const failed =
    withRow.length === 0
      ? []
      : failQueuedThreadMessagesWithoutRetry(deps.db, deps.hub, {
          failureReason: NATIVE_TERMINAL_DELIVERY_UNCERTAIN_REASON,
          now,
          onFailedInTransaction: (rows) => {
            const failedIds = new Set(rows.map((row) => row.id));
            for (const mark of withRow) {
              if (failedIds.has(mark.queuedMessageId)) recordUncertain(mark);
            }
          },
          rows: withRow.map((mark) => ({
            claimToken: mark.claimToken,
            id: mark.queuedMessageId,
          })),
        });
  if (withoutRow.length > 0) {
    deps.db.transaction(
      () => {
        for (const mark of withoutRow) recordUncertain(mark);
      },
      { behavior: "immediate" },
    );
  }
  for (const mark of settled) {
    deps.logger.warn(
      {
        queuedMessageId: mark.queuedMessageId,
        queuedMessageDeleted: !mark.rowExists,
        submittingAt: mark.submittingAt,
        threadId: mark.threadId,
      },
      "Native terminal message may not have been delivered; holding it until it is sent again or deleted",
    );
  }
  await sendNativeTerminalDeliveryWarnings(deps);
  return failed;
}

export function warnAboutLegacyNativeTerminalDeliveryTables(
  deps: LoggedPendingInteractionWorkSessionDeps,
): void {
  const tables = listLegacyNativeTerminalDeliveryTables(deps.db);
  if (tables.length === 0) return;
  deps.logger.warn(
    { tables },
    "Found a native delivery table from an earlier build of this branch; leaving it untouched",
  );
}

export async function recoverNativeTerminalDeliveries(
  deps: LoggedPendingInteractionWorkSessionDeps,
): Promise<number> {
  pruneSettledOrphanedNativeTerminalDeliveryMarks(deps.db);
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
  await sendNativeTerminalDeliveryWarnings(deps);
  return settled;
}

export async function sendNativeTerminalDeliveryWarnings(
  deps: LoggedPendingInteractionWorkSessionDeps,
): Promise<void> {
  const deadline = Date.now() + DELIVERY_WARNINGS_SWEEP_BUDGET_MS;
  let afterId = 0;
  while (Date.now() < deadline) {
    const page = listNativeTerminalDeliveryWarnings(deps.db, {
      afterId,
      limit: DELIVERY_WARNINGS_PAGE_SIZE,
    });
    for (const warning of page) {
      try {
        await sendDeliveryWarning(deps, warning);
      } catch (error) {
        deps.logger.warn(
          {
            err: error,
            queuedMessageId: warning.queuedMessageId,
            senderThreadId: warning.senderThreadId,
            threadId: warning.targetThreadId,
          },
          "Could not tell the sender that a native terminal message may not have been delivered; will retry",
        );
      }
    }
    const last = page.at(-1);
    if (page.length < DELIVERY_WARNINGS_PAGE_SIZE || last === undefined) {
      return;
    }
    afterId = last.id;
  }
}

async function noticeRowExecution(
  deps: LoggedPendingInteractionWorkSessionDeps,
  sender: Thread,
) {
  const plan = await tryResolveExistingThreadExecutionPlan(deps, {
    executionSource: "client/turn/requested",
    input: {},
    threadId: sender.id,
  });
  return (
    plan?.resolvedExecution ??
    buildProviderThreadExecutionDefaults(deps.providerRegistry, {
      model: sender.providerId,
      providerId: sender.providerId,
    })
  );
}

function deliveryWarningText(
  deps: LoggedPendingInteractionWorkSessionDeps,
  targetThreadId: string,
): string {
  const target = getThread(deps.db, targetThreadId);
  const label = target?.title
    ? `"${target.title}" (${targetThreadId})`
    : targetThreadId;
  return `A message you sent to thread ${label} may not have been delivered: bb restarted while typing it into that thread's terminal. If it is still in that thread's queue, check the thread, then send it again or delete it.`;
}

async function sendDeliveryWarning(
  deps: LoggedPendingInteractionWorkSessionDeps,
  warning: NativeTerminalDeliveryWarning,
): Promise<void> {
  const sender = getThread(deps.db, warning.senderThreadId);
  if (
    sender === null ||
    sender.archivedAt !== null ||
    sender.deletedAt !== null
  ) {
    if (deleteNativeTerminalDeliveryWarning(deps.db, warning.id)) {
      deps.logger.warn(
        {
          queuedMessageId: warning.queuedMessageId,
          senderThreadId: warning.senderThreadId,
          threadId: warning.targetThreadId,
        },
        "Dropped an uncertain-delivery warning: the sending thread is gone",
      );
    }
    return;
  }
  const input: PromptInput[] = [
    { type: "text", mentions: [], text: warning.text },
  ];
  if (isNativeTerminalThread(deps.db, sender.id)) {
    deps.db.transaction(
      () => {
        if (deleteNativeTerminalDeliveryWarning(deps.db, warning.id)) {
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
  const execution = await noticeRowExecution(deps, sender);
  const queued = deps.db.transaction(
    (tx) => {
      if (!deleteNativeTerminalDeliveryWarning(deps.db, warning.id)) {
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
