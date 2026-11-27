import {
  isStandaloneBuiltinClearCommand,
  isStandaloneBuiltinCompactCommand,
  type Thread,
} from "@bb/domain";
import {
  getThreadSpawner,
  hasStoredClientRequestEcho,
  isNativeTerminalThread,
} from "@bb/db";
import { ApiError } from "../../errors.js";
import {
  admitNativeTerminalDispatch,
  deliverNativeTerminalPrompt,
  hasHeldNativeTerminalStart,
  queueBehindHeldNativeTerminalStart,
  resolveNativeTerminalSendInput,
  runNativeTerminalAdmittedWork,
} from "./native-terminal-admission.js";
import {
  DeliveredRetryDetected,
  isDeliveredRetry,
  matchesStoredRequestInput,
} from "./delivered-retry.js";
import { resolveMessageSenderThreadId } from "./thread-send.js";
import type {
  SendMessageRequest,
  SendMessageResponse,
} from "@bb/server-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import {
  attemptDispatch,
  type DispatchAttemptArgs,
} from "./dispatch-attempt.js";
import { requireThreadCommandEnvironment } from "./thread-command-environment.js";
import { assertThreadHostAcceptsWork } from "./thread-host-admission.js";
import { runWithTurnTrace } from "../system/turn-trace.js";
import { assertRequestedModelAllowed } from "./child-thread-model.js";
import { assertProviderAcceptsPromptActions } from "../providers/provider-plan-command.js";

interface AcceptThreadSendRequestArgs {
  payload: SendMessageRequest;
  thread: Thread;
  deviceHandoffClientToken?: string;
}

