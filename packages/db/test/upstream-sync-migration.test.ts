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
    createdAt: 1792744408107,
    hash: "aa4279a346076d1f979c5b36717866dc7d3e73fa43052445cb1509a5b93f8d0d",
  },
  {
    createdAt: 1792782930987,
    hash: "64a2e5dd1f2ef5c3f824e38d90f3f924550aecc841da7eb04856772a4d5b4c22",
  },
  {
    createdAt: 1793035087043,
    hash: "6014ac333ee4f1ce8663664fad33279012f8bf68209589b35b74bc5ad6c5a443",
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
      const seededAt = Date.now();
      live.$client.exec(`
        INSERT INTO hosts (id, name, type, created_at, updated_at) VALUES ('host_seed', 'seed', 'local', ${seededAt}, ${seededAt});
        INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj_seed', 'seed', ${seededAt}, ${seededAt});
        INSERT INTO environments (id, project_id, host_id, status, created_at, updated_at) VALUES ('env_seed', 'proj_seed', 'host_seed', 'ready', ${seededAt}, ${seededAt});
        INSERT INTO environments (id, project_id, host_id, status, created_at, updated_at) VALUES ('env_bare', 'proj_seed', 'host_seed', 'ready', ${seededAt}, ${seededAt});
        INSERT INTO threads (id, project_id, environment_id, provider_id, status, archived_at, latest_attention_at, created_at, updated_at) VALUES ('thr_seed_a', 'proj_seed', 'env_seed', 'provider', 'idle', 5000, ${seededAt}, ${seededAt}, ${seededAt});
        INSERT INTO threads (id, project_id, environment_id, provider_id, status, archived_at, latest_attention_at, created_at, updated_at) VALUES ('thr_seed_b', 'proj_seed', 'env_seed', 'provider', 'idle', 6000, ${seededAt}, ${seededAt}, ${seededAt});
      `);
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
      const markers = live.$client
        .prepare(
          "SELECT environment_id AS environmentId, recorded_at AS recordedAt FROM fork_legacy_unreleased_environments",
        )
        .all() as { environmentId: string; recordedAt: number }[];
      expect(markers.map((marker) => marker.environmentId)).toEqual([
        "env_seed",
      ]);
      expect(markers[0]?.recordedAt).toBeGreaterThanOrEqual(
        seededAt - (seededAt % 1000),
      );
      expect(markers[0]?.recordedAt).toBeLessThanOrEqual(Date.now());
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
