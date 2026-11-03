import { describe, expect, it } from "vitest";
import { turnScope } from "@bb/domain";
import { createProject, createThread, insertEvents, migrate, noopNotifier, upsertHost } from "@bb/db";
import { createConnection } from "@bb/db";
import type { DbConnection, Thread } from "@bb/domain";
import { buildThreadTimelineWithProfile } from "../../../src/services/threads/timeline.js";

function setup(): { db: DbConnection; thread: Thread } {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, { name: "timeline-test-host" });
  const { project } = createProject(db, noopNotifier, { name: "timeline-test-project", source: { type: "local_path", hostId: host.id, path: "/tmp/timeline-test" } });
  return { db, thread: createThread(db, noopNotifier, { projectId: project.id, providerId: "codex" }) };
}

function insertLifecycle(db: DbConnection, threadId: string, turnId: string, id: string, sequence: number, type: "item/started" | "item/completed"): void {
  insertEvents(db, noopNotifier, [{ threadId, sequence, createdAt: sequence, type, scope: turnScope(turnId), itemId: id, itemKind: "agentMessage", parentToolCallId: null, data: JSON.stringify({}) }]);
}

function page(db: DbConnection, thread: Thread, segmentLimit: number, beforeCursor?: { anchorId: string; anchorSeq: number }) {
  return buildThreadTimelineWithProfile(db, thread, { completedTurnDisplay: "collapse", eventBudget: 1000, responseByteBudget: 1000000, includeClearedContextHistory: false, includeDiagnosticOperations: false, compactionOfferEnabled: false, summarizeShellCommands: true, includeNestedRows: false, maxInlineOutputChars: 32000, maxSeq: 0, page: beforeCursor ? { kind: "older", beforeCursor, segmentLimit } : { kind: "latest", segmentLimit } }).response;
}

describe("timeline item lifecycle row hydration", () => {
  it("retains completion after an older page anchor", () => {
    const { db, thread } = setup();
    try {
      insertLifecycle(db, thread.id, "turn-a", "item-a", 1, "item/started");
      insertLifecycle(db, thread.id, "turn-a", "item-a", 2, "item/completed");
      const result = page(db, thread, 1, { anchorId: "timeline-window:2", anchorSeq: 2 });
      expect(JSON.stringify(result)).toContain("item-a");
    } finally { db.$client.close(); }
  });

  it("keeps lifecycle rows at both window boundaries", () => {
    const { db, thread } = setup();
    try {
      insertLifecycle(db, thread.id, "turn-b", "item-b", 1, "item/started");
      insertLifecycle(db, thread.id, "turn-b", "item-b", 2, "item/completed");
      const result = page(db, thread, 20);
      expect(JSON.stringify(result)).toContain("item/started");
      expect(JSON.stringify(result)).toContain("item/completed");
    } finally { db.$client.close(); }
  });

  it("returns a timeline when lifecycle rows are already selected", () => {
    const { db, thread } = setup();
    try {
      insertLifecycle(db, thread.id, "turn-c", "item-c", 1, "item/started");
      insertLifecycle(db, thread.id, "turn-c", "item-c", 2, "item/completed");
      const result = page(db, thread, 20);
      expect(JSON.stringify(result)).toContain("item-c");
    } finally { db.$client.close(); }
  });
});
