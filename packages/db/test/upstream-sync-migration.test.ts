import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createConnection } from "../src/connection.js";
import { migrate } from "../src/migrate.js";
import { createMigratedConnection } from "../src/testing.js";

const liveSchemaPath = fileURLToPath(
  new URL("./fixtures/fork-live-upgrade-schema.sql", import.meta.url),
);
const oursForkMigrationWhens = [
  1792163858066, 1792183118231, 1792193667184, 1792200133276, 1792262861731,
  1793478080130, 1793647846761, 1794030334993,
];
const addedMigrations = [
  {
    createdAt: 1794030334994,
    hash: "fe99416903f17d99c87cfb9a0c26861e798cccf6d65be93fada0741bda361963",
  },
  {
    createdAt: 1794030334995,
    hash: "11156322dda88868d864492e85877c973c3edf1404b3bc521d0710989a120436",
  },
  {
    createdAt: 1794030334996,
    hash: "f1329637cde53d7c05fee85a748bc6b1a74c6dd25de5b16af66e6b2bc7eec4d6",
  },
  {
    createdAt: 1794030334997,
    hash: "081722dd0217e0714a1168809f5117405d5585150f6ecaf7770ca4cc2310cd06",
  },
  {
    createdAt: 1794030334998,
    hash: "3988923282f618cff346fcc057b7eb9a5b79f6af8f39332385a898ca46660336",
  },
  {
    createdAt: 1794030334999,
    hash: "56cc25956150a5875f257d690109c2d7a042421efdc0f182df8e1f43bb6ec818",
  },
  {
    createdAt: 1794030335000,
    hash: "1253dfa5ae43984d194d94d4e518c6ca7454c8363074b091e2158067c8ece5e4",
  },
  {
    createdAt: 1794030335001,
    hash: "31f31680cf2f00fe4dbb4d26570882656a366f940a2f70f2bcbbf4c6e2232b3d",
  },
];
const ignoredIndexName = "fork_events_item_completion_lookup_idx";

function schema(db: ReturnType<typeof createConnection>): string[] {
  return db.$client
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY type, name",
    )
    .all()
    .map((row) => {
      const value = row as { type: string; name: string; sql: string };
      return `${value.type} ${value.name} ${value.sql.replace(/\s+/g, " ").trim()}`;
    })
    .filter((entry) => !entry.includes(` ${ignoredIndexName} `));
}

function importLiveSchema(db: ReturnType<typeof createConnection>): void {
  const sql = readFileSync(liveSchemaPath, "utf8").replace(
    /^CREATE TABLE ['"]?thread_search_segments_fts_(?:data|idx|content|docsize|config)['\"]?[^;]*;\s*$/gm,
    "",
  );
  db.$client.exec(sql);
}

describe("upstream database migration reconciliation", () => {
  it("upgrades fork 0151 with exactly eight new migrations and matches a fresh database", () => {
    const live = createConnection(":memory:");
    const fresh = createMigratedConnection();
    try {
      importLiveSchema(live);
      const priorForkTables = live.$client
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fork_%' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name);
      const priorMigrationRows = live.$client
        .prepare(
          "SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at",
        )
        .all() as { hash: string; createdAt: number }[];
      expect(priorMigrationRows).toHaveLength(155);
      expect(priorMigrationRows.at(-1)?.createdAt).toBe(1794030334993);
      const priorMigrationWhens = new Set(
        priorMigrationRows.map((row) => row.createdAt),
      );

      expect(
        oursForkMigrationWhens.filter((when) => priorMigrationWhens.has(when)),
      ).toEqual(oursForkMigrationWhens);
      expect(() => migrate(live)).not.toThrow();

      const addedMigrationRows = (
        live.$client
          .prepare(
            "SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at",
          )
          .all() as { hash: string; createdAt: number }[]
      ).filter((row) => !priorMigrationWhens.has(row.createdAt));
      const forkTablesAfter = new Set(
        (
          live.$client
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fork_%' ORDER BY name",
            )
            .all() as { name: string }[]
        ).map((row) => row.name),
      );

      expect(addedMigrationRows).toEqual(addedMigrations);
      expect(
        live.$client
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'terminal_sessions_status_thread_idx'",
          )
          .get(),
      ).toEqual({ name: "terminal_sessions_status_thread_idx" });
      expect(
        priorForkTables.filter((name) => !forkTablesAfter.has(name)),
      ).toEqual([]);
      expect(schema(live)).toEqual(schema(fresh));
    } finally {
      live.$client.close();
      fresh.$client.close();
    }
  });
});
