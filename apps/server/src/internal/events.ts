import { performance } from "node:perf_hooks";
import { Buffer } from "node:buffer";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  appendDaemonEventsInTransaction,
  deriveStoredEventItemFields,
  findLastCompletedRootStoredTurn,
  findLatestUnresolvedClientTurnRequestIdAfterSequence,
  getThread,
  getEnvironment,
  getLatestThreadSequence,
  hasRootStoredTurnStarted,
  isTurnAimedAtByEarlierStop,
  listStoredTurnCompletedKeys,
  listStoredDaemonReplayKeys,
  listThreadEnvironmentAssignmentsOnHost,
  MissingStoredTurnStartedError,
  recordDaemonReplayKeys,
  recordWorkspaceFileChanges,
  upsertThreadExecutionReport,
  events as storedEvents,
} from "@bb/db";
import type {
  AcceptedDaemonEvent,
  AppendDaemonEventInput,
  AppendDaemonEventsResult,
} from "@bb/db";
import {
  hostDaemonEventBatchRequestSchema,
  ungroupHostDaemonEvents,
  typedRoutes,
  type HostDaemonEventBatchResponse,
  type HostDaemonEventEnvelope,
  type HostDaemonInternalSchema,
  type HostDaemonRejectedEvent,
} from "@bb/host-daemon-contract";
import {
  THREAD_SESSION_OPTIONS_STATE_KIND,
  THREAD_PROVIDER_MODEL_CATALOG_STATE_KIND,
  requireThreadEventScopeTurnId,
  getThreadEventScopeTurnId,
  maskResolvedProviderEnvironment,
  threadScope,
  type ClientTurnRequestId,
  type ThreadEventType,
} from "@bb/domain";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import { dropForkUnreadEvents } from "./fork-unread-events.js";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../types.js";
import {
  isActivePruneTriggerThreadEventType,
  maybePruneActiveThreadEventHistory,
  type ActiveThreadEventPruneRuntimeOptions,
} from "../services/system/event-pruning.js";
import {
  executeTurnEndFollowUpBestEffort,
  idleFollowUpForTurnEnd,
  planTurnEnd,
  type TurnEndFollowUp,
} from "../services/threads/turn-end-follow-ups.js";
import type { ThreadLifecycleEffect } from "../services/threads/lifecycle/machine.js";
import {
  runThreadLifecycleTransaction,
  type ThreadLifecycleOutcome,
} from "../services/threads/lifecycle/run.js";
import { finishThreadLifecycle } from "../services/threads/lifecycle/finish.js";
import { deferAfterResponse } from "../services/lib/response-deferral.js";
import { runtimeErrorLogFields } from "../services/lib/error-log-fields.js";
import { dropSettledThreadSessionOptionSelections } from "../services/threads/thread-session-options.js";
import { rememberSessionModelCatalog } from "../services/providers/session-model-catalog.js";
import {
  applyGeneratedThreadTitle,
  sanitizeGeneratedTitle,
} from "../services/threads/title-generation.js";
import {
  getInactiveSessionLogFields,
  requireAuthenticatedDaemonSession,
} from "./session-state.js";
import { getAuthenticatedDaemon } from "./auth.js";
import { validateExtensionPayloads } from "./extension-payloads.js";
import { validatePresentationIcons } from "./presentation-icons.js";
import {
  recordSpendForInsertedEvents,
  type SpendRollupObservationSource,
} from "../services/system/spend-rollup.js";
import { listSharedWorkspaceActiveThreadIds } from "../services/threads/workspace-awareness.js";
import { appendThreadEvent } from "../services/threads/thread-events.js";
import {
  observeStreamTraceEventBatch,
  observeTurnTraceEventBatch,
} from "../services/system/turn-trace.js";

interface ToStoredEventArgs {
  envelope: HostDaemonEventEnvelope;
  environmentId: string | null;
}

interface ResolvePostableEventBatchEntriesArgs {
  hostId: string;
  events: HostDaemonEventEnvelope[];
}

interface PostableEventBatchEntry {
  envelope: HostDaemonEventEnvelope;
  environmentId: string | null;
  eventIndex: number;
}

interface ResolvePostableEventBatchEntriesResult {
  entries: PostableEventBatchEntry[];
  rejectedEvents: HostDaemonEventBatchResponse["rejectedEvents"];
}

interface RejectedDaemonEventSummary {
  count: number;
  threadIds: string[];
}

