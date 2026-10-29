import {
  getThread,
  applyThreadLifecycleEvent,
  applyThreadLifecycleEventInTransaction,
  clearThreadRowStateAtOutputSeqs,
  isNativeTerminalThread,
  type ApplyThreadLifecycleEventArgs,
  type ApplyThreadLifecycleEventOutcome,
  type DbConnection,
  type DbTransaction,
} from "@bb/db";
import type { ThreadLifecycleEvent } from "@bb/domain";
import { recordFinishedTurn } from "../system/turn-telemetry.js";
import type { ServerLogger } from "../../types.js";
import type { NotificationHub } from "../../ws/hub.js";
import {
  emitPluginThreadLifecycleOutcome,
  emitPluginTurnFailed,
} from "../plugins/plugin-thread-events.js";
import type { ProviderRegistryService } from "../providers/provider-registry.js";
import { buildThreadStatusChangeMetadata } from "./thread-runtime-display.js";
import { releaseWorkspaceForThread } from "./workspace-write-serialization.js";

function isSessionStatusCorrection(event: ThreadLifecycleEvent): boolean {
  return event.type === "session.lost" || event.type === "session.resumed";
}

function announceTurnFailed(
  args: ApplyThreadLifecycleEventArgs,
  outcome: ApplyThreadLifecycleEventOutcome,
): void {
  if (!outcome.applied || args.event.type !== "run.failed") return;
  emitPluginTurnFailed(args.threadId);
}

interface ApplyLoggedThreadLifecycleEventDeps {
  db: DbConnection;
  hub: Pick<
    NotificationHub,
    | "clearDeviceHandoffTurnSubmitterForThread"
    | "getDaemonSessionIdForHost"
    | "notifyThread"
  >;
  logger: ServerLogger;
  providerRegistry: ProviderRegistryService;
}

interface ApplyLoggedThreadLifecycleEventTransactionDeps {
  db: DbTransaction;
  logger: ServerLogger;
}

function logUnappliedThreadLifecycleEvent(
  logger: ServerLogger,
  args: ApplyThreadLifecycleEventArgs,
  outcome: ApplyThreadLifecycleEventOutcome,
): void {
  if (outcome.applied) {
    return;
  }
  logger.info(
    {
      detail: outcome.detail,
      event: args.event.type,
      reason: outcome.reason,
      threadId: args.threadId,
    },
    "Thread lifecycle event not applied",
  );
}

export function applyLoggedThreadLifecycleEvent(
  deps: ApplyLoggedThreadLifecycleEventDeps,
  args: ApplyThreadLifecycleEventArgs,
): ApplyThreadLifecycleEventOutcome {
  const previousStatus = getThread(deps.db, args.threadId)?.status;
  const outcome = applyThreadLifecycleEvent(deps.db, args);
  if (outcome.applied && previousStatus !== undefined) {
    recordFinishedTurn(deps.db, args.threadId, args.event, previousStatus);
  }
  if (outcome.applied) {
    if (outcome.thread.status === "idle" || outcome.thread.status === "error") {
      deps.hub.clearDeviceHandoffTurnSubmitterForThread(args.threadId);
    }
    if (
      (outcome.thread.status === "idle" || outcome.thread.status === "error") &&
      !isNativeTerminalThread(deps.db, args.threadId)
    ) {
      clearThreadRowStateAtOutputSeqs(deps.db, args.threadId);
      releaseWorkspaceForThread(deps, outcome.thread);
    }
    deps.hub.notifyThread(
      args.threadId,
      ["status-changed"],
      buildThreadStatusChangeMetadata(deps, outcome.thread),
    );
  }
  logUnappliedThreadLifecycleEvent(deps.logger, args, outcome);
  if (!isSessionStatusCorrection(args.event)) {
    emitPluginThreadLifecycleOutcome(outcome);
  }
  announceTurnFailed(args, outcome);
  return outcome;
}

export function applyLoggedThreadLifecycleEventInTransaction(
  deps: ApplyLoggedThreadLifecycleEventTransactionDeps,
  args: ApplyThreadLifecycleEventArgs,
): ApplyThreadLifecycleEventOutcome {
  const previousStatus = getThread(deps.db, args.threadId)?.status;
  const outcome = applyThreadLifecycleEventInTransaction(deps.db, args);
  if (outcome.applied && previousStatus !== undefined) {
    recordFinishedTurn(deps.db, args.threadId, args.event, previousStatus);
  }
  if (
    outcome.applied &&
    (outcome.thread.status === "idle" || outcome.thread.status === "error") &&
    !isNativeTerminalThread(deps.db, args.threadId)
  ) {
    clearThreadRowStateAtOutputSeqs(deps.db, args.threadId);
    releaseWorkspaceForThread(deps, outcome.thread);
  }
  logUnappliedThreadLifecycleEvent(deps.logger, args, outcome);
  if (!isSessionStatusCorrection(args.event)) {
    emitPluginThreadLifecycleOutcome(outcome);
  }
  announceTurnFailed(args, outcome);
  return outcome;
}
