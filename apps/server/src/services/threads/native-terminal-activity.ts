import { getNativeTerminalThread, getThread } from "@bb/db";
import type { ReportNativeTerminalActivityRequest } from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { requirePublicThread } from "../lib/entity-lookup.js";
import { applyLoggedThreadLifecycleEvent } from "./lifecycle-outcome.js";
import { readRecordTerminal } from "./native-terminal-threads.js";
import {
  applyGeneratedThreadTitle,
  generateThreadMetadataWithOutcome,
} from "./title-generation.js";

type NativeTerminalActivityDeps = LoggedPendingInteractionWorkSessionDeps &
  Pick<AppDeps, "db" | "hub" | "logger" | "terminalSessions">;

const titlesInFlight = new Set<string>();

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

export function recordNativeTerminalActivity(
  deps: NativeTerminalActivityDeps,
  args: { threadId: string } & ReportNativeTerminalActivityRequest,
): void {
  const thread = requirePublicThread(deps.db, args.threadId);
  requireNativeRecord(deps, args.threadId);
  if (
    args.state === "working" &&
    (thread.status === "idle" || thread.status === "error")
  ) {
    applyLoggedThreadLifecycleEvent(deps, {
      event: { type: "run.started" },
      threadId: thread.id,
    });
  }
  if (args.state === "idle") settleNativeTerminalTurn(deps, thread.id);
  if (args.prompt !== undefined) {
    titleNativeThreadFromPrompt(deps, thread.id, args.prompt);
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
  if (getThread(deps.db, threadId)?.title != null) return;
  if (titlesInFlight.has(threadId)) return;
  titlesInFlight.add(threadId);
  void generateThreadMetadataWithOutcome(deps, {
    input: [{ type: "text", text: prompt, mentions: [] }],
    threadId,
  })
    .then((outcome) => {
      const title = outcome.metadata?.title;
      if (title) applyGeneratedThreadTitle(deps, { threadId, title });
    })
    .catch((error: unknown) => {
      deps.logger.warn(
        { err: error, threadId },
        "Native terminal thread title generation failed",
      );
    })
    .finally(() => {
      titlesInFlight.delete(threadId);
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