interface ResolveEventsToApplyArgs {
  db: AppDeps["db"];
  events: HostDaemonEventEnvelope[];
  insertedEventIndexes: number[];
}

interface NotifyInsertedEventThreadsDeps {
  db: AppDeps["db"];
  hub: AppDeps["hub"];
}

interface NotifyInsertedEventThreadsArgs {
  eventInputs: AppendDaemonEventInput[];
  insertedInputIndexes: number[];
}

function preserveTerminalProvisioningStatus(
  deps: Pick<AppDeps, "db">,
  entry: PostableEventBatchEntry,
): PostableEventBatchEntry {
  const event = entry.envelope.event;
  if (event.type !== "system/thread-provisioning") {
    return entry;
  }
  const latest = deps.db
    .select({
      status: sql<unknown>`json_extract(${storedEvents.data}, '$.status')`,
    })
    .from(storedEvents)
    .where(
      and(
        eq(storedEvents.threadId, entry.envelope.threadId),
        eq(storedEvents.type, "system/thread-provisioning"),
        sql`json_extract(${storedEvents.data}, '$.provisioningId') = ${event.provisioningId}`,
      ),
    )
    .orderBy(desc(storedEvents.sequence))
    .limit(1)
    .get();
  const status = latest?.status;
  if (status !== "completed" && status !== "failed" && status !== "cancelled") {
    return entry;
  }
  return {
    ...entry,
    envelope: {
      ...entry.envelope,
      event: { ...event, status },
    },
  };
}

function parseStoredBackgroundTaskItemStatus(data: string): string | undefined {
  const parsed: unknown = JSON.parse(data);
  if (parsed === null || typeof parsed !== "object" || !("item" in parsed)) {
    return undefined;
  }
  const item = parsed.item;
  if (item === null || typeof item !== "object" || !("status" in item)) {
    return undefined;
  }
  return typeof item.status === "string" ? item.status : undefined;
}

function eventInputChangesBackgroundActivity(
  input: AppendDaemonEventInput,
): boolean {
  if (input.itemKind !== "backgroundTask") {
    return false;
  }
  if (
    input.type === "item/started" ||
    input.type === "item/backgroundTask/completed"
  ) {
    return true;
  }
  if (input.type !== "item/backgroundTask/progress") {
    return false;
  }
  try {
    return parseStoredBackgroundTaskItemStatus(input.data) !== "pending";
  } catch {
    return false;
  }
}

interface ShouldApplyEventEffectArgs {
  completedTurnKeyLookup: Set<string>;
  entry: HostDaemonEventEnvelope;
  index: number;
  insertedEventIndexLookup: Set<number>;
}

interface ListCompletedTurnKeysForStartedEventsArgs {
  batchEvents: HostDaemonEventEnvelope[];
  db: AppDeps["db"];
  insertedEventIndexLookup: ReadonlySet<number>;
}

interface TurnKeyArgs {
  threadId: string;
  turnId: string;
}

interface ActivePruneCandidate {
  latestPrunableSequence: number;
  threadId: string;
}

interface ResolveActivePruneCandidatesArgs {
  acceptedEvents: AcceptedDaemonEvent[];
  events: HostDaemonEventEnvelope[];
  insertedEventIndexes: number[];
}

function isRootTurnStartedEvent(
  event: Extract<HostDaemonEventEnvelope["event"], { type: "turn/started" }>,
): boolean {
  return !event.parentToolCallId;
}

function resolveProviderIdentifiers(event: HostDaemonEventEnvelope["event"]): {
  providerThreadId: string | null;
} {
  switch (event.type) {
    case "thread/started":
    case "client/thread/start":
    case "client/turn/requested":
    case "client/turn/rejected":
    case "client/turn/start":
    case "system/error":
    case "system/manager/user_message":
    case "system/thread/interrupted":
    case "system/operation":
    case "system/interaction/lifecycle":
    case "system/permissionGrant/lifecycle":
    case "system/userQuestion/lifecycle":
    case "system/thread-provisioning":
    case "system/provider-turn-watchdog":
      return { providerThreadId: null };
    case "thread/identity":
    case "thread/name/updated":
    case "provider/warning":
    case "provider/modelFallback":
    case "provider/rateLimits/updated":
    case "provider.env-resolved":
    case "thread/compacted":
    case "thread/context/cleared":
    case "thread/goal/updated":
    case "thread/goal/cleared":
    case "thread/extensionState/updated":
    case "turn/started":
    case "turn/completed":
    case "turn/input/accepted":
    case "item/started":
    case "item/completed":
    case "item/backgroundTask/progress":
    case "item/backgroundTask/completed":
    case "item/delegation/progress":
    case "item/delegation/completed":
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "item/plan/delta":
    case "item/mcpToolCall/progress":
    case "item/toolCall/progress":
    case "thread/contextWindowUsage/updated":
    case "thread/tokenUsage/updated":
    case "turn/plan/updated":
    case "turn/diff/updated":
    case "turn/mainRun/updated":
    case "provider/error":
    case "provider/unhandled":
    case "thread/execution/reported":
      return { providerThreadId: event.providerThreadId };
    default: {
      const exhaustive: never = event;
      throw new Error(
        `Unsupported event type: ${String((exhaustive as { type?: string }).type)}`,
      );
    }
  }
}

