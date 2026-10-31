import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  copyFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate as migrateHistorical } from "drizzle-orm/better-sqlite3/migrator";
import {
  createConnection,
  migrate,
  upsertHost,
  createProject,
  createThread,
  noopNotifier,
} from "../src/index.js";
import { ensureNativeTerminalThreadsTable } from "../src/fork-native-terminal-threads.js";

function nativeRows(db: ReturnType<typeof createConnection>) {
  return db.$client
    .prepare(
      "SELECT thread_id, provider_id, native_session_id, terminal_session_id, initial_prompt, model, created_at, updated_at, initial_images FROM fork_native_terminal_threads ORDER BY thread_id",
    )
    .all();
}
function nativeIndexes(db: ReturnType<typeof createConnection>) {
  return db.$client
    .prepare("PRAGMA index_list(fork_native_terminal_threads)")
    .all();
}

describe("native clean exit schema", () => {
  it("upgrades raw 0147 table rows at 0148 without replacing data or indexes and replays safely", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-native-exit-migrations-"));
    const db = createConnection(":memory:");
    try {
      const journal = JSON.parse(
        readFileSync(
          new URL("../drizzle/meta/_journal.json", import.meta.url),
          "utf8",
        ),
      ) as { entries: { idx: number; tag: string; when: number }[] };
      journal.entries = journal.entries.filter((entry) => entry.idx <= 148);
      mkdirSync(join(directory, "meta"));
      writeFileSync(
        join(directory, "meta/_journal.json"),
        JSON.stringify(journal),
      );
      for (const entry of journal.entries) {
        copyFileSync(
          new URL(`../drizzle/${entry.tag}.sql`, import.meta.url),
          join(directory, `${entry.tag}.sql`),
        );
      }
      migrateHistorical(db, { migrationsFolder: directory });
      const host = upsertHost(db, noopNotifier, { name: "migration-host" });
      const { project } = createProject(db, noopNotifier, {
        name: "migration-project",
        source: {
          type: "local_path",
          hostId: host.id,
          path: "/tmp/native-migration",
        },
      });
      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      db.$client
        .prepare(
          "INSERT INTO fork_native_terminal_threads (thread_id, provider_id, native_session_id, initial_prompt, model, created_at, updated_at, initial_images) VALUES (?, 'codex', 'retained-session', 'retained prompt', 'retained model', 101, 202, '[]')",
        )
        .run(thread.id);
      const rows = nativeRows(db);
      const indexes = nativeIndexes(db);
      expect(() =>
        db.$client.prepare(
          "SELECT lost_idle_terminal_session_id FROM fork_native_terminal_threads",
        ),
      ).toThrow();
      migrate(db);
      ensureNativeTerminalThreadsTable(db);
      expect(nativeRows(db)).toEqual(rows);
      expect(nativeIndexes(db)).toEqual(indexes);
      expect(
        db.$client
          .prepare(
            "SELECT lost_idle_terminal_session_id FROM fork_native_terminal_threads",
          )
          .all(),
      ).toEqual([{ lost_idle_terminal_session_id: null }]);
      const schema = db.$client
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name = 'fork_native_terminal_threads'",
        )
        .get();
      migrate(db);
      ensureNativeTerminalThreadsTable(db);
      expect(nativeRows(db)).toEqual(rows);
      expect(nativeIndexes(db)).toEqual(indexes);
      expect(
        db.$client
          .prepare(
            "SELECT sql FROM sqlite_master WHERE name = 'fork_native_terminal_threads'",
          )
          .get(),
      ).toEqual(schema);
    } finally {
      db.$client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates the fork table, nullable provenance column and session index from empty", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      expect(
        db.$client
          .prepare("PRAGMA table_info(fork_native_terminal_threads)")
          .all(),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "lost_idle_terminal_session_id",
            notnull: 0,
          }),
        ]),
      );
      expect(nativeIndexes(db)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "fork_native_terminal_threads_session_idx",
            unique: 1,
          }),
        ]),
      );
    } finally {
      db.$client.close();
    }
  });
});
