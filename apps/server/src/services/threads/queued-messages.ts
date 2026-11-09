import {
  claimNextQueuedThreadMessageGroup,
  listDeferredQueuedMessageDispatchRetryIds,
  claimQueuedThreadMessageGroup,
  createQueuedThreadMessageInTransaction,
  deleteClaimedQueuedThreadMessageBatchInTransaction,
  getEnvironment,
  getHost,
  getQueuedThreadMessage,
  getStoredProviderSession,
  getThread,
  getThreadSpawner,
  holdQueuedThreadMessageForEdit,
  isOrdinaryTurnEndQueuedMessage,
  isThreadQueueAutoSendPaused,
  releaseQueuedMessageClaim,
  releaseQueuedThreadMessageEditHold,
  releaseStaleQueuedMessageClaims,
  type DbQueryConnection,
  type QueuedThreadMessageExecution,
  type QueuedThreadMessageGroupClaimPolicy,
  type QueuedThreadMessageGroupEligibility,
} from "@bb/db";
import {
  flattenPromptInputGroups,
  isQueuedMessageFailedState,
  queuedMessageSystemNoticeSchema,
} from "@bb/domain";
import type {
  QueuedMessageDeliveryMode,
  QueuedMessageWaitingOn,
  Thread,
  ThreadQueuedMessage,
} from "@bb/domain";
import type {
  CreateQueuedMessageRequest,
  QueuedMessageEditHoldResponse,
  SendMessageRequest,
  SendQueuedMessageMode,
  UpdateQueuedMessageRequest,
} from "@bb/server-contract";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { ApiError } from "../../errors.js";
import { isCommandTimeoutError } from "../lib/error-log-fields.js";
import { assertNotNativeTerminalThread } from "./native-terminal-guard.js";
import {
  parseStoredQueuedThreadMessageWaitingOn,
  storedQueuedThreadMessageRequestedBy,
  toThreadQueuedMessage,
} from "./thread-queued-messages.js";
import { buildExecutionOptions } from "./thread-commands.js";
import {
  getActiveTurnId,
  isActiveTurnMainRunIdle,
  isManualCompactionActive,
} from "./thread-events.js";
import {
  applyPreparedThreadModelOverrideRecovery,
  prepareThreadModelOverrideRecovery,
} from "./thread-execution-override.js";
import { attemptDispatch, threadTargetHostId } from "./dispatch-attempt.js";
import {
  deliverParentSystemMessage,
  ParentSystemMessageCompactionActiveError,
} from "./parent-system-messages.js";
import {
  createQueuedMessageClaimLostError,
  QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE,
  QUEUED_MESSAGE_CLAIM_LOST_CODE,
  settleQueueRowDispatched,
} from "./queue-waits.js";
import { recordQueuedMessageDrainFailure } from "./queue-drain-failure.js";
import {
  captureUserMessageSentTelemetry,
  ensureThreadQueueIsWritable,
  resolveMessageSenderThreadId,
} from "./thread-send.js";
import {
  goneThreadEnvironmentDetails,
  threadEnvironmentUnavailableDetails,
  throwThreadEnvironmentUnavailable,
} from "../lib/lifecycle-api-errors.js";
import { resolvePromptAttachmentReferences } from "../projects/attachments.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import { assertThreadHostAcceptsWork } from "./thread-host-admission.js";
import { ThreadContextClearInProgressError } from "./thread-context-mutation-guard.js";

interface SendQueuedMessageArgs {
  claimPolicy: QueuedThreadMessageGroupClaimPolicy;
  mode: SendQueuedMessageMode;
  queuedMessageId: string;
  threadId: string;
  onTurnRequestCreated?: (requestId: string, turnId?: string) => void;
}

type ClaimedQueuedMessage = Exclude<
  ReturnType<typeof claimQueuedThreadMessageGroup>,
  null
>[number];