function toStoredEvent(args: ToStoredEventArgs): AppendDaemonEventInput {
  const envelope = args.envelope;
  const { scope, type, threadId, ...data } = envelope.event;
  return {
    threadId: envelope.threadId,
    environmentId: args.environmentId,
    ...resolveProviderIdentifiers(envelope.event),
    scope,
    type,
    ...deriveStoredEventItemFields(envelope.event),
    data: JSON.stringify(data),
  };
}

function notifyInsertedEventThreads(
  deps: NotifyInsertedEventThreadsDeps,
  args: NotifyInsertedEventThreadsArgs,
): void {
  const eventTypesByThreadId = new Map<string, Set<ThreadEventType>>();
  const backgroundActivityThreadIds = new Set<string>();
  for (const index of args.insertedInputIndexes) {
    const eventInput = args.eventInputs[index];
    if (eventInput) {
      const eventTypes =
        eventTypesByThreadId.get(eventInput.threadId) ??
        new Set<ThreadEventType>();
      eventTypes.add(eventInput.type);
      eventTypesByThreadId.set(eventInput.threadId, eventTypes);
      if (eventInputChangesBackgroundActivity(eventInput)) {
        backgroundActivityThreadIds.add(eventInput.threadId);
      }
    }
  }
  for (const [threadId, eventTypes] of eventTypesByThreadId) {
    deps.hub.notifyThread(threadId, ["events-appended"], {
      ...(backgroundActivityThreadIds.has(threadId)
        ? { backgroundActivityChanged: true }
        : {}),
      eventTypes: Array.from(eventTypes),
      timelineSequence: getLatestThreadSequence(deps.db, { threadId }),
    });
  }
}

