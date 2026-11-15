import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { noopNotifier } from "../../src/notifier.js";
import { createProject } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import {
  createThread,
  deleteThread,
  hasThreadPurgeBacklog,
  nextThreadPurgeBatchSize,
  purgeThreadRows,
} from "../../src/data/threads.js";
import { createMigratedConnection } from "../../src/testing.js";
import type { DbConnection } from "../../src/connection.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "host" });
  const { project } = createProject(db, noopNotifier, {
    name: "project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/purge" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "test",
    status: "idle",
  });
  return { db, thread };
}

function seedRows(
  db: DbConnection,
  threadId: string,
  eventCount: number,
  segmentCount: number,
) {
  db.transaction((tx) => {
    for (let i = 0; i < eventCount; i += 1) {
      tx.run(
        sql`INSERT INTO events (id, thread_id, scope_kind, sequence, type, data, created_at) VALUES (${`${threadId}_e${i}`}, ${threadId}, 'thread', ${i + 1000}, 'thread/started', '{}', ${i})`,
      );
    }
    for (let i = 0; i < segmentCount; i += 1) {
      tx.run(
        sql`INSERT INTO thread_search_segments (id, thread_id, source_kind, source_key, text, created_at, updated_at) VALUES (${`${threadId}_s${i}`}, ${threadId}, 'message', ${`k${i}`}, 'needle text', 1, 1)`,
      );
    }
  });
}

function countRows(db: DbConnection, table: string, threadId: string) {
  return (
    db.get<{ count: number }>(
      sql`SELECT count(*) AS count FROM ${sql.identifier(table)} WHERE thread_id = ${threadId}`,
    )?.count ?? 0
  );
}

describe("thread purge", () => {
  it("drains every heavy cascade row and then deletes the thread", async () => {
    const { db, thread } = setup();
    seedRows(db, thread.id, 2500, 700);
    expect(hasThreadPurgeBacklog(db, thread.id, 1000)).toBe(true);

    const deleted = await purgeThreadRows(db, thread.id, {
      batchSize: 1000,
      yieldToEventLoop: () => Promise.resolve(),
    });

    expect(deleted).toBe(3200);
    expect(countRows(db, "events", thread.id)).toBe(0);
    expect(countRows(db, "thread_search_segments", thread.id)).toBe(0);
    expect(
      db.get<{ count: number }>(
        sql`SELECT count(*) AS count FROM thread_search_segments_fts`,
      )?.count,
    ).toBe(0);
    expect(hasThreadPurgeBacklog(db, thread.id, 1000)).toBe(false);
    expect(deleteThread(db, noopNotifier, thread.id)).toBe(true);
    expect(
      db.get<{ count: number }>(
        sql`SELECT count(*) AS count FROM threads WHERE id = ${thread.id}`,
      )?.count,
    ).toBe(0);
  });

  it("yields to the event loop between batches", async () => {
    const { db, thread } = setup();
    seedRows(db, thread.id, 2500, 0);
    const order: string[] = [];
    let yields = 0;

    const purge = purgeThreadRows(db, thread.id, {
      batchSize: 1000,
      yieldToEventLoop: () => {
        yields += 1;
        return new Promise<void>((resolve) => setImmediate(resolve));
      },
    }).then(() => order.push("purge"));
    setImmediate(() => order.push("other"));
    await purge;

    expect(order).toEqual(["other", "purge"]);
    expect(yields).toBe(3);
    expect(countRows(db, "events", thread.id)).toBe(0);
  });

  it("shrinks batches when they run slow and grows them when they run fast", async () => {
    async function batchSizes(rows: number, batchMs: number) {
      const { db, thread } = setup();
      seedRows(db, thread.id, rows, 0);
      let calls = 0;
      let clock = 0;
      const sizes: number[] = [];
      let remaining = rows;
      const deleted = await purgeThreadRows(db, thread.id, {
        now: () => {
          calls += 1;
          if (calls % 2 === 0) clock += batchMs;
          return clock;
        },
        yieldToEventLoop: async () => {
          const left = countRows(db, "events", thread.id);
          sizes.push(remaining - left);
          remaining = left;
        },
      });
      expect(deleted).toBe(rows);
      expect(countRows(db, "events", thread.id)).toBe(0);
      return sizes;
    }

    expect((await batchSizes(5000, 1)).slice(0, 5)).toEqual([
      200, 400, 800, 1600, 2000,
    ]);
    expect((await batchSizes(700, 200)).slice(0, 5)).toEqual([
      200, 100, 50, 50, 50,
    ]);
  });

  it("keeps the batch size near the time target", () => {
    expect(nextThreadPurgeBatchSize(400, 100, 50)).toBe(200);
    expect(nextThreadPurgeBatchSize(400, 25, 50)).toBe(800);
    expect(nextThreadPurgeBatchSize(400, 50, 50)).toBe(400);
    expect(nextThreadPurgeBatchSize(60, 1000, 50)).toBe(50);
    expect(nextThreadPurgeBatchSize(1500, 0, 50)).toBe(2000);
  });

  it("only reports a backlog above one batch", () => {
    const { db, thread } = setup();
    seedRows(db, thread.id, 1001, 0);
    expect(hasThreadPurgeBacklog(db, thread.id, 1000)).toBe(true);
    expect(hasThreadPurgeBacklog(db, thread.id, 1001)).toBe(false);
  });
});
