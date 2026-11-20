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
];
const addedMigrations = [
  {
    createdAt: 1792453324528,
    hash: "9fec044e3b7902083cde83067c20b03b3e71076a25bb3e6a0e56090f2a92ac3c",
  },
  {
    createdAt: 1792693676447,
    hash: "a26f91de1b18228b2739eded945ee5c7bf40886efc1a78818dee7f14a351f32d",
  },
  {
    createdAt: 1793141159432,
    hash: "3b73cc223c28a2293fc475d9bd2476673e2b64baae69b9bfe117ef9a6f03878f",
  },
  {
    createdAt: 1793478080130,
    hash: "28b8a2a205bc4a05aee1eba9aced9729930f97cac98b71a4aca279450e861d48",
  },
  {
    createdAt: 1793647846761,
    hash: "a2edda6ce9e694aee066639b02f81d2f57d7e4789c035d75a0be61633e49f214",
  },
  {
    createdAt: 1794030334993,
    hash: "3a4dc9954fe04017318810fb4665bd6ba9dfa4abdc71074ed2e7c5d7bb6fc32e",
  },
  {
    createdAt: 1794762191729,
    hash: "e04a7d094e8c6b541567f80a9ee9cd566ce54d9cace8b65d0b901bcf8389ae63",
  },
  {
    createdAt: 1794850000000,
    hash: "1ce3a6abd66762f4f34121e0135ea50b009d270e0400d2dbc1434bfd36c27f22",
  },
  {
    createdAt: 1794850000001,
    hash: "fe99416903f17d99c87cfb9a0c26861e798cccf6d65be93fada0741bda361963",
  },
  {
    createdAt: 1794850000002,
    hash: "11156322dda88868d864492e85877c973c3edf1404b3bc521d0710989a120436",
  },
  {
    createdAt: 1794850000003,
    hash: "f1329637cde53d7c05fee85a748bc6b1a74c6dd25de5b16af66e6b2bc7eec4d6",
  },
  {
    createdAt: 1794850000004,
    hash: "081722dd0217e0714a1168809f5117405d5585150f6ecaf7770ca4cc2310cd06",
  },
  {
    createdAt: 1794850000005,
    hash: "3988923282f618cff346fcc057b7eb9a5b79f6af8f39332385a898ca46660336",
  },
  {
    createdAt: 1794850000006,
    hash: "56cc25956150a5875f257d690109c2d7a042421efdc0f182df8e1f43bb6ec818",
  },
  {
    createdAt: 1794850000007,
    hash: "1253dfa5ae43984d194d94d4e518c6ca7454c8363074b091e2158067c8ece5e4",
  },
  {
    createdAt: 1794850000008,
    hash: "31f31680cf2f00fe4dbb4d26570882656a366f940a2f70f2bcbbf4c6e2232b3d",
  },
  {
    createdAt: 1794850000009,
    hash: "865ec374e7ac1cc542d6032ef7c01121abcde4580e8ea2e9ea23de04f33c57fb",
  },
  {
    createdAt: 1794850000010,
    hash: "4c8e84e29bc1778b76edc9ff5bcb60938b3e5c8e46bb395ee91a962f8741a70f",
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
  it("upgrades an ours live schema and matches a fresh migrated database", () => {
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