async function applyEventEffects(
  deps: LoggedPendingInteractionWorkSessionDeps,
  events: HostDaemonEventEnvelope[],
): Promise<TurnEndFollowUp[]> {
  const followUps: TurnEndFollowUp[] = [];
  const failedParentNotificationThreadIds = new Set<string>();
  for (const entry of events) {
    try {
      const event = entry.event;
      if (event.type === "item/completed" && event.item.type === "fileChange") {
        const thread = getThread(deps.db, entry.threadId);
        const environment = thread?.environmentId
          ? getEnvironment(deps.db, thread.environmentId)
          : null;
        if (
          thread &&
          environment !== null &&
          environment.path !== null &&
          !environment.providerOwnsPath
        ) {
          const notices = recordWorkspaceFileChanges(deps.db, {
            hostId: environment.hostId,
            workspacePath: environment.path,
            filePaths: event.item.changes.map((change) => change.path),
            candidateThreadIds: [
              entry.threadId,
              ...listSharedWorkspaceActiveThreadIds(deps.db, environment),
            ],
          });
          for (const notice of notices) {
            appendThreadEvent(deps, {
              threadId: notice.threadId,
              environmentId: environment.id,
              type: "system/manager/user_message",
              scope: threadScope(),
              data: {
                text: `Workspace collision detected: ${notice.filePath} was also changed by bb thread ${notice.otherThreadId}.`,
              },
            });
          }
        }
      }
      if (event.type === "turn/started") {
        if (!isRootTurnStartedEvent(event)) {
          continue;
        }
        const turnId = requireThreadEventScopeTurnId({
          type: event.type,
          scope: event.scope,
        });
        const outcome = runThreadLifecycleTransaction(deps, entry.threadId, {
          type: "turn.started",
          aimedAtByStop: isTurnAimedAtByEarlierStop(deps.db, {
            threadId: entry.threadId,
            turnId,
          }),
          turnId,
          now: Date.now(),
        });
        await finishLifecycleFromEvents(deps, outcome, followUps);
        continue;
      }

      if (event.type === "turn/input/accepted") {
        const outcome = runThreadLifecycleTransaction(deps, entry.threadId, {
          type: "request.accepted",
          requestId: event.clientRequestId,
        });
        await finishLifecycleFromEvents(deps, outcome, followUps);
        continue;
      }

      if (event.type === "thread/name/updated") {
        if (event.source === "agent") {
          const title = sanitizeGeneratedTitle(event.threadName);
          if (title !== null) {
            applyGeneratedThreadTitle(deps, {
              threadId: entry.threadId,
              title,
            });
          }
        }
        continue;
      }

      if (event.type === "thread/extensionState/updated") {
        if (event.kind === THREAD_PROVIDER_MODEL_CATALOG_STATE_KIND) {
          await rememberSessionModelCatalog(deps, entry);
        }
        if (event.kind === THREAD_SESSION_OPTIONS_STATE_KIND) {
          dropSettledThreadSessionOptionSelections(deps, {
            threadId: entry.threadId,
            environmentId:
              getThread(deps.db, entry.threadId)?.environmentId ?? null,
          });
        }
        continue;
      }

      if (event.type === "turn/mainRun/updated") {
        if (event.state === "idle") {
          followUps.push({
            kind: "queued-message-dispatch",
            wake: { kind: "thread-ready", threadId: entry.threadId },
          });
        }
        continue;
      }

      if (event.type === "turn/completed") {
        const turnId = requireThreadEventScopeTurnId({
          type: event.type,
          scope: event.scope,
        });
        const thread = getThread(deps.db, entry.threadId);
        if (
          thread === null ||
          !hasRootStoredTurnStarted(deps.db, {
            threadId: entry.threadId,
            turnId,
          })
        ) {
          continue;
        }
        const aimedAtByStop = isTurnAimedAtByEarlierStop(deps.db, {
          threadId: entry.threadId,
          turnId,
        });
        if (aimedAtByStop && event.status !== "interrupted") {
          continue;
        }
        const outcome = runThreadLifecycleTransaction(deps, entry.threadId, {
          type: "turn.completed",
          turnId,
          status: event.status,
        });
        const ended = outcome.effects.find(
          (effect) => effect.kind === "turn-ended",
        );
        await finishLifecycleFromEvents(deps, outcome, followUps);
        if (ended === undefined || ended.kind !== "turn-ended") {
          continue;
        }
        const plan = planTurnEnd(deps, {
          aimedAtByStop,
          failedParentNotificationThreadIds,
          status: event.status,
          thread,
          turnId,
        });
        const idle =
          ended.disposition === "applied" && outcome.thread?.status === "idle";
        const idleFollowUp = idle
          ? idleFollowUpForTurnEnd(plan, {
              status: event.status,
              threadId: entry.threadId,
            })
          : null;
        if (
          plan.continuation === null ||
          !(idle || ended.disposition === "held")
        ) {
          followUps.push(...plan.parentNotifications);
        }
        if (idleFollowUp !== null) {
          followUps.push(idleFollowUp);
        }
        continue;
      }

      if (
        event.type === "system/error" &&
        (event.code === "provider_process_exited" ||
          event.code === "provider_turn_start_failed")
      ) {
        if (getThread(deps.db, entry.threadId) === null) {
          continue;
        }
        if (event.code === "provider_process_exited") {
          deps.pendingInteractions.interruptPendingInteractionsForThreadIds({
            threadIds: [entry.threadId],
            reason:
              "Provider process exited while awaiting user interaction; retry the thread to continue",
          });
        }
        const outcome = runThreadLifecycleTransaction(deps, entry.threadId, {
          type: "provider.failed",
          unstartedRequestId:
            event.scope.kind === "thread"
              ? findUnstartedTurnRequestId(deps, entry.threadId)
              : null,
        });
        await finishLifecycleFromEvents(deps, outcome, followUps);
        continue;
      }
    } catch (error) {
      deps.logger.error(
        {
          err: error,
          eventType: entry.event.type,
          threadId: entry.threadId,
        },
        "Failed to apply event side effects",
      );
    }
  }
  return followUps;
}

const EVENT_DEFERRED_LIFECYCLE_EFFECTS: ReadonlySet<
  ThreadLifecycleEffect["kind"]
> = new Set(["drain-queue"]);