interface SendClaimedQueuedMessageArgs {
  mode: SendQueuedMessageMode;
  queuedMessages: ClaimedQueuedMessage[];
  sendNow: boolean;
  threadId: string;
  onTurnRequestCreated?: (requestId: string, turnId?: string) => void;
}

interface SendClaimedQueuedMessageForThreadArgs {
  mode: SendQueuedMessageMode;
  queuedMessages: ClaimedQueuedMessage[];
  sendNow: boolean;
  thread: Thread;
  onTurnRequestCreated?: (requestId: string, turnId?: string) => void;
}

export function createAutomaticQueuedMessageGroupEligibility(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { now: number; retryingFailure: boolean; thread: Thread },
): QueuedThreadMessageGroupEligibility {
  const activeTurnId = getActiveTurnId(deps, args.thread.id);
  const deferredRetryIds = listDeferredQueuedMessageDispatchRetryIds(deps.db, {
    now: args.now,
    threadId: args.thread.id,
  });
  return (group) =>
    group.every((member) => {
      if (deferredRetryIds.has(member.id) && !args.retryingFailure) {
        return false;
      }
      if (isQueuedMessageFailedState(member.state) && !args.retryingFailure)
        return false;
      const waitingOn = parseStoredQueuedThreadMessageWaitingOn(member);
      switch (waitingOn?.kind) {
        case undefined:
        case "plugin":
          return true;
        case "time":
          return member.sendAt !== null && member.sendAt <= args.now;
        case "thread-busy":
          return (
            args.thread.status === "idle" ||
            args.thread.status === "pending" ||
            isActiveTurnMainRunIdle(deps, args.thread)
          );
        case "stopping":
          return (
            args.thread.status === "idle" || args.thread.status === "pending"
          );
        case "turn-starting":
          return (
            args.thread.status === "idle" ||
            (args.thread.status === "active" && activeTurnId !== null)
          );
        case "host-offline": {
          const environment =
            args.thread.environmentId === null
              ? null
              : getEnvironment(deps.db, args.thread.environmentId);
          const host =
            environment === null ? null : getHost(deps.db, environment.hostId);
          return (
            host !== null &&
            host.destroyedAt === null &&
            host.phase === "active" &&
            deps.hub.hasDaemonForHost(host.id)
          );
        }
        case "provisioning":
        case "interaction":
          return false;
        case "workspace-busy":
          return (
            args.thread.status === "idle" || args.thread.status === "pending"
          );
      }
    });
}

export interface CreateQueuedMessageForThreadArgs {
  payload: CreateQueuedMessageRequest;
  thread: Thread;
}

function admitQueuedMessage(
  db: DbQueryConnection,
  thread: Thread,
): { hasProviderSession: boolean } {
  ensureThreadQueueIsWritable(thread);
  const hasProviderSession =
    getStoredProviderSession(db, thread.id).kind !== "none";
  if (thread.environmentId === null) {
    if (hasProviderSession) {
      throwThreadEnvironmentUnavailable(
        threadEnvironmentUnavailableDetails("never_attached", null),
      );
    }
    return { hasProviderSession };
  }
  const environment = getEnvironment(db, thread.environmentId);
  assertThreadHostAcceptsWork(db, thread);
  const goneDetails = environment
    ? goneThreadEnvironmentDetails(environment)
    : null;
  if (goneDetails) {
    throwThreadEnvironmentUnavailable(goneDetails);
  }
  return { hasProviderSession };
}

