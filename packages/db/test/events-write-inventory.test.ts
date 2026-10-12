import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const EVENTS_TABLE = String.raw`(?:(?:main|temp)\s*\.\s*)?(?:\$\{events\}|["\[]?events["\]]?)(?![\w.])`;
const EVENT_ROW_WRITE_PATTERNS = [
  /\.(?:insert|update|delete)\(\s*events\s*\)/gu,
  new RegExp(String.raw`\bINTO\s+${EVENTS_TABLE}`, "giu"),
  new RegExp(
    String.raw`\bUPDATE\s+(?:OR\s+\w+\s+)?${EVENTS_TABLE}`,
    "giu",
  ),
  new RegExp(String.raw`\bDELETE\s+FROM\s+${EVENTS_TABLE}`, "giu"),
];
const EVENT_OWNER_DELETE_PATTERNS = [
  /\.delete\(\s*(?:threads|projects)\s*\)/gu,
  /\bDELETE\s+FROM\s+"?(?:threads|projects)"?(?![\w.])/giu,
];

interface SourceRequirement {
  file: string;
  text: string;
}

interface InventoriedWrite {
  requires: SourceRequirement[];
  writes: number;
}

const PRUNING_FILE = "packages/db/src/data/thread-pruning.ts";
const PRUNING_INVALIDATION: SourceRequirement[] = [
  {
    file: PRUNING_FILE,
    text: "if (result.removed > 0 && result.threadId !== null) {",
  },
  {
    file: PRUNING_FILE,
    text: "bumpThreadEventRewriteGeneration(result.threadId);",
  },
  {
    file: PRUNING_FILE,
    text: "bumpThreadEventRewriteGenerationOutsideConversationOutline(",
  },
];

const EVENT_ROW_WRITES: Record<string, InventoriedWrite> = {
  "packages/db/src/data/events.ts": {
    writes: 3,
    requires: [
      {
        file: "packages/db/src/data/events.ts",
        text: 'if (args.itemKind === "backgroundTask") {\n    bumpBackgroundTaskAppendGeneration(args.threadId);',
      },
      {
        file: "packages/db/src/data/events.ts",
        text: "if (result.changes > 0) {\n    bumpThreadEventRewriteGeneration(args.threadId);",
      },
      ...PRUNING_INVALIDATION,
    ],
  },
  "packages/db/src/data/sweeps.ts": {
    writes: 1,
    requires: [
      {
        file: "packages/db/src/data/sweeps.ts",
        text: "bumpThreadEventRewriteGeneration(candidate.thread_id);",
      },
    ],
  },
  [PRUNING_FILE]: { writes: 1, requires: PRUNING_INVALIDATION },
  "packages/db/src/data/resolved-item-pruning.ts": {
    writes: 1,
    requires: PRUNING_INVALIDATION,
  },
  "packages/db/src/data/rate-limit-pruning.ts": {
    writes: 1,
    requires: PRUNING_INVALIDATION,
  },
  "packages/db/src/data/fork-file-change-truncation.ts": {
    writes: 1,
    requires: [
      {
        file: "packages/db/src/data/fork-file-change-truncation.ts",
        text: "WHERE item_kind = 'fileChange'",
      },
    ],
  },
  "packages/db/src/migrate.ts": {
    writes: 1,
    requires: [
      {
        file: "packages/db/src/migrate.ts",
        text: "'system/thread/interrupted',\n            NULL,\n            NULL,",
      },
    ],
  },
  "packages/scripts/src/lib/seed-perf-fixture.ts": { writes: 1, requires: [] },
};

const EVENT_OWNER_DELETES: Record<string, InventoriedWrite> = {
  "packages/db/src/data/threads.ts": {
    writes: 1,
    requires: [
      {
        file: "packages/db/src/data/threads.ts",
        text: "db.delete(threads).where(eq(threads.id, id)).run();\n  bumpThreadEventOwnershipEpoch();",
      },
    ],
  },
  "packages/db/src/data/projects.ts": {
    writes: 1,
    requires: [
      {
        file: "packages/db/src/data/projects.ts",
        text: "db.delete(projects).where(eq(projects.id, id)).run();\n  bumpThreadEventOwnershipEpoch();",
      },
    ],
  },
};

const MIGRATION_RUNNER_FILE = "packages/db/src/migrate.ts";
const MIGRATION_RUNNER_REFERENCES =
  /drizzle-orm\/(?:[\w-]+\/)?migrator|\bdrizzleMigrate\b|\breadMigrationFiles\b|\bresolveMigrationsFolder\b/u;