export async function acceptThreadSendRequest(
  deps: LoggedPendingInteractionWorkSessionDeps,
  received: AcceptThreadSendRequestArgs,
): Promise<SendMessageResponse> {
  const { retryOfClientRequestId, ...payloadWithoutRetry } = received.payload;
  const echoed =
    retryOfClientRequestId !== undefined &&
    hasStoredClientRequestEcho(deps.db, {
      threadId: received.thread.id,
      requestId: retryOfClientRequestId,
    });
  if (
    echoed &&
    matchesStoredRequestInput(deps.db, {
      threadId: received.thread.id,
      requestId: retryOfClientRequestId,
      input: received.payload.input,
    })
  ) {
    return { ok: true, delivery: "alreadyDelivered" };
  }
  const args = echoed
    ? { ...received, payload: payloadWithoutRetry }
    : received;
  if (isNativeTerminalThread(deps.db, args.thread.id)) {
    if (args.payload.sendAt !== undefined) {
      throw new ApiError(
        400,
        "invalid_request",
        "sendAt is not supported for native terminal threads",
      );
    }
    if (args.payload.mode === "inbox") {
      throw new ApiError(
        400,
        "invalid_request",
        "mode inbox is not supported for native terminal threads",
      );
    }
    const input = await resolveNativeTerminalSendInput(deps, {
      thread: args.thread,
      input: args.payload.input,
    });
    const message = {
      thread: args.thread,
      input,
      senderThreadId: resolveMessageSenderThreadId(deps, {
        ...(args.payload.senderThreadId !== undefined
          ? { senderThreadId: args.payload.senderThreadId }
          : {}),
        targetThread: args.thread,
      }),
      origin: args.payload.originPluginId === undefined ? null : "plugin",
      originPluginId: args.payload.originPluginId ?? null,
      startedOnBehalfOf: null,
    } as const;
    if (args.thread.status === "pending") {
      if (hasHeldNativeTerminalStart(deps, args.thread)) {
        const held = queueBehindHeldNativeTerminalStart(deps, message);
        return held.kind === "queued"
          ? { ok: true, delivery: "queued", queuedMessage: held.entry }
          : { ok: true, delivery: "sent" };
      }
      const delivered = await runNativeTerminalAdmittedWork(deps, {
        ...message,
        claimed: null,
        sendNow: false,
        systemNotice: null,
        admitted: {
          when: "after-decision",
          run: () =>
            deliverNativeTerminalPrompt(deps, { thread: args.thread, input }),
        },
      });
      return delivered.kind === "queued"
        ? { ok: true, delivery: "queued", queuedMessage: delivered.entry }
        : { ok: true, delivery: "sent" };
    }
    const outcome = await admitNativeTerminalDispatch(deps, {
      ...message,
      claimed: null,
      sendNow: false,
      systemNotice: null,
      admitted: {
        when: "after-decision",
        run: () =>
          deliverNativeTerminalPrompt(deps, { thread: args.thread, input }),
      },
    });
    return outcome.kind === "queued"
      ? { ok: true, delivery: "queued", queuedMessage: outcome.entry }
      : { ok: true, delivery: "sent" };
  }
  await assertRequestedModelAllowed(deps, {
    threadId: args.thread.id,
    childScope: args.thread.parentThreadId
      ? "parent"
      : getThreadSpawner(deps.db, args.thread.id) === null
        ? null
        : "spawner",
    model: args.payload.model,
    providerId: args.thread.providerId,
    sources: args.payload.executionInputSources,
  });
  assertThreadHostAcceptsWork(deps.db, args.thread);
  assertProviderAcceptsPromptActions(deps.providerRegistry, {
    input: args.payload.input,
    providerId: args.thread.providerId,
  });
  const { compactFirst, ...request } = args.payload;
  if (isStandaloneBuiltinClearCommand(request.input)) {
    if (compactFirst) throwInvalidCompactFirst("cannot clear the context");
    if (request.mode === "inbox") {
      throw new ApiError(
        400,
        "invalid_request",
        "mode inbox cannot clear the context",
      );
    }
    const environment = await requireThreadCommandEnvironment(deps, {
      thread: args.thread,
    });
    const outcome = await attemptSendDispatch(deps, {
      thread: args.thread,
      payload: request,
      source: { kind: "operation", environment },
      queuePayload: { kind: "inline" },
      pluginSubmission: null,
      systemNotice: null,
      origin: null,
      originPluginId: null,
      startedOnBehalfOf: null,
      trigger: "user",
    });
    return {
      ok: true,
      delivery:
        outcome.kind === "already-delivered" ? "alreadyDelivered" : "sent",
    };
  }

  if (compactFirst) {
    if (isStandaloneBuiltinCompactCommand(request.input)) {
      throwInvalidCompactFirst("needs a message to send after compacting");
    }
    if (request.sendAt !== undefined) {
      throwInvalidCompactFirst("cannot be scheduled with sendAt");
    }
    if (request.mode === "steer") {
      throwInvalidCompactFirst("cannot steer a turn");
    }
  }
  const payload: SendMessageRequest = compactFirst
    ? { ...request, mode: "queue-if-active", compactFirst }
    : request;

  const outcome = await runWithTurnTrace(
    deps,
    { threadId: args.thread.id },
    () =>
      attemptSendDispatch(deps, {
        thread: args.thread,
        payload,
        source: { kind: "inline" },
        queuePayload: { kind: "inline" },
        pluginSubmission: payload.pluginSubmission ?? null,
        systemNotice: null,
        origin: payload.originPluginId === undefined ? null : "plugin",
        originPluginId: payload.originPluginId ?? null,
        startedOnBehalfOf: null,
        onTurnRequestCreated: (turnRequestId, turnId) =>
          deps.hub.recordDeviceHandoffTurnSubmitter(
            args.deviceHandoffClientToken,
            args.thread.id,
            turnRequestId,
            turnId,
          ),
        trigger: "user",
      }),
  );
  if (outcome.kind === "already-delivered") {
    return { ok: true, delivery: "alreadyDelivered" };
  }
  if (outcome.kind === "dispatched") {
    return {
      ok: true,
      delivery: "sent",
      ...(outcome.messageSequence !== null
        ? { messageSequence: outcome.messageSequence }
        : {}),
      ...(outcome.refusal ? { refusal: outcome.refusal } : {}),
    };
  }
  return {
    ok: true,
    delivery: "queued",
    queuedMessage: outcome.entry,
  };
}

async function attemptSendDispatch(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: DispatchAttemptArgs,
) {
  const { input, retryOfClientRequestId: requestId } = args.payload;
  if (requestId === undefined) return attemptDispatch(deps, args);
  try {
    return await attemptDispatch(deps, {
      ...args,
      source: {
        ...args.source,
        beforeAppendInTransaction: ({ tx }) => {
          if (
            isDeliveredRetry(tx, { threadId: args.thread.id, requestId, input })
          ) {
            throw new DeliveredRetryDetected();
          }
        },
      },
    });
  } catch (error) {
    if (error instanceof DeliveredRetryDetected) {
      return { kind: "already-delivered" } as const;
    }
    throw error;
  }
}

function throwInvalidCompactFirst(reason: string): never {
  throw new ApiError(400, "invalid_request", `compactFirst ${reason}`);
}
