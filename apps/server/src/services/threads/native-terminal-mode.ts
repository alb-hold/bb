import {
  createNativeTerminalThread,
  deleteNativeTerminalThread,
  findNativeTerminalThreadBySession,
  getEnvironment,
  getNativeTerminalThread,
} from "@bb/db";
import { isActiveTerminalSessionStatus } from "@bb/domain";
import type {
  NativeTerminalMode,
  NativeTerminalThread,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { requirePublicThread } from "../lib/entity-lookup.js";
import {
  findNativeTerminalProvider,
  openNativeTerminal,
  readRecordTerminal,
  settlePendingNativeTerminalOpen,
} from "./native-terminal-threads.js";
import { settleNativeTerminalTurn } from "./native-terminal-activity.js";
import { requireDispatchableProviderThreadId } from "./thread-events.js";
import { stopThreadForCurrentState } from "./thread-lifecycle.js";

type NativeTerminalModeDeps = LoggedPendingInteractionWorkSessionDeps &
  Pick<
    AppDeps,
    "config" | "db" | "logger" | "providerRegistry" | "terminalSessions"
  >;

const pendingSwitches = new Map<string, Promise<unknown>>();
const CLOSE_ATTEMPTS = 3;

export function switchNativeTerminalMode(
  deps: NativeTerminalModeDeps,
  args: { threadId: string; mode: NativeTerminalMode },
): Promise<NativeTerminalThread | null> {
  const previous = pendingSwitches.get(args.threadId) ?? Promise.resolve();
  const switching = previous.then(() =>
    args.mode === "terminal"
      ? enterTerminalMode(deps, args.threadId)
      : leaveTerminalMode(deps, args.threadId),
  );
  const settled = switching.catch(() => undefined);
  pendingSwitches.set(args.threadId, settled);
  void settled.then(() => {
    if (pendingSwitches.get(args.threadId) === settled) {
      pendingSwitches.delete(args.threadId);
    }
  });
  return switching;
}

async function enterTerminalMode(
  deps: NativeTerminalModeDeps,
  threadId: string,
): Promise<NativeTerminalThread> {
  const thread = requirePublicThread(deps.db, threadId);
  if (getNativeTerminalThread(deps.db, threadId) !== null) {
    return openNativeTerminal(deps, { threadId, request: {} });
  }
  if (thread.archivedAt !== null) {
    throw new ApiError(
      409,
      "thread_archived",
      "Unarchive the thread before switching it to its terminal",
    );
  }
  const displayName =
    deps.providerRegistry.get(thread.providerId)?.info.displayName ??
    thread.providerId;
  if (findNativeTerminalProvider(deps, thread.providerId) === null) {
    throw new ApiError(
      409,
      "native_terminal_unsupported",
      `${displayName} has no terminal CLI that bb can run, so this thread stays in chat`,
    );
  }
  const environment =
    thread.environmentId === null
      ? null
      : getEnvironment(deps.db, thread.environmentId);
  if (environment === null) {
    throw new ApiError(
      409,
      "native_terminal_no_session",
      "This thread has no workspace yet, so there is no session to open in the terminal",
    );
  }
  const nativeSessionId = requireDispatchableProviderThreadId(deps, threadId);
  if (nativeSessionId === null) {
    throw new ApiError(
      409,
      "native_terminal_no_session",
      `This thread has no ${displayName} session yet. Send it a message first, or start a new native terminal thread.`,
    );
  }
  const owner = findNativeTerminalThreadBySession(deps.db, {
    providerId: thread.providerId,
    nativeSessionId,
  });
  if (owner !== null) {
    throw new ApiError(
      409,
      "native_session_claimed",
      `Native session belongs to thread ${owner.threadId}`,
    );
  }
  createNativeTerminalThread(deps.db, {
    threadId,
    providerId: thread.providerId,
    nativeSessionId,
    initialPrompt: null,
    model: null,
  });
  try {
    await stopThreadForCurrentState(deps, thread, environment, {
      requireStopped: true,
    });
  } catch (error) {
    deleteNativeTerminalThread(deps.db, threadId);
    throw error;
  }
  return openNativeTerminal(deps, { threadId, request: {} });
}

async function leaveTerminalMode(
  deps: NativeTerminalModeDeps,
  threadId: string,
): Promise<null> {
  requirePublicThread(deps.db, threadId);
  const record = getNativeTerminalThread(deps.db, threadId);
  if (record === null) return null;
  const chatSessionId = requireDispatchableProviderThreadId(deps, threadId);
  if (chatSessionId === null || chatSessionId !== record.nativeSessionId) {
    throw new ApiError(
      409,
      "native_terminal_no_chat_session",
      "This thread started in the terminal, so it has no chat session to return to",
    );
  }
  for (let attempt = 0; attempt < CLOSE_ATTEMPTS; attempt += 1) {
    await settlePendingNativeTerminalOpen(threadId);
    const current = getNativeTerminalThread(deps.db, threadId);
    if (current === null) return null;
    const terminal = readRecordTerminal(deps, current);
    if (
      terminal === null ||
      !(
        isActiveTerminalSessionStatus(terminal.status) ||
        terminal.status === "disconnected"
      )
    ) {
      deleteNativeTerminalThread(deps.db, threadId);
      settleNativeTerminalTurn(deps, threadId);
      return null;
    }
    await deps.terminalSessions.closeTerminal({
      terminalId: terminal.id,
      payload: { mode: "force", reason: "user" },
    });
  }
  throw new ApiError(
    409,
    "native_terminal_still_running",
    "The terminal kept reopening while switching back to chat; close it and try again",
  );
}
