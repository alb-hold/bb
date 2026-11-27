import { describe, expect, it } from "vitest";
import {
  clientTurnRequestIdSchema,
  threadScope,
  type ThreadEvent,
} from "@bb/domain";
import { threadDeltaSchema } from "@bb/provider-bridge-protocol";
import { createDeltaAssembler } from "@bb/provider-bridge-protocol/assembler";
import {
  buildThreadTimelineFromEvents,
  resumeEventProjectionFold,
  startThreadTimelineProjectionFold,
  type ThreadEventWithMeta,
} from "@bb/thread-view";

const THREAD_ID = "thr_late_echo";
const REQUEST_ID = clientTurnRequestIdSchema.parse("creq_abcdefghjk");

const options = {
  completedTurnDisplay: "collapse",
  includeDiagnosticOperations: false,
  includeNestedRows: true,
  isLatestPage: true,
  omitSettledDelegationChildRows: false,
  summarizeShellCommands: true,
  threadName: "",
  threadStatus: "active",
  workspaceRoot: null,
} as const;

const requested: ThreadEvent = {
  type: "client/turn/requested",
  threadId: THREAD_ID,
  scope: threadScope(),
  direction: "outbound",
  requestId: REQUEST_ID,
  source: "tell",
  initiator: "user",
  senderThreadId: null,
  input: [{ type: "text", text: "look at this", mentions: [] }],
  target: { kind: "new-turn" },
  request: { method: "turn/start", params: {} },
  execution: {
    model: "gpt-5",
    serviceTier: "default",
    reasoningLevel: "medium",
    permissionMode: "full",
    source: "client/turn/requested",
  },
};

function withMeta(events: readonly ThreadEvent[]): ThreadEventWithMeta[] {
  return events.map((event, index) => ({
    event,
    meta: { id: `evt-${index + 1}`, seq: index + 1, createdAt: index + 1 },
  }));
}

function stamp(events: readonly ThreadEvent[]): ThreadEvent[] {
  return events.map((event) => ({
    ...event,
    threadId: THREAD_ID,
    providerThreadId: "provider-thread",
  }));
}

function userRequestStatuses(events: ThreadEventWithMeta[]) {
  const timeline = buildThreadTimelineFromEvents({
    acceptedClientRequestContext: {
      acceptedClientRequestEvents: [],
      rejectedClientRequestEvents: [],
    },
    contextWindowEvents: [],
    events,
    options,
  });
  return timeline.rows.flatMap((row) =>
    row.kind === "conversation" && row.role === "user" && row.turnRequest
      ? [row.turnRequest.status]
      : [],
  );
}

describe("a CLI echo that the real assembler emits after the interrupt", () => {
  const assembler = createDeltaAssembler({
    providerId: "claude-code",
    entropyPrefix: "late-echo",
    textDeltaFlushMs: 0,
  });
  const assemble = (delta: unknown) =>
    stamp(
      assembler.assemble({
        threadId: THREAD_ID,
        deltas: [threadDeltaSchema.parse(delta)],
      }),
    );
  const opened = assemble({ kind: "turn.open" });
  const accepted = assemble({
    kind: "input.accepted",
    clientRequestId: REQUEST_ID,
  });
  const closed = assemble({ kind: "turn.boundary", status: "interrupted" });
  const echo = assemble({
    kind: "input.provider",
    text: "look at this",
    clientRequestId: REQUEST_ID,
  });

  it("emits the echo after the turn closed", () => {
    expect(echo.map((event) => event.type)).toEqual(["item/completed"]);
  });

  it("reads undelivered before the echo and accepted after it", () => {
    const before = withMeta([requested, ...opened, ...accepted, ...closed]);
    expect(userRequestStatuses(before)).toEqual(["undelivered"]);
    const after = withMeta([
      requested,
      ...opened,
      ...accepted,
      ...closed,
      ...echo,
    ]);
    expect(userRequestStatuses(after)).toEqual(["accepted"]);
  });

  it("is not served from a fold that was kept before the echo", () => {
    const before = withMeta([requested, ...opened, ...accepted, ...closed]);
    const fold = startThreadTimelineProjectionFold({
      acceptedClientRequestContext: {
        acceptedClientRequestEvents: [],
        rejectedClientRequestEvents: [],
      },
      events: before,
      options,
    });
    const [late] = withMeta([
      ...before.map((entry) => entry.event),
      ...echo,
    ]).slice(before.length);
    expect(resumeEventProjectionFold(fold, [late!])).toBe(false);
  });
});