async function finishLifecycleFromEvents(
  deps: LoggedPendingInteractionWorkSessionDeps,
  outcome: ThreadLifecycleOutcome,
  followUps: TurnEndFollowUp[],
): Promise<void> {
  for (const effect of outcome.effects) {
    if (effect.kind === "drain-queue") {
      followUps.push({
        kind: "queued-message-dispatch",
        wake: { kind: effect.wake, threadId: outcome.threadId },
      });
    }
  }
  await finishThreadLifecycle(deps, outcome, {
    skip: EVENT_DEFERRED_LIFECYCLE_EFFECTS,
  });
}

function findUnstartedTurnRequestId(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): ClientTurnRequestId | null {
  const lastCompletedTurn = findLastCompletedRootStoredTurn(deps.db, {
    threadId,
  });
  return findLatestUnresolvedClientTurnRequestIdAfterSequence(deps.db, {
    afterSequence: lastCompletedTurn?.completedSequence ?? 0,
    threadId,
  });
}

function deferEventFollowUpBatch(
  deps: LoggedPendingInteractionWorkSessionDeps,
  followUps: TurnEndFollowUp[],
): void {
  if (followUps.length === 0) {
    return;
  }

  deferAfterResponse({
    config: deps.config,
    logger: deps.logger,
    name: "Event follow-up scheduling",
    work: async () => {
      await Promise.all(
        followUps.map((followUp) =>
          executeTurnEndFollowUpBestEffort(deps, followUp),
        ),
      );
    },
  });
}

function toTurnKey(args: TurnKeyArgs): string {
  return `${args.threadId}:${args.turnId}`;
}

function listCompletedTurnKeysForStartedEvents(
  args: ListCompletedTurnKeysForStartedEventsArgs,
): Set<string> {
  const startedTurnKeys: TurnKeyArgs[] = [];

  for (const entry of args.batchEvents) {
    if (entry.event.type !== "turn/started") {
      continue;
    }
    startedTurnKeys.push({
      threadId: entry.threadId,
      turnId: requireThreadEventScopeTurnId({
        type: entry.event.type,
        scope: entry.event.scope,
      }),
    });
  }

  if (startedTurnKeys.length === 0) {
    return new Set<string>();
  }

  const completedTurnKeys = new Set(
    listStoredTurnCompletedKeys(args.db, { keys: startedTurnKeys }).map(
      toTurnKey,
    ),
  );

  for (const [index, entry] of args.batchEvents.entries()) {
    if (
      !args.insertedEventIndexLookup.has(index) ||
      entry.event.type !== "turn/completed"
    ) {
      continue;
    }
    completedTurnKeys.delete(
      toTurnKey({
        threadId: entry.threadId,
        turnId: requireThreadEventScopeTurnId({
          type: entry.event.type,
          scope: entry.event.scope,
        }),
      }),
    );
  }
  return completedTurnKeys;
}

function shouldApplyEventEffect(args: ShouldApplyEventEffectArgs): boolean {
  const { entry } = args;

  if (entry.event.type === "turn/completed") {
    return args.insertedEventIndexLookup.has(args.index);
  }

  if (entry.event.type === "turn/started") {
    return !args.completedTurnKeyLookup.has(
      toTurnKey({
        threadId: entry.threadId,
        turnId: requireThreadEventScopeTurnId({
          type: entry.event.type,
          scope: entry.event.scope,
        }),
      }),
    );
  }

  return true;
}

function resolveEventsToApply(
  args: ResolveEventsToApplyArgs,
): HostDaemonEventEnvelope[] {
  const insertedEventIndexLookup = new Set(args.insertedEventIndexes);
  const completedTurnKeyLookup = listCompletedTurnKeysForStartedEvents({
    batchEvents: args.events,
    db: args.db,
    insertedEventIndexLookup,
  });

  return args.events.filter((entry, index) =>
    shouldApplyEventEffect({
      completedTurnKeyLookup,
      entry,
      index,
      insertedEventIndexLookup,
    }),
  );
}

