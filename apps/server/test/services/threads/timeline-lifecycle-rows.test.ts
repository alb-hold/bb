import { beforeEach, describe, expect, it, vi } from "vitest";
import { turnScope } from "@bb/domain";
import type { Thread } from "@bb/domain";
import {
  createProject,
  createThread,
  getLatestThreadSequence,
  insertEvents,
  listStoredItemLifecycleRowsByItems,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import type { DbConnection } from "@bb/db";
import type {
  TimelinePaginationCursor,
  TimelineRow,
} from "@bb/server-contract";
import { buildThreadTimelineWithProfile } from "../../../src/services/threads/timeline.js";

vi.mock("@bb/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bb/db")>();
  return {
    ...actual,
    listStoredItemLifecycleRowsByItems: vi.fn(
      actual.listStoredItemLifecycleRowsByItems,
    ),
  };
});

const providerThreadId = "provider-root";
const TURN_ID = "turn-1";
const SELECTIVE_TURN_ROW_COUNT = 200;
const PAGE_EVENT_BUDGET = 20;
const UNBOUNDED_EVENT_BUDGET = 10_000;

type EventInput = Parameters<typeof insertEvents>[2][number];
type LifecycleType = "item/started" | "item/completed";

interface LifecycleSlot {
  itemId: string;
  type: LifecycleType;
}

function setup(): { db: DbConnection; thread: Thread } {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "claude-code",
  });
  return { db, thread };
}

function lifecycleEvent(
  thread: Thread,
  sequence: number,
  slot: LifecycleSlot,
): EventInput {
  const completed = slot.type === "item/completed";
  return {
    threadId: thread.id,
    sequence,
    type: slot.type,
    scope: turnScope(TURN_ID),
    providerThreadId,
    itemId: slot.itemId,
    itemKind: "commandExecution",
    parentToolCallId: null,
    data: JSON.stringify({
      item: {
        type: "commandExecution",
        id: slot.itemId,
        command: "echo",
        cwd: "/tmp/test",
        status: completed ? "completed" : "pending",
        approvalStatus: null,
        ...(completed ? { exitCode: 0, aggregatedOutput: "done" } : {}),
      },
    }),
  };
}

function seedTurn(
  db: DbConnection,
  thread: Thread,
  slots: ReadonlyMap<number, LifecycleSlot>,
  rowCount: number,
): void {
  const events: EventInput[] = [
    {
      threadId: thread.id,
      sequence: 1,
      type: "turn/started",
      scope: turnScope(TURN_ID),
      providerThreadId,
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      data: JSON.stringify({}),
    },
  ];
  for (let sequence = 2; sequence <= rowCount; sequence += 1) {
    events.push(
      lifecycleEvent(
        thread,
        sequence,
        slots.get(sequence) ?? {
          itemId: `filler-${sequence}`,
          type: "item/completed",
        },
      ),
    );
  }
  insertEvents(db, noopNotifier, events);
}

function buildPage(
  db: DbConnection,
  thread: Thread,
  eventBudget: number,
  cursor: TimelinePaginationCursor | null,
) {
  return buildThreadTimelineWithProfile(db, thread, {
    completedTurnDisplay: "collapse",
    eventBudget,
    responseByteBudget: 1_000_000,
    includeClearedContextHistory: false,
    includeDiagnosticOperations: false,
    compactionOfferEnabled: false,
    summarizeShellCommands: true,
    includeNestedRows: true,
    maxInlineOutputChars: 32_000,
    maxSeq: getLatestThreadSequence(db, { threadId: thread.id }),
    page: cursor
      ? { kind: "older", beforeCursor: cursor, segmentLimit: 20 }
      : { kind: "latest", segmentLimit: 20 },
  }).response;
}

function olderCursorAfterLatestPage(
  db: DbConnection,
  thread: Thread,
): TimelinePaginationCursor {
  const cursor = buildPage(db, thread, PAGE_EVENT_BUDGET, null).timelinePage
    .olderCursor;
  if (cursor === null) {
    throw new Error("expected the latest page to have an older cursor");
  }
  return cursor;
}