export async function createQueuedMessageForThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: CreateQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage> {
  const { payload, thread } = args;
  await deps.providerRegistry.whenRegistrationsSettled();
  ensureThreadQueueIsWritable(thread);
  assertNotNativeTerminalThread(deps.db, thread.id);
  const input = await resolvePromptAttachmentReferences({
    db: deps.db,
    dataDir: deps.config.dataDir,
    input: payload.input,
    projectId: thread.projectId,
    hostId: threadTargetHostId(deps, thread),
  });
  const execution = await buildExecutionOptions(deps, payload, {
    threadId: thread.id,
  });
  await deps.providerRegistry.whenRegistrationsSettled();
  const usesChildModelPolicy =
    (thread.parentThreadId !== null ||
      getThreadSpawner(deps.db, thread.id) !== null) &&
    deps.providerRegistry.get(thread.providerId)?.childThreadModel != null;
  const senderThreadId = resolveMessageSenderThreadId(deps, {
    senderThreadId: payload.senderThreadId,
    targetThread: thread,
  });
  let overrideRecovery = null;
  if (usesChildModelPolicy && senderThreadId === null) {
    try {
      overrideRecovery = await prepareThreadModelOverrideRecovery(deps, {
        model: payload.model,
        modelSource:
          payload.executionInputSources === undefined
            ? "explicit"
            : payload.executionInputSources.model,
        reasoningLevel: execution.reasoningLevel,
        reasoningLevelSource:
          payload.executionInputSources === undefined
            ? "explicit"
            : payload.executionInputSources.reasoningLevel,
        thread,
      });
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.status !== 503 ||
        error.body.code !== "model_catalog_unavailable"
      ) {
        throw error;
      }
    }
  }
  const { currentThread, hasProviderSession, queuedMessage } =
    deps.db.transaction(
      (tx) => {
        const currentThread = getThread(tx, thread.id);
        if (!currentThread) {
          throw new ApiError(404, "thread_not_found", "Thread not found");
        }
        if (currentThread.parentThreadId !== thread.parentThreadId) {
          throw new ApiError(
            409,
            "thread_scope_changed",
            "Thread scope changed while this queued request was being prepared. Retry the request.",
          );
        }
        applyPreparedThreadModelOverrideRecovery(
          tx,
          deps.providerRegistry,
          currentThread,
          overrideRecovery,
        );
        const { hasProviderSession } = admitQueuedMessage(tx, currentThread);
        const queuedMessage = createQueuedThreadMessageInTransaction(tx, {
          threadId: thread.id,
          content: input,
          senderThreadId,
          model: execution.model,
          reasoningLevel: execution.reasoningLevel,
          permissionMode: execution.permissionMode,
          serviceTier: execution.serviceTier,
          waitingOn:
            currentThread.status === "stopping" ||
            isThreadQueueAutoSendPaused(tx, thread.id)
              ? { kind: "stopping" }
              : { kind: "thread-busy" },
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
          deliveryMode: "queue",
        });
        return { currentThread, hasProviderSession, queuedMessage };
      },
      { behavior: "immediate" },
    );
  deps.hub.notifyThread(thread.id, ["queue-changed"]);
  if (senderThreadId === null && payload.input.length > 0) {
    captureUserMessageSentTelemetry(deps, {
      isChildThread: thread.parentThreadId !== null,
      messageSource: "queued_message",
      providerId: thread.providerId,
      initiator: "user",
    });
  }
  if (
    (currentThread.status === "idle" && hasProviderSession) ||
    isActiveTurnMainRunIdle(deps, currentThread)
  ) {
    requestQueuedMessageDispatch(deps, {
      kind: "thread-ready",
      threadId: thread.id,
    });
  }
  return toThreadQueuedMessage(queuedMessage);
}

export interface ResolveQueuedMessageExecutionChangeArgs {
  expectedUpdatedAt: number;
  queuedMessageId: string;
  request: Pick<
    UpdateQueuedMessageRequest,
    "model" | "permissionMode" | "reasoningLevel" | "serviceTier"
  >;
  thread: Thread;
}

