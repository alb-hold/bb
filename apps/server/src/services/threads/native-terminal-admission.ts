import {
  acquireProjectAttachmentOwnership,
  clearNativeTerminalDeliveryMarks,
  deleteClaimedQueuedThreadMessageBatchInTransaction,
  getEnvironment,
  getNativeTerminalThread,
  getThread,
  listNativeTerminalDeliveryMarks,
  listQueuedThreadMessages,
  markNativeTerminalDeliveriesSubmitting,
  recordNativeParentNoticeDelivery,
  type ClaimedQueuedThreadMessageRow,
  type DbTransaction,
} from "@bb/db";
import {
  flattenPromptInputGroups,
  projectAttachmentPaths,
  type PromptInput,
  type QueuedMessageSystemNotice,
  type QueuedMessageWaitingOn,
  type ResolvedThreadExecutionOptions,
  type StartedOnBehalfOf,
  type Thread,
  type ThreadCreateOrigin,
  type ThreadQueuedMessage,
} from "@bb/domain";
import { ApiError, TerminalInputInterruptedError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { requirePublicProject } from "../lib/entity-lookup.js";
import { resolvePromptAttachmentReferences } from "../projects/attachments.js";
import {
  intendedThreadEnvironmentIntent,
  intendedThreadHostId,
  readPendingThreadStartContext,
} from "./dispatch-attempt.js";
import { resolveDispatchAuthor } from "./dispatch-author.js";
import {
  dispatchExecutionSources,
  dispatchWaitReasonForPass,
  hasMessageDispatchHooks,
  noteDispatchRequeued,
  runMessageDispatchHookPass,
} from "./dispatch-hooks.js";
import { settleUncertainNativeTerminalDeliveries } from "./native-terminal-delivery-marks.js";
import {
  beginNativeTerminalThreadProvisioning,
  nativeTerminalPromptParts,
  sendNativeTerminalMessage,
} from "./native-terminal-threads.js";
import {
  createQueuedMessageClaimLostError,
  recordQueuedMessageWait,
  settleQueueRowDispatched,
} from "./queue-waits.js";
import { buildProviderThreadExecutionDefaults } from "./thread-default-policy.js";
import { assertThreadHostAcceptsWork } from "./thread-host-admission.js";
import {
  parseStoredQueuedThreadMessageWaitingOn,
  storedQueuedThreadMessageRequestedBy,
  toThreadQueuedMessage,
} from "./thread-queued-messages.js";
import { toThreadResponseFromThread } from "./thread-runtime-display.js";

export type NativeTerminalAdmissionOutcome =
  | { kind: "dispatched" }
  | { kind: "queued"; entry: ThreadQueuedMessage };

export type NativeTerminalAdmittedWork =
  | { when: "within-decision"; run: () => void }
  | { when: "after-decision"; run: () => Promise<void> };

export interface NativeTerminalAdmissionArgs {
  thread: Thread;
  input: PromptInput[];
  claimed: ClaimedQueuedThreadMessageRow[] | null;
  sendNow: boolean;
  senderThreadId: string | null;
  origin: ThreadCreateOrigin | null;
  originPluginId: string | null;
  startedOnBehalfOf: StartedOnBehalfOf | null;
  systemNotice: QueuedMessageSystemNotice | null;
  admitted: NativeTerminalAdmittedWork;
}

export const NATIVE_TERMINAL_PARENT_NOTICE: QueuedMessageSystemNotice = {
  kind: "unlabeled",
  subject: null,
};

export function nativeTerminalStartTicketInput(): PromptInput[] {
  return [
    {
      type: "text",
      text: "Start the terminal session",
      mentions: [],
      visibility: "agent-only",
    },
  ];
}

function isNativeTerminalStartTicket(input: readonly PromptInput[]): boolean {
  return (
    input.length > 0 &&
    input.every(
      (entry) => entry.type === "text" && entry.visibility === "agent-only",
    )
  );
}

function holdsCapacity(thread: Thread): boolean {
  return thread.status === "active" || thread.status === "starting";
}

async function runAdmittedWork(work: NativeTerminalAdmittedWork) {
  if (work.when === "within-decision") {
    work.run();
    return;
  }
  await work.run();
}

function nativeTerminalQueuedExecution(
  deps: LoggedPendingInteractionWorkSessionDeps,
  thread: Thread,
  model: string | null,
): ResolvedThreadExecutionOptions {
  const defaults = buildProviderThreadExecutionDefaults(deps.providerRegistry, {
    providerId: thread.providerId,
    model: model ?? thread.providerId,
  });
  return {
    model: defaults.model,
    permissionMode: defaults.permissionMode,
    reasoningLevel: defaults.reasoningLevel,
    serviceTier: defaults.serviceTier,
    source: "client/turn/requested",
  };
}

function holdForOpenInteraction(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: NativeTerminalAdmissionArgs,
): NativeTerminalAdmissionOutcome | null {
  if (
    args.sendNow ||
    !deps.pendingInteractions.hasTurnBoundPendingThreadInteraction(
      args.thread.id,
    )
  ) {
    return null;
  }
  return recordNativeTerminalWait(deps, {
    ...args,
    waitingOn: { kind: "interaction" },
    sendAt: null,
  });
}

export async function admitNativeTerminalDispatch(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: NativeTerminalAdmissionArgs,
): Promise<NativeTerminalAdmissionOutcome> {
  const heldBeforeDecision = holdForOpenInteraction(deps, args);
  if (heldBeforeDecision !== null) return heldBeforeDecision;
  if (
    args.sendNow ||
    holdsCapacity(args.thread) ||
    !hasMessageDispatchHooks()
  ) {
    await runAdmittedWork(args.admitted);
    return { kind: "dispatched" };
  }
  assertThreadHostAcceptsWork(deps.db, args.thread);
  const author = resolveDispatchAuthor({
    retrying: args.systemNotice !== null,
    senderThreadId: args.senderThreadId,
    startedOnBehalfOf: args.startedOnBehalfOf,
  });
  const model = getNativeTerminalThread(deps.db, args.thread.id)?.model ?? null;
  const admitted = args.admitted;
  let admittedWithinDecision = false;
  const outcome = await runMessageDispatchHookPass(deps, {
    thread: args.thread,
    threadResponse: toThreadResponseFromThread(deps, { thread: args.thread }),
    project: requirePublicProject(deps.db, args.thread.projectId),
    environmentId: args.thread.environmentId,
    intendedHostId:
      args.thread.environmentId !== null
        ? null
        : intendedThreadHostId(deps, args.thread.id),
    environmentIntent: intendedThreadEnvironmentIntent(deps, args.thread),
    input: args.input,
    requestedExecution: {
      providerId: args.thread.providerId,
      model,
      reasoningLevel: null,
      serviceTier: null,
      permissionMode: null,
    },
    executionSources: dispatchExecutionSources({}),
    attempt: "start-turn",
    initiator: author.initiator,
    senderThreadId: author.senderThreadId,
    origin: args.origin,
    originPluginId: args.originPluginId,
    startedOnBehalfOf: args.startedOnBehalfOf,
    parentThreadId: args.thread.parentThreadId,
    queuedMessages: args.claimed?.map(toThreadQueuedMessage) ?? [],
    pluginSubmission: null,
    ...(admitted.when === "within-decision"
      ? {
          continueAfterHooks: async () => {
            admittedWithinDecision = true;
            admitted.run();
          },
        }
      : {}),
  });
  if (outcome.kind === "proceed") {
    if (!admittedWithinDecision) {
      const heldAfterDecision = holdForOpenInteraction(deps, args);
      if (heldAfterDecision !== null) return heldAfterDecision;
      await runAdmittedWork(admitted);
    }
    return { kind: "dispatched" };
  }
  if (args.claimed !== null) {
    noteDispatchRequeued(args.thread.id);
  }
  return recordNativeTerminalWait(deps, {
    ...args,
    waitingOn: {
      kind: "plugin",
      pluginId: outcome.waiter.pluginId,
      reason: dispatchWaitReasonForPass(outcome),
    },
    sendAt: outcome.waiter.sendAt,
  });
}

function recordNativeTerminalWait(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: Omit<NativeTerminalAdmissionArgs, "admitted" | "sendNow"> & {
    waitingOn: QueuedMessageWaitingOn;
    sendAt: number | null;
  },
): NativeTerminalAdmissionOutcome {
  const model = getNativeTerminalThread(deps.db, args.thread.id)?.model ?? null;
  const entry = recordQueuedMessageWait(deps, {
    thread: args.thread,
    message: {
      input: args.input,
      execution: nativeTerminalQueuedExecution(deps, args.thread, model),
      senderThreadId: args.senderThreadId,
      origin: args.origin,
      originPluginId: args.originPluginId,
      requestedBy: args.startedOnBehalfOf,
      payload: { kind: "inline" },
      systemNotice: args.systemNotice,
      deliveryMode: "queue",
    },
    waitingOn: args.waitingOn,
    sendAt: args.sendAt,
    claimed: args.claimed,
  });
  return entry === null ? { kind: "dispatched" } : { kind: "queued", entry };
}

export function hasHeldNativeTerminalStart(
  deps: LoggedPendingInteractionWorkSessionDeps,
  thread: Thread,
): boolean {
  return (
    thread.status === "pending" &&
    listQueuedThreadMessages(deps.db, thread.id).length > 0
  );
}

export function queueBehindHeldNativeTerminalStart(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: Omit<
    NativeTerminalAdmissionArgs,
    "admitted" | "sendNow" | "claimed" | "systemNotice"
  >,
): NativeTerminalAdmissionOutcome {
  return recordNativeTerminalWait(deps, {
    ...args,
    claimed: null,
    systemNotice: null,
    waitingOn: { kind: "provisioning" },
    sendAt: null,
  });
}

function nativeTerminalHostId(
  deps: LoggedPendingInteractionWorkSessionDeps,
  thread: Thread,
): string | null {
  return thread.environmentId === null
    ? null
    : (getEnvironment(deps.db, thread.environmentId)?.hostId ?? null);
}

export async function resolveNativeTerminalSendInput(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { thread: Thread; input: PromptInput[] },
): Promise<PromptInput[]> {
  const input = await resolvePromptAttachmentReferences({
    db: deps.db,
    dataDir: deps.config.dataDir,
    input: args.input,
    projectId: args.thread.projectId,
    hostId: nativeTerminalHostId(deps, args.thread),
  });
  acquireProjectAttachmentOwnership(
    deps.db,
    args.thread.id,
    projectAttachmentPaths(input),
  );
  if (nativeTerminalPastes(deps, { thread: args.thread, input }).length === 0) {
    throw new ApiError(400, "invalid_request", "Message text is empty");
  }
  return input;
}

function nativeTerminalPastes(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { thread: Thread; input: readonly PromptInput[] },
): string[] {
  return nativeTerminalPromptParts(deps, {
    hostId: nativeTerminalHostId(deps, args.thread),
    input: args.input,
    projectId: args.thread.projectId,
  });
}

export async function deliverNativeTerminalPrompt(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    thread: Thread;
    input: readonly PromptInput[];
    requireEmptyInputBox?: boolean;
  },
): Promise<void> {
  const requestText = args.input.every((entry) => entry.type === "text")
    ? args.input
        .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
        .join("\n\n")
    : undefined;
  await sendNativeTerminalMessage(deps, {
    ...(requestText === undefined ? {} : { requestText }),
    ...(args.requireEmptyInputBox === true
      ? { requireEmptyInputBox: true }
      : {}),
    threadId: args.thread.id,
    pastes: nativeTerminalPastes(deps, args),
  });
}

