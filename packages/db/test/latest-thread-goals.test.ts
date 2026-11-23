import { expect, it } from "vitest";
import {
  backfillThreadGoal,
  listLatestThreadStateEventRowsByScope,
  listPendingGoalBackfills,
} from "../src/data/events.js";
import { createMigratedConnection } from "../src/testing.js";

it("keeps the scoped goal lookup current through out-of-order writes, edits and pruning", () => {
  const db = createMigratedConnection();
  try {
    const threadId = "thr_goal_projection";
    const other = "thr_goal_move";
    const seed = db.$client.prepare(
      "INSERT INTO threads (id, project_id, provider_id, status, created_at, updated_at, latest_attention_at) VALUES (?, 'proj_personal', 'codex', 'idle', 1, 1, 1)",
    );
    seed.run(threadId);
    seed.run(other);
    const insert = db.$client.prepare(
      "INSERT INTO events (id, thread_id, sequence, type, data, scope_kind, created_at) VALUES (?, ?, ?, ?, ?, 'thread', 1)",
    );
    const rows = (ids: string[]) =>
      listLatestThreadStateEventRowsByScope(db, {
        scope: { kind: "ids", ids },
        kind: "provider-codex/goal",
      }).map((row) => row.id);
    insert.run("clear", threadId, 4, "thread/goal/cleared", "{}");
    insert.run("legacy", threadId, 1, "thread/goal/updated", "{}");
    insert.run(
      "modern",
      threadId,
      3,
      "thread/extensionState/updated",
      '{"kind":"provider-codex/goal"}',
    );
    insert.run(
      "other",
      threadId,
      6,
      "thread/extensionState/updated",
      '{"kind":"unrelated"}',
    );
    db.$client
      .prepare(
        "UPDATE latest_thread_goals SET sequence = NULL WHERE thread_id = ?",
      )
      .run(threadId);
    expect(listPendingGoalBackfills(db)).toContainEqual({ threadId });
    expect(rows([threadId])).toEqual(["clear"]);
    backfillThreadGoal(db, threadId);
    expect(listPendingGoalBackfills(db)).toEqual([]);
    expect(rows([threadId])).toEqual(["clear"]);
    db.$client.prepare("DELETE FROM events WHERE id = 'clear'").run();
    expect(rows([threadId])).toEqual(["modern"]);
    db.$client
      .prepare("UPDATE events SET thread_id = ? WHERE id = 'modern'")
      .run(other);
    expect(rows([threadId])).toEqual(["legacy"]);
    expect(rows([other])).toEqual(["modern"]);
    db.$client
      .prepare("UPDATE events SET data = '{}' WHERE id = 'modern'")
      .run();
    expect(rows([other])).toEqual([]);
    db.$client
      .prepare("UPDATE events SET data = ? WHERE id = 'other'")
      .run('{"kind":"provider-codex/goal"}');
    expect(rows([threadId])).toEqual(["other"]);
    db.$client.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
    expect(
      db.$client.prepare("SELECT thread_id FROM latest_thread_goals").all(),
    ).toEqual([]);
  } finally {
    db.$client.close();
  }
});

it("matches historical goal selection for pending and resolved threads throughout backfill", () => {
  const db = createMigratedConnection();
  try {
    const ids = ["resolved", "pending", "without-goal"];
    const events = db.$client.prepare(
      "INSERT INTO events (id, thread_id, sequence, type, data, scope_kind, created_at) VALUES (?, ?, ?, 'thread/extensionState/updated', ?, 'thread', 1)",
    );
    for (const id of ids) {
      db.$client
        .prepare(
          "INSERT INTO threads (id, project_id, provider_id, status, created_at, updated_at, latest_attention_at) VALUES (?, 'proj_personal', 'codex', 'idle', 1, 1, 1)",
        )
        .run(id);
      if (id !== "without-goal")
        events.run(id + "-goal", id, 3, '{"kind":"provider-codex/goal"}');
      events.run(id + "-other", id, 4, '{"kind":"other"}');
    }
    db.$client.exec(
      "INSERT OR REPLACE INTO latest_thread_goals(thread_id) VALUES ('pending'), ('without-goal')",
    );
    const compare = () => {
      const lookup = db.$client.prepare(`
        SELECT id FROM events INDEXED BY events_thread_state_thread_sequence_idx
        WHERE thread_id = ? AND type IN ('thread/goal/updated', 'thread/goal/cleared', 'thread/extensionState/updated')
          AND (type <> 'thread/extensionState/updated' OR json_extract(data,'$.kind') = 'provider-codex/goal')
        ORDER BY sequence DESC LIMIT 1
      `).pluck();
      const expected = ids.flatMap(id => lookup.all(id)).sort();
      expect(
        listLatestThreadStateEventRowsByScope(db, {
          scope: { kind: "ids", ids },
          kind: "provider-codex/goal",
        })
          .map((row) => row.id)
          .sort(),
      ).toEqual(expected);
    };
    compare();
    expect(() =>
      db.transaction(() => {
        events.run(
          "rolled-back",
          "pending",
          6,
          '{"kind":"provider-codex/goal"}',
        );
        compare();
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    compare();
    events.run("older-import", "pending", 1, '{"kind":"provider-codex/goal"}');
    expect(listPendingGoalBackfills(db)).toEqual([
      { threadId: "without-goal" },
    ]);
    compare();
    backfillThreadGoal(db, "without-goal");
    compare();
  } finally {
    db.$client.close();
  }
});