export async function resolveQueuedMessageExecutionChange(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: ResolveQueuedMessageExecutionChangeArgs,
): Promise<QueuedThreadMessageExecution | null> {
  const { request } = args;
  if (
    request.model === undefined &&
    request.permissionMode === undefined &&
    request.reasoningLevel === undefined &&
    request.serviceTier === undefined
  ) {
    return null;
  }
  const row = getQueuedThreadMessage(deps.db, args.queuedMessageId);
  if (
    row === null ||
    row.threadId !== args.thread.id ||
    row.state === "claimed" ||
    row.updatedAt !== args.expectedUpdatedAt
  ) {
    return null;
  }
  const current = toThreadQueuedMessage(row);
  const resolved = await buildExecutionOptions(
    deps,
    {
      model: request.model ?? current.model,
      permissionMode: request.permissionMode ?? current.permissionMode,
      reasoningLevel: request.reasoningLevel ?? current.reasoningLevel,
      serviceTier: request.serviceTier ?? current.serviceTier,
    },
    { threadId: args.thread.id },
  );
  return {
    model: resolved.model,
    permissionMode: resolved.permissionMode,
    reasoningLevel: resolved.reasoningLevel,
    serviceTier: resolved.serviceTier,
  };
}

function isQueuedMessageAutoSendCandidate(
  thread: Thread | null,
): thread is Thread {
  return (
    thread !== null &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.status !== "stopping"
  );
}

const STALE_QUEUED_MESSAGE_CLAIM_MS = 5 * 60 * 1000;
const QUEUED_MESSAGE_EDIT_HOLD_LEASE_MS = 2 * 60 * 1000;
const activeQueuedMessageClaimTokens = new Set<string>();

function respectsManualStopPause(
  args: SendClaimedQueuedMessageForThreadArgs,
): boolean {
  return (
    args.mode === "auto" &&
    !args.sendNow &&
    args.queuedMessages.some(isOrdinaryTurnEndQueuedMessage)
  );
}

function sendModeForDeliveryMode(
  group: readonly { deliveryMode: QueuedMessageDeliveryMode }[],
): SendMessageRequest["mode"] {
  return group.some((row) => row.deliveryMode === "queue")
    ? "queue-if-active"
    : "auto";
}

function sendQueuedMessagePayload(
  queuedMessage: ThreadQueuedMessage,
  mode: SendMessageRequest["mode"],
  senderThreadId: string | null,
): SendMessageRequest {
  return {
    input: queuedMessage.content,
    mode,
    model: queuedMessage.model,
    permissionMode: queuedMessage.permissionMode,
    reasoningLevel: queuedMessage.reasoningLevel,
    serviceTier: queuedMessage.serviceTier,
    ...(senderThreadId !== null ? { senderThreadId } : {}),
  };
}

function releaseQueuedMessageClaims(
  deps: Pick<AppDeps, "db" | "hub">,
  queuedMessages: readonly ClaimedQueuedMessage[],
): void {
  for (const queuedMessage of queuedMessages) {
    releaseQueuedMessageClaim(deps.db, deps.hub, {
      id: queuedMessage.id,
      claimToken: queuedMessage.claimToken,
    });
  }
}

async function withActiveQueuedMessageClaims<T>(
  queuedMessages: readonly ClaimedQueuedMessage[],
  task: () => Promise<T>,
): Promise<T> {
  for (const queuedMessage of queuedMessages) {
    activeQueuedMessageClaimTokens.add(queuedMessage.claimToken);
  }
  try {
    return await task();
  } finally {
    for (const queuedMessage of queuedMessages) {
      activeQueuedMessageClaimTokens.delete(queuedMessage.claimToken);
    }
  }
}

function claimQueuedThreadMessageForSend(
  deps: Pick<AppDeps, "db" | "hub">,
  args: SendQueuedMessageArgs,
): ClaimedQueuedMessage[] {
  const existingQueuedMessage = getQueuedThreadMessage(
    deps.db,
    args.queuedMessageId,
  );
  if (
    !existingQueuedMessage ||
    existingQueuedMessage.threadId !== args.threadId
  ) {
    throw new ApiError(404, "invalid_request", "Queued message not found");
  }

  const claimedQueuedMessages = claimQueuedThreadMessageGroup(
    deps.db,
    deps.hub,
    args.queuedMessageId,
    args.claimPolicy,
  );
  if (claimedQueuedMessages) {
    return claimedQueuedMessages;
  }
  if (args.claimPolicy.kind === "automatic") return [];

  const latestQueuedMessage = getQueuedThreadMessage(
    deps.db,
    args.queuedMessageId,
  );
  if (!latestQueuedMessage || latestQueuedMessage.threadId !== args.threadId) {
    throw new ApiError(404, "invalid_request", "Queued message not found");
  }
  throw new ApiError(
    409,
    "invalid_request",
    "Queued message is already being sent",
  );
}

