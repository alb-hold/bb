import { z } from "zod";
import { pluginIdSchema } from "./plugin-id.js";
import { clientTurnRequestIdSchema } from "./protocol-ids.js";
import {
  systemMessageKindSchema,
  systemMessageSubjectSchema,
} from "./system-message.js";


/**
 * Why a queued row is not dispatching yet.
 *
 * - `time` — the row has a future `sendAt`. The instant lives in the row's
 *   own `sendAt` field, which is what the due sweep indexes, so this arm
 *   carries no payload of its own.
 * - `thread-busy` — the thread is running a turn and the message asked to
 *   wait for idle rather than steer.
 * - `stopping` — the user asked the thread to stop and the stop has not
 *   landed yet. Distinct from `thread-busy` because the manual-stop queue
 *   pause deliberately holds back the rows that were merely waiting for the
 *   turn to end, while a row carrying this wait is one the user asked for
 *   AFTER requesting the stop — by sending it, queueing it, or pressing Send
 *   now — and so dispatches as soon as the thread reaches idle.
 * - `provisioning` — the thread's workspace is being (re)provisioned. Only
 *   follow-ups and steers wait on this: a thread's first message rides the
 *   cold-start command instead.
 * - `host-offline` — the thread's workspace exists, but the machine it runs on
 *   is disconnected or pausing/resuming, so execution waits for readiness. Distinct
 *   from `provisioning` because the two are cleared by different events and
 *   read differently to a user: a provisioning workspace is being built and
 *   will finish on its own, while an offline host is waiting on a machine that
 *   may be shut, asleep, or off the network. It carries the host's display
 *   name for the same reason the `plugin` arm carries its reason — the
 *   renderers that word this wait (the timeline projection in `thread-view`,
 *   `bb thread queue`) have no database to resolve an id against.
 * - `interaction` — the thread has a pending interaction the user has not
 *   settled.
 * - `plugin` — a plugin's dispatch gate returned `wait(reason)`. This is the
 *   only arm with an authored reason, because it is the only arm whose reason
 *   is not derivable from the kind (plus `sendAt`) by the renderer.
 * - `superseded` — a retry of input the provider never accepted, overtaken by
 *   a newer turn request. It is never sent automatically; the user sends or
 *   deletes it.
 */

export const queuedMessageWaitingOnKindValues = [
  "time",
  "thread-busy",
  "stopping",
  "turn-starting",
  "provisioning",
  "host-offline",
  "interaction",
  "app-update",
  "plugin",
  "superseded",
  "workspace-busy",

] as const;
export const queuedMessageWaitingOnKindSchema = z.enum(
  queuedMessageWaitingOnKindValues,
);
export type QueuedMessageWaitingOnKind = z.infer<
  typeof queuedMessageWaitingOnKindSchema
>;

export const queuedMessageWaitHostNameSchema = z.string().min(1).max(200);

export const QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH = 200;
export const queuedMessageWaitReasonSchema = z
  .string()
  .min(1)
  .max(QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH);

export const queuedMessageWaitingOnSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("time") }),
  z.object({ kind: z.literal("thread-busy") }),
  z.object({ kind: z.literal("stopping") }),
  z.object({ kind: z.literal("turn-starting") }),
  z.object({ kind: z.literal("provisioning") }),
  z.object({
    kind: z.literal("host-offline"),
    hostName: queuedMessageWaitHostNameSchema,
  }),
  z.object({ kind: z.literal("interaction") }),
  z.object({ kind: z.literal("app-update") }),
  z.object({
    kind: z.literal("workspace-busy"),
    holderThreadId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("plugin"),
    pluginId: pluginIdSchema,
    reason: queuedMessageWaitReasonSchema,
  }),
  z.object({ kind: z.literal("superseded") }),
]);
export type QueuedMessageWaitingOn = z.infer<
  typeof queuedMessageWaitingOnSchema
>;

export const QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH = 200;
export const queuedMessageFailureReasonSchema = z
  .string()
  .min(1)
  .max(QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH);

export const QUEUED_MESSAGE_PLUGIN_WAIT_HOLDER_PREFIX = "plugin:";

export const queuedMessageWaitHolderSchema = z.templateLiteral([
  QUEUED_MESSAGE_PLUGIN_WAIT_HOLDER_PREFIX,
  pluginIdSchema,
]);
export type QueuedMessageWaitHolder = z.infer<
  typeof queuedMessageWaitHolderSchema
>;

export const queuedMessagePayloadKindValues = ["inline", "retry"] as const;
export const queuedMessagePayloadKindSchema = z.enum(
  queuedMessagePayloadKindValues,
);
export type QueuedMessagePayloadKind = z.infer<
  typeof queuedMessagePayloadKindSchema
>;

export const queuedMessagePayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inline") }),
  z.object({
    kind: z.literal("retry"),
    retryOfTurnRequestId: clientTurnRequestIdSchema,
    attempt: z.number().int().min(2),
    reason: queuedMessageWaitReasonSchema,
  }),
]);
export type QueuedMessagePayload = z.infer<typeof queuedMessagePayloadSchema>;

export const RESTART_RESUME_RETRY_REASON = "bb restarted";

/**
 * Core's own taxonomy for a queued row that is a SYSTEM notice rather than
 * someone's message — today, the "your child thread finished" notice a parent
 * gets while it is busy answering a question.
 *
 * Null for every ordinary row, which is the overwhelming majority. It exists
 * because such a notice is dispatched as an `initiator: "system"` turn whose
 * event carries this taxonomy, and a notice that queued and then dispatched
 * without it would be a different turn than the one that would have been sent
 * a moment earlier. The `deferred_thread_messages` table used to carry it; the
 * queue is the one queue now, so it carries it here.
 */

export const queuedMessageSystemNoticeSchema = z.object({
  kind: systemMessageKindSchema,
  subject: systemMessageSubjectSchema.nullable(),
});
export type QueuedMessageSystemNotice = z.infer<
  typeof queuedMessageSystemNoticeSchema
>;