function commandRow(
  rows: readonly TimelineRow[],
  callId: string,
): Extract<TimelineRow, { kind: "work"; workKind: "command" }> {
  const row = rows.find(
    (candidate) =>
      candidate.kind === "work" &&
      candidate.workKind === "command" &&
      candidate.callId === callId,
  );
  if (row?.kind !== "work" || row.workKind !== "command") {
    throw new Error(`expected a command row for ${callId}`);
  }
  return row;
}

describe("timeline item lifecycle row hydration", () => {
  beforeEach(() => {
    vi.mocked(listStoredItemLifecycleRowsByItems).mockClear();
  });

  it("keeps an item completion after the older page anchor", () => {
    const { db, thread } = setup();
    seedTurn(
      db,
      thread,
      new Map<number, LifecycleSlot>([
        [2, { itemId: "spanning", type: "item/started" }],
        [
          SELECTIVE_TURN_ROW_COUNT,
          { itemId: "spanning", type: "item/completed" },
        ],
      ]),
      SELECTIVE_TURN_ROW_COUNT,
    );
    const cursor = olderCursorAfterLatestPage(db, thread);
    expect(cursor.anchorSeq).toBe(SELECTIVE_TURN_ROW_COUNT - PAGE_EVENT_BUDGET);

    const older = buildPage(db, thread, UNBOUNDED_EVENT_BUDGET, cursor);

    expect(
      older.rows.some(
        (row) =>
          row.kind === "work" &&
          row.workKind === "command" &&
          row.callId === "spanning" &&
          row.status === "completed",
      ),
    ).toBe(true);

    const row = commandRow(older.rows, "spanning");
    expect(row.status).toBe("completed");
    expect(row.exitCode).toBe(0);
    expect(row.sourceSeqStart).toBe(2);
    expect(row.sourceSeqEnd).toBe(SELECTIVE_TURN_ROW_COUNT);
  });

  it("reflects both lifecycle states at the window boundaries of a selective turn", () => {
    const { db, thread } = setup();
    const anchor = SELECTIVE_TURN_ROW_COUNT - PAGE_EVENT_BUDGET;
    const windowFirst = anchor - PAGE_EVENT_BUDGET - 1;
    seedTurn(
      db,
      thread,
      new Map<number, LifecycleSlot>([
        [windowFirst, { itemId: "window-wide", type: "item/started" }],
        [anchor - 1, { itemId: "window-wide", type: "item/completed" }],
        [anchor - 2, { itemId: "anchor-edge", type: "item/started" }],
        [anchor, { itemId: "anchor-edge", type: "item/completed" }],
      ]),
      SELECTIVE_TURN_ROW_COUNT,
    );
    const cursor = olderCursorAfterLatestPage(db, thread);
    expect(cursor.anchorSeq).toBe(anchor);

    const older = buildPage(db, thread, PAGE_EVENT_BUDGET, cursor);

    const wide = commandRow(older.rows, "window-wide");
    expect(wide.status).toBe("completed");
    expect(wide.sourceSeqStart).toBe(windowFirst);
    expect(wide.sourceSeqEnd).toBe(anchor - 1);
    const edge = commandRow(older.rows, "anchor-edge");
    expect(edge.status).toBe("completed");
    expect(edge.sourceSeqStart).toBe(anchor - 2);
    expect(edge.sourceSeqEnd).toBe(anchor);
  });

  it("does not query lifecycle rows when every selected item already has both", () => {
    const { db, thread } = setup();
    seedTurn(
      db,
      thread,
      new Map<number, LifecycleSlot>([
        [2, { itemId: "first", type: "item/started" }],
        [3, { itemId: "first", type: "item/completed" }],
        [4, { itemId: "second", type: "item/started" }],
        [5, { itemId: "second", type: "item/completed" }],
      ]),
      5,
    );

    const latest = buildPage(db, thread, UNBOUNDED_EVENT_BUDGET, null);

    expect(commandRow(latest.rows, "first").status).toBe("completed");
    expect(commandRow(latest.rows, "second").status).toBe("completed");
    expect(listStoredItemLifecycleRowsByItems).not.toHaveBeenCalled();
  });
});
