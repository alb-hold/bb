import { Buffer } from "node:buffer";
import {
  getEnvironment,
  getNativeTerminalThread,
  getThread,
  listStoredEventRows,
  stampNativeTerminalTranscriptEvidence,
} from "@bb/db";
import {
  NATIVE_TERMINAL_ACTIVITY_FRESH_FOR_MS,
  classifyNativeTranscriptRecord,
} from "@bb/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { callHostOnlineRpcForWork } from "../hosts/online-rpc.js";
import { applyLoggedThreadLifecycleEvent } from "./lifecycle-outcome.js";
import { getActiveTurnId } from "./thread-events.js";

type NativeThreadStatusDeps = LoggedPendingInteractionWorkSessionDeps;

const nativeStatusReads = new WeakMap<object, Map<string, number>>();
const NATIVE_STATUS_READ_CACHE_MS = 4_000;
const NATIVE_STATUS_CACHE_LIMIT = 512;

function nativeStatusReadStates(deps: NativeThreadStatusDeps) {
  let states = nativeStatusReads.get(deps.hub);
  if (states === undefined) {
    states = new Map<string, number>();
    nativeStatusReads.set(deps.hub, states);
  }
  return states;
}

export async function reconcileNativeThreadStatus(
  deps: NativeThreadStatusDeps,
  threadId: string,
): Promise<void> {
  const thread = getThread(deps.db, threadId);
  if (
    thread === null ||
    (thread.status !== "active" && thread.status !== "idle")
  )
    return;
  const native = getNativeTerminalThread(deps.db, threadId);
  if (native === null || native.providerId !== thread.providerId) return;
  const now = Date.now();
  if (
    native.lastEvidenceAt !== null &&
    now >= native.lastEvidenceAt &&
    now - native.lastEvidenceAt <= NATIVE_TERMINAL_ACTIVITY_FRESH_FOR_MS
  )
    return;
  const states = nativeStatusReadStates(deps);
  const cachedAt = states.get(threadId);
  if (cachedAt !== undefined && now - cachedAt < NATIVE_STATUS_READ_CACHE_MS)
    return;
  if (states.size >= NATIVE_STATUS_CACHE_LIMIT) {
    const oldestThreadId = states.keys().next().value;
    if (oldestThreadId !== undefined) states.delete(oldestThreadId);
  }
  states.set(threadId, now);
  let state: "idle" | "working" | null = null;
  const nativeTerminal = deps.providerRegistry.get(
    thread.providerId,
  )?.nativeTerminal;
  const session = nativeTerminal?.session;
  const transcript = nativeTerminal?.activity?.transcript;
  if (
    nativeTerminal != null &&
    native.nativeSessionId !== null &&
    session?.kind === "assigned" &&
    transcript !== undefined
  ) {
    const environment =
      thread.environmentId === null
        ? null
        : getEnvironment(deps.db, thread.environmentId);
    if (environment !== null && environment.path !== null) {
      try {
        const result = await callHostOnlineRpcForWork(deps, {
          hostId: environment.hostId,
          command: {
            type: "native_terminal.read_transcript_tail",
            sessionId: native.nativeSessionId,
            sessionRoot: nativeTerminal.sessionRoot,
            transcriptPattern: session.transcript,
            cwd: environment.path,
          },
          timeoutMs: 2_000,
        });
        states.set(threadId, Date.now());
        if (result.outcome === "available") {
          const content = Buffer.from(result.contentBase64, "base64").toString(
            "utf8",
          );
          const records = content.split("\n").filter((line) => line.length > 0);
          for (let index = records.length - 1; index >= 0; index -= 1) {
            try {
              state = classifyNativeTranscriptRecord(
                transcript,
                JSON.parse(records[index]),
              );
            } catch {
              continue;
            }
            if (state !== null) break;
          }
          if (state !== null) {
            stampNativeTerminalTranscriptEvidence(deps.db, {
              at: now,
              nativeSessionId: native.nativeSessionId,
              threadId,
            });
          }
        }
      } catch (error) {
        states.set(threadId, Date.now());
        deps.logger.debug(
          { threadId, error },
          "Native status transcript lookup failed",
        );
      }
    }
  }
  if (
    state === null &&
    thread.status === "active" &&
    native.nativeSessionId !== null &&
    native.initialPrompt === null &&
    getActiveTurnId({ db: deps.db }, threadId) === null &&
    listStoredEventRows(deps.db, {
      threadId,
      types: ["turn/started", "client/turn/requested"],
      limit: 1,
    }).length === 0
  ) {
    state = "idle";
  }
  if (state === null || (state === "working") === (thread.status === "active"))
    return;
  applyLoggedThreadLifecycleEvent(deps, {
    event: { type: state === "idle" ? "run.succeeded" : "run.started" },
    threadId,
  });
}