export async function dispatchClaimedNativeTerminalMessages(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    thread: Thread;
    claimed: ClaimedQueuedThreadMessageRow[];
    sendNow: boolean;
  },
): Promise<NativeTerminalAdmissionOutcome> {
  const lead = args.claimed[0]!;
  const input = flattenPromptInputGroups(
    args.claimed.map((row) => toThreadQueuedMessage(row).content),
  );
  const consumeClaimedRows = (tx: DbTransaction) => {
    if (
      !deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
        queuedMessages: args.claimed,
      })
    ) {
      throw createQueuedMessageClaimLostError();
    }
  };
  const settleClaimedRows = () => {
    settleQueueRowDispatched({ row: lead });
    deps.hub.notifyThread(args.thread.id, ["queue-changed"]);
  };
  const systemNotice =
    lead.systemNotice === null ? null : NATIVE_TERMINAL_PARENT_NOTICE;
  const message = {
    thread: args.thread,
    input,
    claimed: args.claimed,
    senderThreadId: lead.senderThreadId,
    origin: lead.origin,
    originPluginId: lead.originPluginId,
    startedOnBehalfOf: storedQueuedThreadMessageRequestedBy(lead),
    systemNotice,
  };
  if (!args.sendNow) {
    const marks = listNativeTerminalDeliveryMarks(
      deps.db,
      args.claimed.map((row) => row.id),
    );
    if (marks.length > 0) {
      const [failed] = await settleUncertainNativeTerminalDeliveries(
        deps,
        marks,
      );
      return {
        kind: "queued",
        entry: toThreadQueuedMessage(failed ?? lead),
      };
    }
  }
  if (
    args.thread.status === "pending" &&
    parseStoredQueuedThreadMessageWaitingOn(lead)?.kind === "provisioning"
  ) {
    return recordNativeTerminalWait(deps, {
      ...message,
      waitingOn: { kind: "provisioning" },
      sendAt: null,
    });
  }
  return admitNativeTerminalDispatch(deps, {
    ...message,
    sendNow: args.sendNow,
    admitted:
      args.thread.status === "pending"
        ? {
            when: "within-decision",
            run: () => {
              const row = getThread(deps.db, args.thread.id);
              if (row === null) {
                throw new ApiError(404, "thread_not_found", "Thread not found");
              }
              const startContext = readPendingThreadStartContext(
                deps,
                args.thread.id,
              );
              if (startContext === null) {
                throw new ApiError(
                  500,
                  "internal_error",
                  `Native terminal thread ${args.thread.id} is pending but has no start context`,
                );
              }
              beginNativeTerminalThreadProvisioning(deps, {
                environmentIntent: startContext.environmentIntent,
                input: isNativeTerminalStartTicket(input) ? [] : input,
                thread: row,
                titleProvided: startContext.titleProvided,
                beforeStartInTransaction: consumeClaimedRows,
              });
              settleClaimedRows();
            },
          }
        : {
            when: "after-decision",
            run: async () => {
              const ids = args.claimed.map((row) => row.id);
              if (!isNativeTerminalStartTicket(input)) {
                if (
                  !markNativeTerminalDeliveriesSubmitting(deps.db, {
                    claimToken: lead.claimToken,
                    now: Date.now(),
                    queuedMessageIds: ids,
                  })
                ) {
                  throw createQueuedMessageClaimLostError();
                }
                try {
                  await deliverNativeTerminalPrompt(deps, {
                    thread: args.thread,
                    input,
                    requireEmptyInputBox: systemNotice !== null,
                  });
                } catch (error) {
                  if (!(error instanceof TerminalInputInterruptedError)) {
                    clearNativeTerminalDeliveryMarks(deps.db, ids);
                  }
                  throw error;
                }
              }
              if (systemNotice !== null) {
                recordNativeParentNoticeDelivery(deps.db, {
                  deliveredAt: Date.now(),
                  parentThreadId: args.thread.id,
                });
              }
              deps.db.transaction(
                (tx) => {
                  consumeClaimedRows(tx);
                  clearNativeTerminalDeliveryMarks(deps.db, ids);
                },
                { behavior: "immediate" },
              );
              settleClaimedRows();
            },
          },
  });
}
