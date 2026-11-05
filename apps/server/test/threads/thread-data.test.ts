import { describe, expect, it } from "vitest";
import {
  createProject,
  createThread,
  createConnection,
  getThread,
  upsertNativeThreadReply,
  listStoredEventRows,
  noopNotifier,
  migrate,
  upsertHost,
} from "@bb/db";
import {
  getLastThreadOutput,
  parseStoredEvent,
} from "../../src/services/threads/thread-data.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  return { db, thread };
}

describe("thread data stored event parsing", () => {
  it("prefers the newer native reply over an older assistant event", () => {
    const { db, thread } = setup();
    try {
      db.$client
        .prepare(
          `
        INSERT INTO events (
          id, thread_id, scope_kind, turn_id, sequence, type, item_id,
          item_kind, parent_tool_call_id, data, created_at
        ) VALUES (?, ?, 'turn', 'old-turn', 1, 'item/completed', ?, 'agentMessage', NULL, ?, ?)
      `,
        )
        .run(
          "evt_old_native_output",
          thread.id,
          "msg_old",
          JSON.stringify({
            item: {
              id: "msg_old",
              type: "agentMessage",
              text: "old event output",
            },
          }),
          1,
        );
      upsertNativeThreadReply(db, {
        threadId: thread.id,
        text: "latest native reply",
        turnId: "native-turn",
        recordedAt: 2,
      });
      expect(getLastThreadOutput(db, thread.id)).toBe("latest native reply");
    } finally {
      db.$client.close();
    }
  });

  it("keeps a newer event output ahead of an older native reply", () => {
    const { db, thread } = setup();
    try {
      upsertNativeThreadReply(db, {
        threadId: thread.id,
        text: "older native reply",
        turnId: "native-turn",
        recordedAt: 1,
      });
      db.$client
        .prepare(
          `
        INSERT INTO events (
          id, thread_id, scope_kind, turn_id, sequence, type, item_id,
          item_kind, parent_tool_call_id, data, created_at
        ) VALUES (?, ?, 'turn', 'new-turn', 1, 'item/completed', ?, 'agentMessage', NULL, ?, ?)
      `,
        )
        .run(
          "evt_new_provider_output",
          thread.id,
          "msg_new",
          JSON.stringify({
            item: {
              id: "msg_new",
              type: "agentMessage",
              text: "new event output",
            },
          }),
          2,
        );
      expect(getLastThreadOutput(db, thread.id)).toBe("new event output");
    } finally {
      db.$client.close();
    }
  });

  it("returns a persisted native reply when no output event exists", () => {
    const { db, thread } = setup();
    try {
      upsertNativeThreadReply(db, {
        threadId: thread.id,
        text: "latest native reply",
        turnId: null,
        recordedAt: Date.now(),
      });
      expect(getLastThreadOutput(db, thread.id)).toBe("latest native reply");
    } finally {
      db.$client.close();
    }
  });

  it("keeps migrated thread reads working when the fork reply table exists", () => {
    const { db, thread } = setup();
    try {
      upsertNativeThreadReply(db, {
        threadId: thread.id,
        text: "native reply",
        turnId: null,
        recordedAt: Date.now(),
      });
      migrate(db);
      expect(getThread(db, thread.id)?.id).toBe(thread.id);
    } finally {
      db.$client.close();
    }
  });

  it("rejects malformed stored scope kinds", () => {
    const { db, thread } = setup();

    try {
      db.$client.pragma("ignore_check_constraints = ON");
      db.$client
        .prepare(
          `INSERT INTO events (
            id,
            thread_id,
            scope_kind,
            turn_id,
            sequence,
            type,
            data,
            created_at
          )
          VALUES (
            'evt_malformed_scope_kind',
            ?,
            'bogus',
            'turn-1',
            1,
            'system/error',
            '{"message":"boom"}',
            1
          )`,
        )
        .run(thread.id);
      db.$client.pragma("ignore_check_constraints = OFF");

      const [row] = listStoredEventRows(db, { threadId: thread.id });
      if (!row) {
        throw new Error("Expected stored event row");
      }

      expect(() => parseStoredEvent(row)).toThrow(/invalid scope_kind/);
    } finally {
      db.$client.pragma("ignore_check_constraints = OFF");
      db.$client.close();
    }
  });
});
