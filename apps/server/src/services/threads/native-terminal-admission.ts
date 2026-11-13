import {
  acquireProjectAttachmentOwnership,
  deleteClaimedQueuedThreadMessageBatchInTransaction,
  getEnvironment,
  getNativeTerminalThread,
  type ClaimedQueuedThreadMessageRow,
  type DbTransaction,
} from "@bb/db";
import {
  flattenPromptInputGroups,
  projectAttachmentPaths,
  type PromptInput,
  type ResolvedThreadExecutionOptions,
  type StartedOnBehalfOf,
  type Thread,
  type ThreadCreateOrigin,
  type ThreadQueuedMessage,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { requirePublicProject } from "../lib/entity-lookup.js";
import { resolvePromptAttachmentReferences } from "../projects/attachments.js";
import {
  intendedThreadEnvironmentIntent,
  intendedThreadHostId,
} from "./dispatch-attempt.js";
import { resolveDispatchAuthor } from "./dispatch-author.js";
import {
  dispatchExecutionSources,
  dispatchWaitReasonForPass,
  hasMessageDispatchHooks,
  noteDispatchRequeued,
  runMessageDispatchHookPass,
} from "./dispatch-hooks.js";
import {
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
  admitted: NativeTerminalAdmittedWork;
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

export async function admitNativeTerminalDispatch(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: NativeTerminalAdmissionArgs,
): Promise<NativeTerminalAdmissionOutcome> {
  if (args.sendNow || holdsCapacity(args.thread) || !hasMessageDispatchHooks()) {
    await runAdmittedWork(args.admitted);
    return { kind: "dispatched" };
  }
  assertThreadHostAcceptsWork(deps.db, args.thread);
  const author = resolveDispatchAuthor({
    retrying: false,
    senderThreadId: args.senderThreadId,
    startedOnBehalfOf: args.startedOnBehalfOf,
  });
  const model = getNativeTerminalThread(deps.db, args.thread.id)?.model ?? null;
  const admittedWithinDecision = args.admitted;
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
    ...(admittedWithinDecision.when === "within-decision"
      ? { continueAfterHooks: async () => admittedWithinDecision.run() }
      : {}),
  });
  if (outcome.kind === "proceed") {
    if (args.admitted.when === "after-decision") await args.admitted.run();
    return { kind: "dispatched" };
  }
  if (args.claimed !== null) {
    noteDispatchRequeued(args.thread.id);
  }
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
      systemNotice: null,
      deliveryMode: "queue",
    },
    waitingOn: {
      kind: "plugin",
      pluginId: outcome.waiter.pluginId,
      reason: dispatchWaitReasonForPass(outcome),
    },
    sendAt: outcome.waiter.sendAt,
    claimed: args.claimed,
  });
  return entry === null ? { kind: "dispatched" } : { kind: "queued", entry };
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
  args: { thread: Thread; input: readonly PromptInput[] },
): Promise<void> {
  const requestText = args.input.every((entry) => entry.type === "text")
    ? args.input
        .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
        .join("\n\n")
    : undefined;
  await sendNativeTerminalMessage(deps, {
    ...(requestText === undefined ? {} : { requestText }),
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
  return admitNativeTerminalDispatch(deps, {
    thread: args.thread,
    input,
    claimed: args.claimed,
    sendNow: args.sendNow,
    senderThreadId: lead.senderThreadId,
    origin: lead.origin,
    originPluginId: lead.originPluginId,
    startedOnBehalfOf: storedQueuedThreadMessageRequestedBy(lead),
    admitted: {
      when: "after-decision",
      run: async () => {
        await deliverNativeTerminalPrompt(deps, { thread: args.thread, input });
        deps.db.transaction(consumeClaimedRows, { behavior: "immediate" });
        settleClaimedRows();
      },
    },
  });
}
