import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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
  "drizzleMigrate",
  "applyDeferredDestructiveLegacyCleanup",
  "applyReorderedCleanupMigrations",
];
const MIGRATION_INVALIDATION_CALL = "bumpThreadEventOwnershipEpoch";

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassLike(node)
  );
}

function collectNodes(root: ts.Node, matches: (node: ts.Node) => boolean) {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (matches(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return found;
}

function isAsyncOrSuspending(declaration: ts.FunctionDeclaration): boolean {
  return (
    declaration.asteriskToken !== undefined ||
    (ts.getModifiers(declaration) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    ) ||
    collectNodes(
      declaration,
      (node) => ts.isAwaitExpression(node) || ts.isYieldExpression(node),
    ).length > 0
  );
}

function isCallTo(node: ts.Node, name: string): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === name
  );
}

function findMigrationRunnerViolations(sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(
    "migrate.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations: string[] = [];
  const functionsByName = new Map<string, ts.FunctionDeclaration>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      functionsByName.set(statement.name.text, statement);
    }
  }
  const migrate = functionsByName.get("migrate");
  if (!migrate?.body) {
    return ["migrate is not a top-level function declaration"];
  }
  if (isAsyncOrSuspending(migrate)) {
    violations.push("migrate is async, a generator, or awaits");
  }
  if (collectNodes(migrate.body, isFunctionLike).length > 0) {
    violations.push("migrate contains a nested function that could run later");
  }
  const guardedTry = collectNodes(migrate.body, ts.isTryStatement)
    .filter(ts.isTryStatement)
    .find(
      (statement) =>
        statement.parent === migrate.body &&
        statement.finallyBlock?.statements.some(
          (finallyStatement) =>
            ts.isExpressionStatement(finallyStatement) &&
            isCallTo(finallyStatement.expression, MIGRATION_INVALIDATION_CALL),
        ),
    );
  if (!guardedTry) {
    return [...violations, "migrate has no try whose finally forgets counts"];
  }
  for (const runner of MIGRATION_SQL_RUNNERS) {
    const declaration = functionsByName.get(runner);
    if (declaration && isAsyncOrSuspending(declaration)) {
      violations.push(`${runner} is async, a generator, or awaits`);
    }
    const references = collectNodes(
      sourceFile,
      (node) =>
        ts.isIdentifier(node) &&
        node.text === runner &&
        !ts.isImportSpecifier(node.parent) &&
        !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node),
    );
    if (references.length === 0) {
      violations.push(`${runner} is never called`);
    }
    for (const reference of references) {
      const call = reference.parent;
      const isDirectCall =
        ts.isCallExpression(call) && call.expression === reference;
      let enclosing: ts.Node | undefined = reference.parent;
      while (enclosing && !isFunctionLike(enclosing)) {
        enclosing = enclosing.parent;
      }
      const insideGuardedTry =
        reference.getStart() >= guardedTry.tryBlock.getStart() &&
        reference.getEnd() <= guardedTry.tryBlock.getEnd();
      if (!isDirectCall || enclosing !== migrate || !insideGuardedTry) {
        violations.push(
          `${runner} is used outside the guarded try of migrate, or not as a direct call`,
        );
      }
    }
  }
  return violations;
}

interface MigrationRunnerMutation {
  from: string;
  name: string;
  to: string;
}

const RUNNER_CALL = "      drizzleMigrate(db, { migrationsFolder });";
const MIGRATION_RUNNER_MUTATIONS: MigrationRunnerMutation[] = [
  {
    name: "runner deferred with queueMicrotask",
    from: RUNNER_CALL,
    to: "      queueMicrotask(() => drizzleMigrate(db, { migrationsFolder }));",
  },
  {
    name: "runner deferred with setTimeout",
    from: RUNNER_CALL,
    to: "      setTimeout(() => drizzleMigrate(db, { migrationsFolder }), 0);",
  },
  {
    name: "runner deferred with a promise callback",
    from: RUNNER_CALL,
    to: "      void Promise.resolve().then(() => drizzleMigrate(db, { migrationsFolder }));",
  },
  {
    name: "runner deferred with a function expression",
    from: RUNNER_CALL,
    to: "      process.nextTick(function later() { drizzleMigrate(db, { migrationsFolder }); });",
  },
  {
    name: "runner passed as a callback",
    from: RUNNER_CALL,
    to: "      setTimeout(drizzleMigrate, 0, db, { migrationsFolder });",
  },
  {
    name: "migrate made async with an awaited runner",
    from: "export function migrate(db: DbConnection, options: MigrateOptions = {}): void {",
    to: "export async function migrate(db: DbConnection, options: MigrateOptions = {}): Promise<void> {\n  await Promise.resolve();",
  },
  {
    name: "runner moved after the invalidation in the finally",
    from: '    sqlite.pragma("foreign_keys = ON");\n    bumpThreadEventOwnershipEpoch();',
    to: '    sqlite.pragma("foreign_keys = ON");\n    bumpThreadEventOwnershipEpoch();\n    drizzleMigrate(db, { migrationsFolder });',
  },
  {
    name: "runner called after migrate's try statement",
    from: "  warnAboutFutureAppliedMigrations(db, options);",
    to: "  applyReorderedCleanupMigrations(db, migrationsFolder);\n  warnAboutFutureAppliedMigrations(db, options);",
  },
  {
    name: "invalidation removed",
    from: '    sqlite.pragma("foreign_keys = ON");\n    bumpThreadEventOwnershipEpoch();',
    to: '    sqlite.pragma("foreign_keys = ON");',
  },
  {
    name: "runner called from another function",
    from: "export function countAppliedMigrations(db: DbConnection): number {",
    to: "export function countAppliedMigrations(db: DbConnection): number {\n  drizzleMigrate(db, { migrationsFolder: resolveMigrationsFolder() });",
  },
  {
    name: "cleanup runner made async",
    from: "function applyReorderedCleanupMigrations(",
    to: "async function applyReorderedCleanupMigrations(",
  },
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

  it("runs migration SQL only inside migrate, synchronously, before it forgets remembered counts", () => {
    const runner = sources.get(MIGRATION_RUNNER_FILE) ?? "";
    const referencingFiles = [...sources]
      .filter(([, text]) => MIGRATION_RUNNER_REFERENCES.test(text))
      .map(([file]) => file);

    expect(referencingFiles).toEqual([MIGRATION_RUNNER_FILE]);
    expect(findMigrationRunnerViolations(runner)).toEqual([]);
  });

  it.each(MIGRATION_RUNNER_MUTATIONS)(
    "rejects migrate.ts with the $name",
    ({ from, to }) => {
      const runner = sources.get(MIGRATION_RUNNER_FILE) ?? "";
      const mutated = runner.replace(from, to);

      expect(mutated).not.toBe(runner);
      expect(findMigrationRunnerViolations(mutated)).not.toEqual([]);
    },
  );

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
