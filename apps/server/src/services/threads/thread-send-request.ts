import {
  isStandaloneBuiltinClearCommand,
  isStandaloneBuiltinCompactCommand,
  projectAttachmentPaths,
  type Thread,
} from "@bb/domain";
import {
  acquireProjectAttachmentOwnership,
  getEnvironment,
  getThreadSpawner,
  isNativeTerminalThread,
} from "@bb/db";
import { ApiError } from "../../errors.js";
import { resolvePromptAttachmentReferences } from "../projects/attachments.js";
import {
  nativeTerminalPromptParts,
  sendNativeTerminalMessage,
} from "./native-terminal-threads.js";
import type {
  SendMessageRequest,
  SendMessageResponse,
} from "@bb/server-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { attemptDispatch } from "./dispatch-attempt.js";
import { requireThreadCommandEnvironment } from "./thread-command-environment.js";
import { sendThreadMessage } from "./thread-send.js";
import { assertThreadHostAcceptsWork } from "./thread-host-admission.js";
import { runWithTurnTrace } from "../system/turn-trace.js";
import { assertRequestedModelAllowed } from "./child-thread-model.js";

interface AcceptThreadSendRequestArgs {
  payload: SendMessageRequest;
  thread: Thread;
  deviceHandoffClientToken?: string;
}

export async function acceptThreadSendRequest(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AcceptThreadSendRequestArgs,
): Promise<SendMessageResponse> {
  if (isNativeTerminalThread(deps.db, args.thread.id)) {
    if (args.payload.sendAt !== undefined) {
      throw new ApiError(
        400,
        "invalid_request",
        "sendAt is not supported for native terminal threads",
      );
    }
    const hostId =
      args.thread.environmentId === null
        ? null
        : (getEnvironment(deps.db, args.thread.environmentId)?.hostId ?? null);
    const input = await resolvePromptAttachmentReferences({
      db: deps.db,
      dataDir: deps.config.dataDir,
      input: args.payload.input,
      projectId: args.thread.projectId,
      hostId,
    });
    const pastes = nativeTerminalPromptParts(deps, {
      hostId,
      input,
      projectId: args.thread.projectId,
    });
    acquireProjectAttachmentOwnership(
      deps.db,
      args.thread.id,
      projectAttachmentPaths(input),
    );
    if (pastes.length === 0) {
      throw new ApiError(400, "invalid_request", "Message text is empty");
    }
    await sendNativeTerminalMessage(deps, {
      threadId: args.thread.id,
      pastes,
    });
    return { ok: true, delivery: "sent" };
  }
  await assertRequestedModelAllowed(deps, {
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
  const { compactFirst, ...request } = args.payload;
  if (isStandaloneBuiltinClearCommand(request.input)) {
    if (compactFirst) throwInvalidCompactFirst("cannot clear the context");
    const environment = await requireThreadCommandEnvironment(deps, {
      thread: args.thread,
    });
    await sendThreadMessage(deps, {
      environment,
      payload: request,
      thread: args.thread,
      trigger: "user",
    });
    return { ok: true, delivery: "sent" };
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
      attemptDispatch(deps, {
        thread: args.thread,
        payload,
        source: { kind: "inline" },
        queuePayload: { kind: "inline" },
        pluginSubmission: payload.pluginSubmission ?? null,
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
  if (outcome.kind === "dispatched") {
    return {
      ok: true,
      delivery: "sent",
      ...(outcome.refusal ? { refusal: outcome.refusal } : {}),
    };
  }
  return {
    ok: true,
    delivery: "queued",
    queuedMessage: outcome.entry,
  };
}

function throwInvalidCompactFirst(reason: string): never {
  throw new ApiError(400, "invalid_request", `compactFirst ${reason}`);
}