function resolveActivePruneCandidates(
  args: ResolveActivePruneCandidatesArgs,
): ActivePruneCandidate[] {
  const latestPrunableSequenceByThreadId = new Map<string, number>();

  for (const [acceptedIndex, acceptedEvent] of args.acceptedEvents.entries()) {
    const inputIndex = args.insertedEventIndexes[acceptedIndex];
    if (inputIndex === undefined) {
      throw new Error("Missing inserted event index for accepted daemon event");
    }
    const entry = args.events[inputIndex];
    if (entry === undefined) {
      throw new Error("Missing daemon event for inserted event index");
    }
    if (!isActivePruneTriggerThreadEventType(entry.event.type)) {
      continue;
    }

    const previousSequence = latestPrunableSequenceByThreadId.get(
      entry.threadId,
    );
    if (
      previousSequence === undefined ||
      acceptedEvent.sequence > previousSequence
    ) {
      latestPrunableSequenceByThreadId.set(
        entry.threadId,
        acceptedEvent.sequence,
      );
    }
  }

  return [...latestPrunableSequenceByThreadId.entries()].map(
    ([threadId, latestPrunableSequence]) => ({
      threadId,
      latestPrunableSequence,
    }),
  );
}

function summarizeRejectedDaemonEvents(
  rejectedEvents: readonly HostDaemonRejectedEvent[],
): RejectedDaemonEventSummary {
  return {
    count: rejectedEvents.length,
    threadIds: [...new Set(rejectedEvents.map((event) => event.threadId))],
  };
}

function resolvePostableEventBatchEntries(
  deps: Pick<AppDeps, "db">,
  args: ResolvePostableEventBatchEntriesArgs,
): ResolvePostableEventBatchEntriesResult {
  const threadIds = [...new Set(args.events.map((entry) => entry.threadId))];
  if (threadIds.length === 0) {
    return {
      entries: [],
      rejectedEvents: [],
    };
  }

  const ownedThreads = listThreadEnvironmentAssignmentsOnHost(deps.db, {
    hostId: args.hostId,
    threadIds,
  });

  const canonicalEnvironmentIdByThreadId = new Map<string, string | null>();
  for (const ownedThread of ownedThreads) {
    canonicalEnvironmentIdByThreadId.set(
      ownedThread.threadId,
      ownedThread.environmentId,
    );
  }

  const entries: PostableEventBatchEntry[] = [];
  const rejectedEvents: HostDaemonRejectedEvent[] = [];
  for (const [eventIndex, entry] of args.events.entries()) {
    if (!canonicalEnvironmentIdByThreadId.has(entry.threadId)) {
      rejectedEvents.push({
        eventIndex,
        reason: "thread_not_owned_by_host",
        threadId: entry.threadId,
      });
      continue;
    }
    const canonicalEnvironmentId =
      canonicalEnvironmentIdByThreadId.get(entry.threadId) ?? null;
    entries.push({
      envelope: entry,
      environmentId: canonicalEnvironmentId,
      eventIndex,
    });
  }

  return {
    entries,
    rejectedEvents,
  };
}

function storeExecutionReports<
  TEntry extends { envelope: HostDaemonEventEnvelope },
>(deps: AppDeps, entries: TEntry[]): TEntry[] {
  const kept: TEntry[] = [];
  for (const entry of entries) {
    const { event, threadId } = entry.envelope;
    if (event.type === "thread/execution/reported") {
      upsertThreadExecutionReport(deps.db, {
        threadId,
        execution: event.execution,
        reportedAt: Date.now(),
      });
    } else {
      kept.push(entry);
    }
  }
  return kept;
}

function collectSpendObservationSources(
  deps: AppDeps,
  args: {
    acceptedEvents: readonly AcceptedDaemonEvent[];
    entries: readonly { envelope: HostDaemonEventEnvelope }[];
    insertedInputIndexes: readonly number[];
  },
): SpendRollupObservationSource[] {
  const sources: SpendRollupObservationSource[] = [];
  const providerIdByThreadId = new Map<string, string | null>();
  for (const [position, inputIndex] of args.insertedInputIndexes.entries()) {
    const entry = args.entries[inputIndex];
    const accepted = args.acceptedEvents[position];
    if (
      entry === undefined ||
      accepted === undefined ||
      entry.envelope.event.type !== "thread/tokenUsage/updated"
    )
      continue;
    const threadId = entry.envelope.threadId;
    if (!providerIdByThreadId.has(threadId))
      providerIdByThreadId.set(
        threadId,
        getThread(deps.db, threadId)?.providerId ?? null,
      );
    const providerId = providerIdByThreadId.get(threadId) ?? null;
    if (providerId === null) continue;
    sources.push({
      createdAt: accepted.createdAt,
      event: entry.envelope.event,
      providerId,
      sequence: accepted.sequence,
      threadId,
      turnId: getThreadEventScopeTurnId(entry.envelope.event.scope) ?? null,
    });
  }
  return sources;
}