const MIGRATION_SQL_RUNNERS = [
  "drizzleMigrate(",
  "applyDeferredDestructiveLegacyCleanup(",
  "applyReorderedCleanupMigrations(",
];
const MIGRATION_INVALIDATION: SourceRequirement = {
  file: "packages/db/src/migrate.ts",
  text: 'sqlite.pragma("foreign_keys = ON");\n    bumpThreadEventOwnershipEpoch();',
};

const PRUNING_ONLY_WRITERS = [
  "advanceLiveEventPruning",
  "pruneRateLimitSnapshotWindow",
  "pruneContextWindowUsageEventsInTransaction",
  "pruneTokenUsageEventsInTransaction",
];

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name === "dist") {
      continue;
    }
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      files.push(...listSourceFiles(path));
    } else if (/\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name)) {
      files.push(path);
    }
  }
  return files;
}

function readSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const group of ["packages", "apps"]) {
    for (const name of readdirSync(join(repoRoot, group))) {
      const sourceDirectory = join(repoRoot, group, name, "src");
      if (!statSync(sourceDirectory, { throwIfNoEntry: false })?.isDirectory()) {
        continue;
      }
      for (const path of listSourceFiles(sourceDirectory)) {
        sources.set(
          relative(repoRoot, path).split(sep).join("/"),
          readFileSync(path, "utf8"),
        );
      }
    }
  }
  return sources;
}

function countWrites(
  sources: Map<string, string>,
  patterns: RegExp[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [file, text] of sources) {
    const count = patterns.reduce(
      (total, pattern) => total + [...text.matchAll(pattern)].length,
      0,
    );
    if (count > 0) {
      counts[file] = count;
    }
  }
  return counts;
}

function writeCounts(
  inventory: Record<string, InventoriedWrite>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(inventory).map(([file, entry]) => [file, entry.writes]),
  );
}

describe("writes that can change remembered background-task counts", () => {
  const sources = readSources();

  it("finds every statement that writes event rows in an inventoried file", () => {
    expect(countWrites(sources, EVENT_ROW_WRITE_PATTERNS)).toEqual(
      writeCounts(EVENT_ROW_WRITES),
    );
  });

  it("finds every statement that deletes the owner of event rows in an inventoried file", () => {
    expect(countWrites(sources, EVENT_OWNER_DELETE_PATTERNS)).toEqual(
      writeCounts(EVENT_OWNER_DELETES),
    );
  });

  it("keeps the invalidation or the row filter each inventoried write depends on", () => {
    const missing = [
      ...Object.values(EVENT_ROW_WRITES),
      ...Object.values(EVENT_OWNER_DELETES),
    ]
      .flatMap((entry) => entry.requires)
      .filter(
        (requirement) => !sources.get(requirement.file)?.includes(requirement.text),
      );

    expect(missing).toEqual([]);
  });

  it("runs migration SQL only inside migrate, which forgets remembered counts when it ends", () => {
    const runner = sources.get(MIGRATION_RUNNER_FILE) ?? "";
    const referencingFiles = [...sources]
      .filter(([, text]) => MIGRATION_RUNNER_REFERENCES.test(text))
      .map(([file]) => file);
    const migrateStart = runner.indexOf("export function migrate(");
    const invalidation = runner.indexOf(MIGRATION_INVALIDATION.text);
    const callsOutsideMigrate = MIGRATION_SQL_RUNNERS.flatMap((call) =>
      [...runner.matchAll(new RegExp(`(?<!function )${call.replace("(", "\\(")}`, "gu"))]
        .map((match) => match.index)
        .filter((index) => index < migrateStart || index > invalidation)
        .map(() => call),
    );

    expect(referencingFiles).toEqual([MIGRATION_RUNNER_FILE]);
    expect(migrateStart).toBeGreaterThan(-1);
    expect(invalidation).toBeGreaterThan(migrateStart);
    expect(callsOutsideMigrate).toEqual([]);
    for (const call of MIGRATION_SQL_RUNNERS) {
      expect(runner.slice(migrateStart, invalidation)).toContain(call);
    }
  });

  it("reaches the pruning deletes only through the pruning pass that invalidates", () => {
    for (const writer of PRUNING_ONLY_WRITERS) {
      const callers = [...sources]
        .filter(([, text]) => new RegExp(String.raw`\b${writer}\(`, "u").test(text))
        .map(([file]) => file)
        .filter((file) => file !== PRUNING_FILE);

      expect(callers).toHaveLength(1);
    }
  });
});
