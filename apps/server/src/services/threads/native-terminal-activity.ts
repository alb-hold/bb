import { getNativeTerminalThread, getThread } from "@bb/db";
import {
  isNativeTerminalQuestion,
  NATIVE_TERMINAL_QUESTION_REQUEST_PREFIX,
  type Thread,
} from "@bb/domain";
import type {
  NativeTerminalOpenQuestion,
  ReportNativeTerminalActivityRequest,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import {
  buildChildThreadBlockerSummary,
  requestChildThreadNeedsAttentionNotification,
} from "../../internal/interactive-requests.js";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { requirePublicThread } from "../lib/entity-lookup.js";
import { applyLoggedThreadLifecycleEvent } from "./lifecycle-outcome.js";
import { readRecordTerminal } from "./native-terminal-threads.js";
import { generateAndApplyThreadTitle } from "./title-generation.js";

type NativeTerminalActivityDeps = LoggedPendingInteractionWorkSessionDeps &
  Pick<AppDeps, "db" | "hub" | "logger" | "terminalSessions">;

function requireNativeRecord(deps: Pick<AppDeps, "db">, threadId: string) {
  const record = getNativeTerminalThread(deps.db, threadId);
  if (record === null) {
    throw new ApiError(
      404,
      "native_terminal_thread_not_found",
      "This thread is not running in its native terminal",
    );
  }
  return record;
}

const NATIVE_QUESTION_REQUEST_PREFIX = NATIVE_TERMINAL_QUESTION_REQUEST_PREFIX;
const NATIVE_QUESTION_TURN_ID = "native-terminal-turn";
const NATIVE_QUESTION_ANSWERED_REASON = "native-terminal-question-answered";

export function recordNativeTerminalActivity(
  deps: NativeTerminalActivityDeps,
  args: { threadId: string } & ReportNativeTerminalActivityRequest,
): void {
  const thread = requirePublicThread(deps.db, args.threadId);
  const record = requireNativeRecord(deps, args.threadId);
  if (
    args.state !== "idle" &&
    (thread.status === "idle" || thread.status === "error")
  ) {
    applyLoggedThreadLifecycleEvent(deps, {
      event: { type: "run.started" },
      threadId: thread.id,
    });
  }
  if (args.state === "idle") settleNativeTerminalTurn(deps, thread.id);
  reconcileNativeQuestions(deps, {
    nativeSessionId: record.nativeSessionId,
    questions: args.questions ?? [],
    thread,
  });
  if (args.prompt !== undefined) {
    titleNativeThreadFromPrompt(deps, thread.id, args.prompt);
  }
}

export function interruptNativeTerminalQuestions(
  deps: Pick<AppDeps, "pendingInteractions">,
  threadId: string,
  keep: ReadonlySet<string> = new Set(),
): void {
  for (const interaction of deps.pendingInteractions.listPendingThreadInteractions(
    threadId,
  )) {
    if (
      !isNativeTerminalQuestion(interaction) ||
      keep.has(interaction.providerRequestId)
    ) {
      continue;
    }
    deps.pendingInteractions.interruptPendingInteraction({
      interactionId: interaction.id,
      reason: NATIVE_QUESTION_ANSWERED_REASON,
    });
  }
}

function reconcileNativeQuestions(
  deps: NativeTerminalActivityDeps,
  args: {
    nativeSessionId: string | null;
    questions: readonly NativeTerminalOpenQuestion[];
    thread: Thread;
  },
): void {
  const wanted = new Map(
    args.questions.map((question) => [
      `${NATIVE_QUESTION_REQUEST_PREFIX}${question.id}`,
      question,
    ]),
  );
  interruptNativeTerminalQuestions(deps, args.thread.id, new Set(wanted.keys()));
  for (const [providerRequestId, question] of wanted) {
    const registered = deps.pendingInteractions.registerPendingInteraction({
      interaction: {
        threadId: args.thread.id,
        turnId: NATIVE_QUESTION_TURN_ID,
        providerId: args.thread.providerId,
        providerThreadId: args.nativeSessionId ?? args.thread.id,
        providerRequestId,
        payload: {
          kind: "user_question",
          questions: [
            {
              id: providerRequestId,
              prompt: question.prompt,
              multiSelect: false,
              allowFreeText: true,
            },
          ],
        },
      },
    });
    if (registered.outcome === "rejected") {
      deps.logger.warn(
        { reason: registered.reason, threadId: args.thread.id },
        "Native terminal question was not registered",
      );
      continue;
    }
    if (registered.outcome === "created") {
      requestChildThreadNeedsAttentionNotification(deps, {
        blockerSummary: buildChildThreadBlockerSummary(registered.interaction),
        childThreadId: args.thread.id,
      });
    }
  }
}

export function settleNativeTerminalTurn(
  deps: Pick<AppDeps, "db" | "hub" | "logger" | "providerRegistry">,
  threadId: string,
): void {
  if (getThread(deps.db, threadId)?.status !== "active") return;
  applyLoggedThreadLifecycleEvent(deps, {
    event: { type: "run.succeeded" },
    threadId,
  });
}

function titleNativeThreadFromPrompt(
  deps: NativeTerminalActivityDeps,
  threadId: string,
  prompt: string,
): void {
  void generateAndApplyThreadTitle(deps, {
    input: [{ type: "text", text: prompt, mentions: [] }],
    threadId,
  }).catch((error: unknown) => {
    deps.logger.warn(
      { err: error, threadId },
      "Native terminal thread title generation failed",
    );
  });
}

export function interruptNativeTerminalTurn(
  deps: Pick<AppDeps, "db" | "terminalSessions">,
  threadId: string,
): void {
  const record = requireNativeRecord(deps, threadId);
  const terminal = readRecordTerminal(deps, record);
  if (terminal === null || terminal.status !== "running") {
    throw new ApiError(
      409,
      "native_terminal_not_running",
      "The native session is not running, so there is no turn to stop",
    );
  }
  deps.terminalSessions.sendTerminalInput({
    terminalId: terminal.id,
    payload: { dataBase64: Buffer.from("\u001b", "utf8").toString("base64") },
  });
}