function dropReplayedEntries<
  TEntry extends { envelope: HostDaemonEventEnvelope },
>(deps: Pick<AppDeps, "db">, entries: TEntry[]): TEntry[] {
  const stored = listStoredDaemonReplayKeys(
    deps.db,
    entries.flatMap(({ envelope }) =>
      envelope.replayKey === undefined ? [] : [envelope.replayKey],
    ),
  );
  return stored.size === 0
    ? entries
    : entries.filter(
        ({ envelope }) =>
          envelope.replayKey === undefined || !stored.has(envelope.replayKey),
      );
}

interface DroppedLifecycleEvent {
  eventIndex: number;
  eventType: string;
  interactionId: string;
  threadId: string;
}

function lifecycleInteractionId(
  event: HostDaemonEventEnvelope["event"],
): string | null {
  switch (event.type) {
    case "system/interaction/lifecycle":
      return event.interaction.id;
    case "system/permissionGrant/lifecycle":
    case "system/userQuestion/lifecycle":
      return event.interactionId;
    default:
      return null;
  }
}

function dropInteractionLifecycleEvents(entries: PostableEventBatchEntry[]): {
  entries: PostableEventBatchEntry[];
  droppedLifecycleEvents: DroppedLifecycleEvent[];
} {
  const kept: PostableEventBatchEntry[] = [];
  const droppedLifecycleEvents: DroppedLifecycleEvent[] = [];
  for (const entry of entries) {
    const interactionId = lifecycleInteractionId(entry.envelope.event);
    if (interactionId === null) {
      kept.push(entry);
      continue;
    }
    droppedLifecycleEvents.push({
      eventIndex: entry.eventIndex,
      eventType: entry.envelope.event.type,
      interactionId,
      threadId: entry.envelope.threadId,
    });
  }
  return { entries: kept, droppedLifecycleEvents };
}

