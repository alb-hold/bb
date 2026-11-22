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
