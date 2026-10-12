import {
  consumeNativeTerminalThreadInitialPrompt,
  getEnvironment,
  getNativeTerminalThread,
  getStoredProviderSession,
  getThread,
  listNativeTerminalThreadsWithDisconnectedTerminal,
  recordNativeTerminalThreadSessionId,
  setNativeTerminalThreadTerminal,
  type NativeTerminalThreadRecord,
} from "@bb/db";
import {
  isActiveTerminalSessionStatus,
  pathLooksRuntimeReadable,
  type PromptInput,
  type ProviderNativeTerminal,
} from "@bb/domain";
import type {
  NativeTerminalLaunchSpec,
  NativeTerminalThread,
  OpenNativeTerminalRequest,
  TerminalSession,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { isServerMachineHost } from "../hosts/primary-host.js";
import { storedProjectAttachmentPath } from "../projects/attachments.js";
import { requirePublicThread } from "../lib/entity-lookup.js";
import { resolvePluginProviderEnv } from "../plugins/plugin-agent-contributions.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "./lifecycle-outcome.js";
import {
  decodeTerminalOutputChunks,
  terminalOutputAlreadyShowsText,
  terminalOutputShowsPaste,
  terminalOutputShowsPasteAgain,
  terminalScreenAlreadyShowsText,
} from "./native-terminal-echo.js";
import { createClientTurnRequestId } from "./thread-events.js";
import { interruptActiveThreadsForHost } from "./thread-lifecycle.js";
import { scheduleThreadProvisioningAdvance } from "./thread-provisioning.js";
import type { ThreadProvisioningDeps } from "./thread-provisioning-environment.js";
import {
  createThreadStartup,
  saveThreadProvisionContext,
  type ThreadProvisionEnvironmentIntent,
} from "./thread-startup-store.js";

type ThreadRow = NonNullable<ReturnType<typeof getThread>>;

const NATIVE_TERMINAL_DEFAULT_COLS = 120;
const NATIVE_TERMINAL_DEFAULT_ROWS = 36;

type NativeTerminalDeps = Pick<
  AppDeps,
  "config" | "db" | "logger" | "providerRegistry" | "terminalSessions"
>;

type NativeTerminalReopenDeps = NativeTerminalDeps &
  LoggedPendingInteractionWorkSessionDeps;

type NativeTerminalViewDeps = Pick<
  AppDeps,
  "db" | "providerRegistry" | "terminalSessions"
>;

interface PendingNativeTerminalOpen {
  promise: Promise<NativeTerminalThread>;
  reattachOnly: boolean;
}

const pendingOpens = new Map<string, PendingNativeTerminalOpen>();
const pendingSends = new Map<string, Promise<void>>();
const reattachEpochs = new Map<string, number>();

function currentReattachEpoch(threadId: string): number {
  return reattachEpochs.get(threadId) ?? 0;
}

function bumpReattachEpoch(threadId: string): number {
  const next = currentReattachEpoch(threadId) + 1;
  reattachEpochs.set(threadId, next);
  return next;
}
const NATIVE_REATTACH_POLL_MS = 250;
const NATIVE_REATTACH_SETTLE_MS = 15_000;
const NATIVE_REATTACH_DEADLINE_MS = 45_000;
const NATIVE_REATTACH_RETRY_MS = 2_000;
const NATIVE_TERMINAL_ECHO_POLL_MS = 100;
const NATIVE_TERMINAL_ECHO_TIMEOUT_MS = 5000;
const NATIVE_TERMINAL_ECHO_CONTEXT_BYTES = 64 * 1024;

export interface NativeTerminalProvider {
  displayName: string;
  cli: ProviderNativeTerminal;
}

export function findNativeTerminalProvider(
  deps: Pick<AppDeps, "providerRegistry">,
  providerId: string,
): NativeTerminalProvider | null {
  const registration = deps.providerRegistry.get(providerId);
  if (registration === null || registration.nativeTerminal === null) {
    return null;
  }
  return {
    displayName: registration.info.displayName,
    cli: registration.nativeTerminal,
  };
}

export function requireNativeTerminalProvider(
  deps: Pick<AppDeps, "providerRegistry">,
  providerId: string,
): NativeTerminalProvider {
  const provider = findNativeTerminalProvider(deps, providerId);
  if (provider === null) {
    throw new ApiError(
      400,
      "invalid_request",
      `Provider ${providerId} does not declare a native terminal`,
    );
  }
  return provider;
}

interface NativeTerminalPromptArgs {
  hostId: string | null;
  input: readonly PromptInput[];
  projectId: string;
}

function nativeTerminalAttachmentPath(
  deps: Pick<AppDeps, "config">,
  args: Omit<NativeTerminalPromptArgs, "input"> & { path: string },
): string {
  if (pathLooksRuntimeReadable(args.path)) return args.path;
  if (args.hostId === null || !isServerMachineHost(deps, args.hostId)) {
    throw new ApiError(
      400,
      "invalid_request",
      "This terminal thread runs on another machine, where an uploaded attachment is not available. Put the file on that machine and send its path",
    );
  }
  return storedProjectAttachmentPath(
    deps.config.dataDir,
    args.projectId,
    args.path,
  );
}

export function nativeTerminalPrompt(
  deps: Pick<AppDeps, "config">,
  args: NativeTerminalPromptArgs,
): string | null {
  const attachments: string[] = [];
  const parts: string[] = [];
  for (const entry of args.input) {
    if (entry.type === "text") {
      parts.push(entry.text);
      continue;
    }
    attachments.push(
      entry.type === "image"
        ? entry.url
        : nativeTerminalAttachmentPath(deps, {
            hostId: args.hostId,
            path: entry.path,
            projectId: args.projectId,
          }),
    );
  }
  const text = parts.join("\n\n").trim();
  const prompt = [...attachments, ...(text.length === 0 ? [] : [text])].join(
    "\n",
  );
  return prompt.length === 0 ? null : prompt;
}

export const NATIVE_TERMINAL_ENDED_MESSAGE =
  "The CLI for this thread ended while bb was disconnected from this machine. Open the terminal again to resume the session.";

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function nativeTerminalLaunchCommand(args: {
  executable: string;
  launchArgs: readonly string[];
  reattachOnly: boolean;
  threadId: string;
}): string {
  const executable = [args.executable, ...args.launchArgs.map(shellWord)].join(
    " ",
  );
  const env = `BB_THREAD_ID=${args.threadId}`;
  const wrapper = args.reattachOnly
    ? `"$BB_CLI" thread native-run ${args.threadId} --reattach`
    : `"$BB_CLI" thread native-run ${args.threadId}`;
  const fallback = args.reattachOnly
    ? `printf '%s\\r\\n' '${NATIVE_TERMINAL_ENDED_MESSAGE}';`
    : `${env} exec ${executable};`;
  return [
    `if [ -n "$BB_CLI" ] && ${wrapper} --probe >/dev/null 2>&1; then`,
    `${env} exec ${wrapper};`,
    `else ${fallback} fi`,
  ].join(" ");
}

export function beginNativeTerminalThreadProvisioning(
  deps: ThreadProvisioningDeps & Pick<AppDeps, "config" | "logger">,
  args: {
    environmentIntent: ThreadProvisionEnvironmentIntent;
    input: PromptInput[];
    thread: ThreadRow;
    titleProvided: boolean;
  },
): void {
  const started = deps.db.transaction(
    (tx) => {
      const prepared = applyLoggedThreadLifecycleEventInTransaction(
        { db: tx, logger: deps.logger },
        { event: { type: "run.preparing" }, threadId: args.thread.id },
      );
      if (!prepared.applied) return false;
      saveThreadProvisionContext({
        replace: true,
        db: tx,
        threadId: args.thread.id,
        context: createThreadStartup({
          clientRequestId: createClientTurnRequestId(),
          environmentIntent: args.environmentIntent,
          execution: null,
          fork: null,
          input: args.input,
          seedWithoutRun: true,
          titleProvided: args.titleProvided,
        }),
      });
      return true;
    },
    { behavior: "immediate" },
  );
  if (!started) {
    throw new ApiError(
      409,
      "thread_not_startable",
      "Native terminal thread could not start provisioning",
    );
  }
  scheduleThreadProvisioningAdvance(deps, args.thread.id);
}

function requireNativeTerminalThreadRecord(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): NativeTerminalThreadRecord {
  requirePublicThread(deps.db, threadId);
  const record = getNativeTerminalThread(deps.db, threadId);
  if (record === null) {
    throw new ApiError(
      404,
      "native_terminal_thread_not_found",
      "This thread runs in chat. Switch it to its terminal first with Open in terminal, or `bb thread native <id> --convert`",
    );
  }
  return record;
}

export function readRecordTerminal(
  deps: Pick<AppDeps, "terminalSessions">,
  record: NativeTerminalThreadRecord,
): TerminalSession | null {
  if (record.terminalSessionId === null) return null;
  try {
    return deps.terminalSessions.getTerminal({
      terminalId: record.terminalSessionId,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

function canReturnToChat(
  deps: Pick<AppDeps, "db">,
  record: NativeTerminalThreadRecord,
): boolean {
  const session = getStoredProviderSession(deps.db, record.threadId);
  return (
    session.kind === "owned" &&
    session.providerThreadId === record.nativeSessionId
  );
}

function toNativeTerminalThread(
  deps: Pick<AppDeps, "db" | "providerRegistry" | "terminalSessions">,
  record: NativeTerminalThreadRecord,
  terminal: TerminalSession | null = readRecordTerminal(deps, record),
): NativeTerminalThread {
  return {
    threadId: record.threadId,
    providerId: record.providerId,
    displayName:
      deps.providerRegistry.get(record.providerId)?.info.displayName ??
      record.providerId,
    nativeSessionId: record.nativeSessionId,
    canReturnToChat: canReturnToChat(deps, record),
    terminal,
  };
}

export function findNativeTerminalThreadView(
  deps: NativeTerminalViewDeps,
  threadId: string,
): NativeTerminalThread | null {
  requirePublicThread(deps.db, threadId);
  const record = getNativeTerminalThread(deps.db, threadId);
  return record === null ? null : toNativeTerminalThread(deps, record);
}

export function getNativeTerminalThreadView(
  deps: NativeTerminalViewDeps,
  threadId: string,
): NativeTerminalThread {
  return toNativeTerminalThread(
    deps,
    requireNativeTerminalThreadRecord(deps, threadId),
  );
}

function terminalIsLive(terminal: TerminalSession | null): boolean {
  return (
    terminal !== null &&
    (isActiveTerminalSessionStatus(terminal.status) ||
      terminal.status === "disconnected")
  );
}

async function openNativeTerminalOnce(
  deps: NativeTerminalDeps,
  args: {
    reattachOnly: boolean;
    replaceLiveTerminal: boolean;
    threadId: string;
    request: OpenNativeTerminalRequest;
  },
): Promise<NativeTerminalThread> {
  const record = requireNativeTerminalThreadRecord(deps, args.threadId);
  const existing = readRecordTerminal(deps, record);
  if (
    !args.replaceLiveTerminal &&
    terminalIsLive(existing) &&
    !(args.reattachOnly && existing?.status === "disconnected")
  ) {
    bumpReattachEpoch(args.threadId);
    return toNativeTerminalThread(deps, record);
  }
  const thread = requirePublicThread(deps.db, args.threadId);
  const provider = requireNativeTerminalProvider(deps, record.providerId);
  if (thread.archivedAt !== null) {
    throw new ApiError(
      409,
      "thread_archived",
      "Unarchive the thread before opening its native terminal",
    );
  }
  const environment =
    thread.environmentId === null
      ? null
      : getEnvironment(deps.db, thread.environmentId);
  const providerEnv =
    environment === null
      ? []
      : await resolvePluginProviderEnv({
          providerId: thread.providerId,
          context: {
            threadId: thread.id,
            projectId: thread.projectId,
            hostId: environment.hostId,
          },
        });
  if (args.reattachOnly) {
    const currentThread = getThread(deps.db, args.threadId);
    const currentRecord = getNativeTerminalThread(deps.db, args.threadId);
    const currentTerminal =
      currentRecord === null ? null : readRecordTerminal(deps, currentRecord);
    if (
      currentThread === null ||
      currentThread.archivedAt !== null ||
      currentThread.deletedAt !== null ||
      (currentTerminal?.status !== "disconnected" &&
        !(
          currentTerminal?.status === "exited" &&
          currentTerminal.closeReason === "daemon-disconnect"
        ))
    ) {
      throw new ApiError(
        409,
        "native_terminal_reconnect_stale",
        "The native terminal is no longer eligible for reconnect",
      );
    }
  }
  const terminal = await deps.terminalSessions.createTerminal({
    payload: {
      cols: args.request.cols ?? NATIVE_TERMINAL_DEFAULT_COLS,
      rows: args.request.rows ?? NATIVE_TERMINAL_DEFAULT_ROWS,
      start: {
        mode: "command",
        command: nativeTerminalLaunchCommand({
          executable: provider.cli.executable,
          launchArgs: provider.cli.launchArgs,
          reattachOnly: args.reattachOnly,
          threadId: thread.id,
        }),
      },
      target: { kind: "thread", threadId: thread.id },
      title: provider.displayName,
    },
    extraContributedEnv: providerEnv,
  });
  setNativeTerminalThreadTerminal(deps.db, {
    threadId: thread.id,
    terminalSessionId: terminal.id,
  });
  bumpReattachEpoch(thread.id);
  return toNativeTerminalThread(deps, record, terminal);
}

export async function settlePendingNativeTerminalOpen(
  threadId: string,
): Promise<void> {
  await pendingOpens.get(threadId)?.promise.catch(() => undefined);
}

export function openNativeTerminal(
  deps: NativeTerminalDeps,
  args: { threadId: string; request: OpenNativeTerminalRequest },
): Promise<NativeTerminalThread> {
  return openNativeTerminalDeduplicated(deps, { ...args, reattachOnly: false });
}

function openNativeTerminalDeduplicated(
  deps: NativeTerminalDeps,
  args: {
    reattachOnly: boolean;
    threadId: string;
    request: OpenNativeTerminalRequest;
  },
): Promise<NativeTerminalThread> {
  const pending = pendingOpens.get(args.threadId);
  if (pending !== undefined && (args.reattachOnly || !pending.reattachOnly)) {
    return pending.promise;
  }
  const opening: Promise<NativeTerminalThread> = (
    pending === undefined
      ? openNativeTerminalOnce(deps, { ...args, replaceLiveTerminal: false })
      : pending.promise
          .then(
            () => undefined,
            () => undefined,
          )
          .then(() =>
            openNativeTerminalOnce(deps, {
              ...args,
              replaceLiveTerminal: true,
            }),
          )
  ).finally(() => {
    if (pendingOpens.get(args.threadId)?.promise === opening) {
      pendingOpens.delete(args.threadId);
    }
  });
  pendingOpens.set(args.threadId, {
    promise: opening,
    reattachOnly: args.reattachOnly,
  });
  return opening;
}

export async function openNativeTerminalAfterProvisioning(
  deps: NativeTerminalDeps,
  threadId: string,
): Promise<void> {
  if (getNativeTerminalThread(deps.db, threadId) === null) return;
  try {
    await openNativeTerminal(deps, { threadId, request: {} });
  } catch (error) {
    deps.logger.warn(
      { err: error, threadId },
      "Failed to open native terminal after provisioning",
    );
  }
}

export function listNativeTerminalThreadsAwaitingDaemon(
  deps: Pick<AppDeps, "db">,
  hostId: string,
): string[] {
  return listNativeTerminalThreadsWithDisconnectedTerminal(deps.db, hostId);
}

export function reopenErrorProvesHolderGone(error: unknown): boolean {
  if (error instanceof ApiError) {
    return (
      error.body.code === "terminal_not_found" ||
      error.body.code === "terminal_open_cancelled"
    );
  }
  if (error instanceof Error && "code" in error) {
    return error.code === "ENOENT" || error.code === "ECONNREFUSED";
  }
  return false;
}

const TRANSIENT_REOPEN_ERROR_CODES: ReadonlySet<string> = new Set([
  "host_disconnected",
  "server_moving",
  "terminal_open_timeout",
]);

function reopenErrorIsTransient(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    !reopenErrorProvesHolderGone(error) &&
    (error.status >= 500 || TRANSIENT_REOPEN_ERROR_CODES.has(error.body.code))
  );
}

function interruptThreadWhoseHolderIsGone(
  deps: NativeTerminalReopenDeps,
  args: { hostId: string; threadId: string },
): void {
  deps.logger.info(
    { hostId: args.hostId, threadId: args.threadId },
    "Interrupting a native terminal thread whose CLI could not be reattached",
  );
  interruptActiveThreadsForHost(deps, {
    hostId: args.hostId,
    includeStopping: false,
    onlyThreadIds: new Set([args.threadId]),
    reason: "host-daemon-restarted",
  });
}

function watchReattachedTerminal(
  deps: NativeTerminalReopenDeps,
  args: { hostId: string; terminalId: string; threadId: string },
): void {
  const deadline = Date.now() + NATIVE_REATTACH_SETTLE_MS;
  const check = () => {
    const record = getNativeTerminalThread(deps.db, args.threadId);
    if (record === null || record.terminalSessionId !== args.terminalId) {
      return;
    }
    const terminal = readRecordTerminal(deps, record);
    if (terminal !== null && terminal.status === "exited") {
      interruptThreadWhoseHolderIsGone(deps, args);
      return;
    }
    if (Date.now() >= deadline) return;
    setTimeout(check, NATIVE_REATTACH_POLL_MS).unref();
  };
  setTimeout(check, NATIVE_REATTACH_POLL_MS).unref();
}

export function reopenNativeTerminalsAfterDaemonReconnect(
  deps: NativeTerminalReopenDeps,
  args: { hostId: string; threadIds: readonly string[] },
): Promise<void> {
  return Promise.all(
    args.threadIds.map(async (threadId) => {
      const attempt = bumpReattachEpoch(threadId);
      const stillWaiting = () => {
        if (currentReattachEpoch(threadId) !== attempt) return false;
        const current = getNativeTerminalThread(deps.db, threadId);
        if (current === null) return false;
        const terminal = readRecordTerminal(deps, current);
        return (
          terminal === null || !isActiveTerminalSessionStatus(terminal.status)
        );
      };
      let expired = false;
      let leaveToDeadline = false;
      const deadline = setTimeout(() => {
        expired = true;
        if (!stillWaiting()) return;
        interruptThreadWhoseHolderIsGone(deps, {
          hostId: args.hostId,
          threadId,
        });
      }, NATIVE_REATTACH_DEADLINE_MS);
      deadline.unref();
      try {
        const record = getNativeTerminalThread(deps.db, threadId);
        if (record === null) return;
        await deps.providerRegistry.whenProviderRegistered(record.providerId);
        if (deps.providerRegistry.get(record.providerId) === null) {
          await new Promise<void>((resolve) => {
            const unsubscribe = deps.providerRegistry.onProviderRegistered(
              record.providerId,
              () => {
                unsubscribe();
                resolve();
              },
            );
          });
        }
        const thread = getThread(deps.db, threadId);
        const currentRecord = getNativeTerminalThread(deps.db, threadId);
        const currentTerminal =
          currentRecord === null
            ? null
            : readRecordTerminal(deps, currentRecord);
        if (
          thread === null ||
          thread.archivedAt !== null ||
          thread.deletedAt !== null ||
          (currentTerminal?.status !== "disconnected" &&
            !(
              currentTerminal?.status === "exited" &&
              currentTerminal.closeReason === "daemon-disconnect"
            ))
        ) {
          return;
        }
        let reopened: NativeTerminalThread;
        for (;;) {
          try {
            reopened = await openNativeTerminalDeduplicated(deps, {
              reattachOnly: true,
              threadId,
              request: {},
            });
            break;
          } catch (error: unknown) {
            if (!reopenErrorIsTransient(error) || expired || !stillWaiting()) {
              throw error;
            }
            deps.logger.warn(
              { err: error, hostId: args.hostId, threadId },
              "Retrying the native terminal reattach after a transient failure",
            );
            await new Promise<void>((resolve) => {
              setTimeout(resolve, NATIVE_REATTACH_RETRY_MS).unref();
            });
          }
        }
        deps.logger.info(
          { hostId: args.hostId, terminalId: reopened.terminal?.id, threadId },
          "Reopened native terminal after the host daemon reconnected",
        );
        if (reopened.terminal !== null) {
          watchReattachedTerminal(deps, {
            hostId: args.hostId,
            terminalId: reopened.terminal.id,
            threadId,
          });
        }
      } catch (error: unknown) {
        deps.logger.warn(
          { err: error, hostId: args.hostId, threadId },
          "Failed to reopen native terminal after the host daemon reconnected",
        );
        if (!reopenErrorProvesHolderGone(error)) {
          leaveToDeadline = true;
        } else if (stillWaiting()) {
          interruptThreadWhoseHolderIsGone(deps, {
            hostId: args.hostId,
            threadId,
          });
        }
      } finally {
        if (!leaveToDeadline) clearTimeout(deadline);
      }
    }),
  ).then(() => undefined);
}

export function takeNativeTerminalLaunchSpec(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  threadId: string,
): NativeTerminalLaunchSpec {
  const record = requireNativeTerminalThreadRecord(deps, threadId);
  const provider = requireNativeTerminalProvider(deps, record.providerId);
  return {
    threadId: record.threadId,
    cli: provider.cli,
    nativeSessionId: record.nativeSessionId,
    initialPrompt: consumeNativeTerminalThreadInitialPrompt(deps.db, threadId),
    model: record.model,
  };
}

export function recordNativeTerminalSession(
  deps: NativeTerminalViewDeps,
  args: { threadId: string; nativeSessionId: string },
): NativeTerminalThread {
  requireNativeTerminalThreadRecord(deps, args.threadId);
  const result = recordNativeTerminalThreadSessionId(deps.db, args);
  switch (result.kind) {
    case "recorded":
    case "unchanged":
      break;
    case "already-bound":
      throw new ApiError(
        409,
        "native_session_already_bound",
        `Thread is already bound to native session ${result.nativeSessionId}`,
      );
    case "claimed-by-other-thread":
      throw new ApiError(
        409,
        "native_session_claimed",
        `Native session belongs to thread ${result.threadId}`,
      );
  }
  return getNativeTerminalThreadView(deps, args.threadId);
}

export function sendNativeTerminalMessage(
  deps: NativeTerminalDeps,
  args: { threadId: string; text: string },
): Promise<TerminalSession> {
  const previous = pendingSends.get(args.threadId) ?? Promise.resolve();
  const sending = previous.then(() => deliverNativeTerminalMessage(deps, args));
  const settled = sending.then(
    () => undefined,
    () => undefined,
  );
  pendingSends.set(args.threadId, settled);
  void settled.then(() => {
    if (pendingSends.get(args.threadId) === settled) {
      pendingSends.delete(args.threadId);
    }
  });
  return sending;
}

function nativeTerminalNotRunning(): ApiError {
  return new ApiError(
    409,
    "native_terminal_not_running",
    "The native session is not running; open it before sending a message",
  );
}

async function deliverNativeTerminalMessage(
  deps: NativeTerminalDeps,
  args: { threadId: string; text: string },
): Promise<TerminalSession> {
  const view = getNativeTerminalThreadView(deps, args.threadId);
  if (view.terminal === null || view.terminal.status !== "running") {
    throw nativeTerminalNotRunning();
  }
  const terminalId = view.terminal.id;
  const provider = requireNativeTerminalProvider(deps, view.providerId);
  const before = await deps.terminalSessions.readTerminalOutput({
    terminalId,
    query: { tailBytes: NATIVE_TERMINAL_ECHO_CONTEXT_BYTES },
  });
  if (before.status !== "running") throw nativeTerminalNotRunning();
  const shown = decodeTerminalOutputChunks(before.chunks);
  if (
    terminalScreenAlreadyShowsText({
      output: shown,
      screenRows: view.terminal.rows,
      text: args.text,
    })
  ) {
    throw new ApiError(
      409,
      "native_terminal_input_ambiguous",
      `${provider.displayName} already shows this text, so an echo of it could not be told apart from what is on screen, and nothing was sent. Type the message in the terminal, or reword it.`,
    );
  }
  const showsPaste = terminalOutputAlreadyShowsText({
    output: shown,
    text: args.text,
  })
    ? terminalOutputShowsPasteAgain
    : terminalOutputShowsPaste;
  const bracketed = `\u001b[200~${args.text}\u001b[201~`;
  deps.terminalSessions.sendTerminalInput({
    terminalId,
    payload: { dataBase64: Buffer.from(bracketed, "utf8").toString("base64") },
  });
  const deadline = Date.now() + NATIVE_TERMINAL_ECHO_TIMEOUT_MS;
  for (;;) {
    await new Promise((resolve) =>
      setTimeout(resolve, NATIVE_TERMINAL_ECHO_POLL_MS),
    );
    const after = await deps.terminalSessions.readTerminalOutput({
      terminalId,
      query: { sinceSeq: before.nextSeq },
    });
    if (after.status !== "running") throw nativeTerminalNotRunning();
    if (
      showsPaste({
        before: shown,
        output: decodeTerminalOutputChunks(after.chunks),
        pastePlaceholders: provider.cli.pastePlaceholders,
        text: args.text,
      })
    ) {
      break;
    }
    if (Date.now() >= deadline) {
      throw new ApiError(
        409,
        "native_terminal_input_not_shown",
        `${provider.displayName} did not show the message in its input box, so it was not submitted. A menu or dialog is probably open; answer it in the terminal, then send again. If the message is in the input box, press Enter there.`,
      );
    }
  }
  return deps.terminalSessions.sendTerminalInput({
    terminalId,
    payload: { dataBase64: Buffer.from("\r", "utf8").toString("base64") },
  });
}