export function registerInternalEventRoutes(
  app: Hono,
  deps: AppDeps,
  activeThreadPruneRuntime?: ActiveThreadEventPruneRuntimeOptions,
): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post(
    "/session/events",
    hostDaemonEventBatchRequestSchema,
    async (context, payload) => {
      const receivedAt = performance.now();
      let session: ReturnType<typeof requireAuthenticatedDaemonSession>;
      try {
        session = requireAuthenticatedDaemonSession({
          context,
          db: deps.db,
          sessionId: payload.sessionId,
        });
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.body.code === "inactive_session"
        ) {
          deps.logger.info(
            getInactiveSessionLogFields(deps.db, {
              authenticatedHostId: getAuthenticatedDaemon(context).hostId,
              now: Date.now(),
              sessionId: payload.sessionId,
            }),
            "Daemon event batch for inactive session",
          );
        }
        throw error;
      }
      const events = ungroupHostDaemonEvents(payload.eventGroups).map(
        (envelope) => ({
          ...envelope,
          event: maskResolvedProviderEnvironment(envelope.event),
        }),
      );
      const { entries: ownedEntries, rejectedEvents } =
        resolvePostableEventBatchEntries(deps, {
          hostId: session.hostId,
          events,
        });
      const { entries: lifecycleFilteredEntries, droppedLifecycleEvents } =
        dropInteractionLifecycleEvents(ownedEntries);
      const entries = dropForkUnreadEvents(
        storeExecutionReports(
          deps,
          dropReplayedEntries(deps, lifecycleFilteredEntries),
        ),
      );
      if (droppedLifecycleEvents.length > 0) {
        deps.logger.warn(
          {
            hostId: session.hostId,
            sessionId: session.id,
            droppedEvents: droppedLifecycleEvents,
          },
          "Dropped daemon-posted interaction lifecycle events; the server is their only author",
        );
      }
      if (rejectedEvents.length > 0) {
        deps.logger.warn(
          {
            hostId: session.hostId,
            rejectedEvents: summarizeRejectedDaemonEvents(rejectedEvents),
            sessionId: session.id,
          },
          "Rejected daemon events for threads outside the session host",
        );
      }
      const validatedEnvelopes = validatePresentationIcons(
        deps,
        await validateExtensionPayloads(
          deps,
          entries.map((entry) => entry.envelope),
        ),
      );
      const labelledEntries = entries
        .map((entry, index) => {
          const validated = validatedEnvelopes[index];
          if (validated === undefined) {
            throw new Error(
              "Missing validated envelope for daemon event entry",
            );
          }
          return {
            ...entry,
            envelope: validated,
          };
        })
        .map((entry) => preserveTerminalProvisioningStatus(deps, entry));
      const eventInputs = labelledEntries.map((entry) => {
        return toStoredEvent({
          envelope: entry.envelope,
          environmentId: entry.environmentId,
        });
      });
      const postableEvents = labelledEntries.map((entry) => entry.envelope);
      let appendResult: AppendDaemonEventsResult;
      try {
        const replayKeys = entries.flatMap((entry) =>
          entry.envelope.replayKey === undefined
            ? []
            : [entry.envelope.replayKey],
        );
        appendResult = deps.db.transaction(
          (tx) => {
            if (listStoredDaemonReplayKeys(deps.db, replayKeys).size > 0) {
              throw new ApiError(
                503,
                "replayed_event_batch_race",
                "A concurrent batch stored some of these replayed events first; retry to append the rest",
                true,
              );
            }
            const result = appendDaemonEventsInTransaction(tx, eventInputs);
            recordDaemonReplayKeys(deps.db, { replayKeys, now: Date.now() });
            recordSpendForInsertedEvents(
              deps.db,
              collectSpendObservationSources(deps, {
                acceptedEvents: result.acceptedEvents,
                entries: labelledEntries,
                insertedInputIndexes: result.insertedInputIndexes,
              }),
            );
            return result;
          },
          { behavior: "immediate" },
        );
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.body.code === "replayed_event_batch_race"
        )
          throw error;
        if (error instanceof MissingStoredTurnStartedError) {
          deps.logger.warn(
            {
              ...error.details,
              sessionId: session.id,
              ...runtimeErrorLogFields(deps.config, error),
            },
            "Deferred daemon event batch until turn/started is stored",
          );
          throw new ApiError(503, "turn_start_pending", error.message, {
            details: error.details,
            retryable: true,
          });
        }
        throw error;
      }
      for (const index of appendResult.skippedTurnUnstartedInputIndexes) {
        const skipped = eventInputs[index];
        deps.logger.warn(
          {
            eventType: skipped?.type,
            threadId: skipped?.threadId,
            sessionId: session.id,
          },
          "Dropped orphan thread-state snapshot with no stored turn/started",
        );
      }
      const committedAt = performance.now();
      notifyInsertedEventThreads(deps, {
        eventInputs,
        insertedInputIndexes: appendResult.insertedInputIndexes,
      });
      const turnTraceBatch = {
        committedAt,
        events: postableEvents,
        notifiedAt: performance.now(),
        receivedAt,
      };
      observeTurnTraceEventBatch(turnTraceBatch);
      observeStreamTraceEventBatch(deps, turnTraceBatch);

      const followUps = await applyEventEffects(
        deps,
        resolveEventsToApply({
          db: deps.db,
          events: postableEvents,
          insertedEventIndexes: appendResult.insertedInputIndexes,
        }),
      );
      const activePruneCandidates = resolveActivePruneCandidates({
        acceptedEvents: appendResult.acceptedEvents,
        events: postableEvents,
        insertedEventIndexes: appendResult.insertedInputIndexes,
      });

      deferEventFollowUpBatch(deps, followUps);
      const response: HostDaemonEventBatchResponse = {
        acceptedEvents: appendResult.acceptedEvents.map(
          (acceptedEvent, acceptedIndex) => {
            const inputIndex = appendResult.insertedInputIndexes[acceptedIndex];
            if (inputIndex === undefined) {
              throw new Error(
                "Missing inserted event index for accepted daemon event",
              );
            }
            const entry = entries[inputIndex];
            if (entry === undefined) {
              throw new Error("Missing daemon event entry for accepted event");
            }
            return {
              eventIndex: entry.eventIndex,
              sequence: acceptedEvent.sequence,
              threadId: acceptedEvent.threadId,
            };
          },
        ),
        rejectedEvents,
      };
      const body = JSON.stringify(response);
      if (activePruneCandidates.length > 0) {
        deferAfterResponse({
          config: deps.config,
          logger: deps.logger,
          name: "Active thread event pruning",
          work: async () => {
            for (const candidate of activePruneCandidates) {
              maybePruneActiveThreadEventHistory(deps, {
                ...candidate,
                schedule: activeThreadPruneRuntime?.schedule,
              });
            }
          },
        });
      }
      return context.body(body, 200, {
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "application/json",
      });
    },
  );
}