export function isQueuedMessageClaimLostError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.body.code === QUEUED_MESSAGE_CLAIM_LOST_CODE
  );
}

export function isQueuedMessageAutoSendPausedError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.body.code === QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE
  );
}

async function sendClaimedQueuedMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageArgs,
): Promise<ThreadQueuedMessage> {
  const thread = getThread(deps.db, args.threadId);
  if (!thread) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  return sendClaimedQueuedMessageForThread(deps, {
    mode: args.mode,
    queuedMessages: args.queuedMessages,
    sendNow: args.sendNow,
    thread,
    onTurnRequestCreated: args.onTurnRequestCreated,
  });
}

async function sendClaimedSystemNotice(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage | null> {
  const lead = args.queuedMessages[0]!;
  if (lead.systemNotice === null) {
    return null;
  }
  const notice = queuedMessageSystemNoticeSchema.parse(
    JSON.parse(lead.systemNotice),
  );
  const queuedMessage = toThreadQueuedMessage(lead);
  const delivered = await deliverParentSystemMessage(deps, {
    input: queuedMessage.content,
    parentThread: args.thread,
    systemMessageKind: notice.kind,
    systemMessageSubject: notice.subject,
  });
  if (!delivered) {
    throw createQueuedMessageClaimLostError();
  }
  const consumed = deps.db.transaction(
    (tx) =>
      deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
        queuedMessages: args.queuedMessages,
      }),
    { behavior: "immediate" },
  );
  if (!consumed) {
    throw createQueuedMessageClaimLostError();
  }
  settleQueueRowDispatched({ row: lead });
  return queuedMessage;
}

async function sendClaimedQueuedMessageForThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage> {
  const notice = await sendClaimedSystemNotice(deps, args);
  if (notice) {
    return notice;
  }
  const queuedMessages = args.queuedMessages.map(toThreadQueuedMessage);
  const queuedMessage = queuedMessages[0]!;
  const inputGroups = queuedMessages.map(
    (queuedMessage) => queuedMessage.content,
  );
  const input = flattenPromptInputGroups(inputGroups);
  const lead = args.queuedMessages[0]!;
  const outcome = await attemptDispatch(deps, {
    thread: args.thread,
    payload: {
      ...sendQueuedMessagePayload(
        { ...queuedMessage, content: input },
        args.mode === "auto" && !args.sendNow
          ? sendModeForDeliveryMode(args.queuedMessages)
          : args.mode,
        lead.senderThreadId,
      ),
      ...(inputGroups.length > 1 ? { inputGroups } : {}),
    },
    source: {
      kind: "drain",
      claimed: args.queuedMessages,
      respectManualStopPause: respectsManualStopPause(args),
      sendNow: args.sendNow,
    },
    queuePayload: queuedMessage.payload,
    pluginSubmission: null,
    ...(queuedMessage.payload.kind === "retry"
      ? {
          retryOf: {
            requestId: queuedMessage.payload.retryOfTurnRequestId,
            attempt: queuedMessage.payload.attempt,
          },
        }
      : {}),
    origin: lead.origin,
    originPluginId: lead.originPluginId,
    startedOnBehalfOf: storedQueuedThreadMessageRequestedBy(lead),
    onTurnRequestCreated: args.onTurnRequestCreated,
    trigger: "auto-dispatch",
  });
  if (
    args.sendNow &&
    args.mode !== "steer" &&
    outcome.kind === "queued" &&
    outcome.entry.waitingOn?.kind !== "stopping"
  ) {
    throw new ApiError(
      409,
      "queued_message_still_waiting",
      `This message cannot be sent yet: ${describeCoreWait(outcome.entry.waitingOn)}.`,
    );
  }
  return queuedMessage;
}

