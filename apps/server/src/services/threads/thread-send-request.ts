import {
  isStandaloneBuiltinClearCommand,
  projectAttachmentPaths,
  type Thread,
} from "@bb/domain";
import {
  acquireProjectAttachmentOwnership,
  getEnvironment,
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

interface AcceptThreadSendRequestArgs {
  payload: SendMessageRequest;
  thread: Thread;
}

export async function acceptThreadSendRequest(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AcceptThreadSendRequestArgs,
): Promise<SendMessageResponse> {
  if (isNativeTerminalThread(deps.db, args.thread.id)) {
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
  assertThreadHostAcceptsWork(deps.db, args.thread);
  if (isStandaloneBuiltinClearCommand(args.payload.input)) {
    const environment = await requireThreadCommandEnvironment(deps, {
      thread: args.thread,
    });
    await sendThreadMessage(deps, {
      environment,
      payload: args.payload,
      thread: args.thread,
      trigger: "user",
    });
    return { ok: true, delivery: "sent" };
  }

  const outcome = await runWithTurnTrace(
    deps,
    { threadId: args.thread.id },
    () =>
      attemptDispatch(deps, {
        thread: args.thread,
        payload: args.payload,
        source: { kind: "inline" },
        queuePayload: { kind: "inline" },
        pluginSubmission: args.payload.pluginSubmission ?? null,
        origin: null,
        originPluginId: null,
        startedOnBehalfOf: null,
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
