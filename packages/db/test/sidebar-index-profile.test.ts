import { readFileSync, mkdtempSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";

it("profiles goal lookup migration on a synthetic event table", () => {
  const dir = mkdtempSync(join(tmpdir(), "sidebar-index-profile-"));
  const volume = statfsSync(dir);
  expect(volume.bavail * volume.bsize).toBeGreaterThan(20 * 1024 ** 3);
  const db = new Database(join(dir, "events.db"));
  try {
    db.pragma("journal_mode=OFF");
    db.pragma("synchronous=OFF");
    db.exec("CREATE TABLE events(thread_id TEXT, sequence INTEGER, type TEXT, data TEXT)");
    db.exec(`
      WITH RECURSIVE numbers(n) AS (
        VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n < 30603651
      )
      INSERT INTO events
      SELECT printf('thr_%05d', n % 10280), n,
        CASE WHEN n % 1089 = 0 THEN 'thread/extensionState/updated' ELSE 'item/completed' END,
        CASE WHEN n % 1089 = 0 AND n % 7 = 0 THEN '{"kind":"provider-codex/goal"}'
        ELSE '{"text":"' || printf('%0220d', 0) || '"}' END
      FROM numbers
    `);
    const migration = readFileSync(new URL("../drizzle/0165_indexed_thread_goal_lookup.sql", import.meta.url), "utf8");
    const start = performance.now();
    db.exec(migration);
    const elapsed = performance.now() - start;
    console.log(JSON.stringify({ metric: "sidebar-goal-index-build", rows: 30603651, buildMs: elapsed, sqlitePageCount: db.pragma("page_count", { simple: true }) }));
    expect(elapsed).toBeGreaterThan(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 240_000);