function describeCoreWait(waitingOn: QueuedMessageWaitingOn | null): string {
  switch (waitingOn?.kind) {
    case "provisioning":
      return "the thread's workspace is still being prepared";
    case "host-offline":
      return `the "${waitingOn.hostName}" host is not ready`;
    case "interaction":
      return "the thread is waiting for you to answer a pending interaction";
    case "turn-starting":
      return "the current turn is still starting";
    case "stopping":
      return "the thread is still stopping";
    case "plugin":
      return `it is waiting on the "${waitingOn.pluginId}" plugin`;
    case "workspace-busy":
      return `thread ${waitingOn.holderThreadId} is using the shared workspace`;
    case "time":
    case "thread-busy":
    case undefined:
      return "the thread is already running a turn";
  }
}

export async function sendQueuedMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendQueuedMessageArgs,
): Promise<ThreadQueuedMessage> {
  const sendNow = args.claimPolicy.kind === "explicit-send";
  const queuedMessages = claimQueuedThreadMessageForSend(deps, args);
  if (queuedMessages.length === 0) {
    const existing = getQueuedThreadMessage(deps.db, args.queuedMessageId);
    if (!existing)
      throw new ApiError(404, "invalid_request", "Queued message not found");
    return toThreadQueuedMessage(existing);
  }
  const thread = getThread(deps.db, args.threadId);
  if (
    thread &&
    (isManualCompactionActive(deps, thread) ||
      (args.mode === "auto" &&
        !sendNow &&
        queuedMessages.some(isOrdinaryTurnEndQueuedMessage) &&
        isThreadQueueAutoSendPaused(deps.db, thread.id)))
  ) {
    releaseQueuedMessageClaims(deps, queuedMessages);
    return toThreadQueuedMessage(queuedMessages[0]!);
  }
  try {
    return await withActiveQueuedMessageClaims(queuedMessages, () =>
      sendClaimedQueuedMessage(deps, {
        mode: args.mode,
        queuedMessages,
        sendNow,
        threadId: args.threadId,
        onTurnRequestCreated: args.onTurnRequestCreated,
      }),
    );
  } catch (error) {
    releaseQueuedMessageClaims(deps, queuedMessages);
    if (
      isQueuedMessageAutoSendPausedError(error) ||
      error instanceof ThreadContextClearInProgressError ||
      error instanceof ParentSystemMessageCompactionActiveError
    ) {
      return toThreadQueuedMessage(queuedMessages[0]!);
    }
    throw error;
  }
}

export async function sendQueuedMessageNow(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    mode: SendQueuedMessageMode;
    queuedMessageId: string;
    threadId: string;
    onTurnRequestCreated?: (requestId: string, turnId?: string) => void;
  },
): Promise<
  | { delivery: "sent" }
  | { delivery: "queued"; queuedMessage: ThreadQueuedMessage }
> {
  await sendQueuedMessage(deps, {
    claimPolicy: { kind: "explicit-send" },
    mode: args.mode,
    queuedMessageId: args.queuedMessageId,
    threadId: args.threadId,
    onTurnRequestCreated: args.onTurnRequestCreated,
  });
  const remainingQueuedMessage = getQueuedThreadMessage(
    deps.db,
    args.queuedMessageId,
  );
  return remainingQueuedMessage
    ? {
        delivery: "queued",
        queuedMessage: toThreadQueuedMessage(remainingQueuedMessage),
      }
    : { delivery: "sent" };
}

export async function sendNextQueuedMessageIfPresent(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { threadId: string },
): Promise<boolean> {
  const initialThread = getThread(deps.db, args.threadId);
  if (!isQueuedMessageAutoSendCandidate(initialThread)) {
    return false;
  }

  const nextQueuedMessages = claimNextQueuedThreadMessageGroup(
    deps.db,
    deps.hub,
    args.threadId,
    createAutomaticQueuedMessageGroupEligibility(deps, {
      now: Date.now(),
      retryingFailure: false,
      thread: initialThread,
    }),
  );
  if (!nextQueuedMessages) {
    return false;
  }

  const thread = getThread(deps.db, args.threadId);
  if (
    !isQueuedMessageAutoSendCandidate(thread) ||
    isManualCompactionActive(deps, thread)
  ) {
    releaseQueuedMessageClaims(deps, nextQueuedMessages);
    return false;
  }

  try {
    await withActiveQueuedMessageClaims(nextQueuedMessages, () =>
      sendClaimedQueuedMessageForThread(deps, {
        mode: "auto",
        queuedMessages: nextQueuedMessages,
        sendNow: false,
        thread,
      }),
    );
  } catch (error) {
    releaseQueuedMessageClaims(deps, nextQueuedMessages);
    if (
      isQueuedMessageClaimLostError(error) ||
      isQueuedMessageAutoSendPausedError(error) ||
      error instanceof ThreadContextClearInProgressError ||
      error instanceof ParentSystemMessageCompactionActiveError
    ) {
      return false;
    }
    if (!isCommandTimeoutError(error)) {
      recordQueuedMessageDrainFailure(deps, {
        error,
        now: Date.now(),
        row: nextQueuedMessages[0]!,
        thread,
      });
    }
    throw error;
  }
  return true;
}

export function releaseStaleQueuedMessageDispatchClaims(
  deps: Pick<AppDeps, "db" | "hub">,
  now: number,
): void {
  releaseStaleQueuedMessageClaims(deps.db, deps.hub, {
    claimedBefore: now - STALE_QUEUED_MESSAGE_CLAIM_MS,
    protectedClaimTokens: [...activeQueuedMessageClaimTokens],
  });
}

export function releaseOrphanedQueuedMessageDispatchClaims(
  deps: Pick<AppDeps, "db" | "hub">,
): number {
  return releaseStaleQueuedMessageClaims(deps.db, deps.hub, {
    claimedBefore: null,
    protectedClaimTokens: [...activeQueuedMessageClaimTokens],
  });
}
interface QueuedMessageEditHoldArgs {
  queuedMessageId: string;
  threadId: string;
}

export function holdQueuedMessageForEdit(
  deps: Pick<AppDeps, "db">,
  args: QueuedMessageEditHoldArgs,
): QueuedMessageEditHoldResponse {
  const result = holdQueuedThreadMessageForEdit(deps.db, {
    heldUntil: Date.now() + QUEUED_MESSAGE_EDIT_HOLD_LEASE_MS,
    id: args.queuedMessageId,
    threadId: args.threadId,
  });
  switch (result.kind) {
    case "not_found":
      throw new ApiError(404, "invalid_request", "Queued message not found");
    case "claimed":
      throw new ApiError(
        409,
        "invalid_request",
        "Queued message is already being sent",
      );
    case "held":
      return { leaseMs: QUEUED_MESSAGE_EDIT_HOLD_LEASE_MS };
  }
}

export function requestEditReleasedQueuedMessageDispatch(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueuedMessageEditHoldArgs,
): void {
  requestQueuedMessageDispatch(deps, {
    kind: "edit-released",
    queuedMessageId: args.queuedMessageId,
    threadId: args.threadId,
  });
}

export function releaseQueuedMessageEditHold(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueuedMessageEditHoldArgs,
): void {
  if (
    releaseQueuedThreadMessageEditHold(deps.db, {
      id: args.queuedMessageId,
      threadId: args.threadId,
    })
  ) {
    requestEditReleasedQueuedMessageDispatch(deps, args);
  }
}
