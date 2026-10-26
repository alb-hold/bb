import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  buildPinnedRootThreadListEnrichmentScope,
  buildProjectThreadListEnrichmentScope,
  buildThreadListEnrichmentScope,
  createConnection,
  createProject,
  listActiveBackgroundTaskCountsByScope,
  listLatestThreadStateEventRowsByScope,
  listQueuedThreadMessageCountsByScope,
  listThreadRowStatesByScope,
  listThreadsWithPendingInteractionState,
  migrate,
  noopNotifier,
  upsertHost,
  type DbConnection,
  type ThreadListEnrichmentScope,
} from "../src/index.js";

const connections: DbConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.$client.close();
});

function measureScopeQueries(kind: string, size: number): number {
  const db = createConnection(":memory:");
  connections.push(db);
  migrate(db);
  const host = upsertHost(db, noopNotifier, { name: `scope-host-${kind}` });
  const { project } = createProject(db, noopNotifier, {
    name: `scope-project-${kind}`,
    source: {
      type: "local_path",
      hostId: host.id,
      path: `/tmp/scope-${kind}`,
    },
  });
  const insertThread = db.$client.prepare(`
    INSERT INTO threads (
      id, project_id, provider_id, status, visibility, latest_attention_at,
      created_at, updated_at, pinned_at, pin_sort_key
    ) VALUES (?, ?, 'codex', 'idle', 'visible', 1, 1, 1, 1, ?)
  `);
  for (let index = 0; index < size; index += 1) {
    insertThread.run(`thread-${kind}-${index}`, project.id, `pin-${index}`);
  }
  const threadIds = Array.from(
    { length: size },
    (_, index) => `thread-${kind}-${index}`,
  );
  const bindings: number[] = [];
  const originalPrepare = db.$client.prepare.bind(db.$client);
  db.$client.prepare = ((source: string) => {
    const statement = originalPrepare(source);
    const methods = statement as unknown as Record<
      "all" | "get" | "run" | "iterate",
      (...params: unknown[]) => unknown
    >;
    for (const method of ["all", "get", "run", "iterate"] as const) {
      const original = methods[method].bind(statement);
      methods[method] = (...params: unknown[]) => {
        bindings.push(params.length);
        return original(...params);
      };
    }
    return statement;
  }) as typeof db.$client.prepare;
  let scope: ThreadListEnrichmentScope;
  switch (kind) {
    case "GET list":
      scope = buildThreadListEnrichmentScope(db, {
        includeHidden: true,
        limit: size,
      });
      break;
    case "search":
      scope = {
        kind: "ids",
        ids: threadIds,
      };
      break;
    case "projects":
      scope = buildProjectThreadListEnrichmentScope(db, {
        archived: false,
        projectIds: [project.id],
      });
      break;
    default:
      scope = buildPinnedRootThreadListEnrichmentScope(db);
  }
  listLatestThreadStateEventRowsByScope(db, {
    scope,
    kind: "provider-codex/goal",
  });
  listActiveBackgroundTaskCountsByScope(db, scope);
  listQueuedThreadMessageCountsByScope(db, scope);
  listThreadRowStatesByScope(db, scope);
  return bindings.reduce((sum, count) => sum + count, 0);
}

describe("thread list enrichment scopes", () => {
  it.each(["GET list", "search", "projects", "pinned roots"])(
    "keeps %s enrichment binds constant for 10 and 300 threads",
    (kind) => {
      expect(measureScopeQueries(kind, 300)).toBe(
        measureScopeQueries(kind, 10),
      );
    },
  );

  it("keeps the selected page IDs when the scope applies limit and offset", () => {
    const db = createConnection(":memory:");
    connections.push(db);
    migrate(db);
    const host = upsertHost(db, noopNotifier, { name: "scope-page-host" });
    const { project } = createProject(db, noopNotifier, {
      name: "scope-page-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/scope-page",
      },
    });
    const insertThread = db.$client.prepare(`
      INSERT INTO threads (
        id, project_id, provider_id, status, visibility, latest_attention_at,
        created_at, updated_at
      ) VALUES (?, ?, 'codex', 'idle', 'visible', 1, ?, ?)
    `);
    for (let index = 0; index < 30; index += 1) {
      insertThread.run(`thread-page-${index}`, project.id, index, index);
    }
    const options = { includeHidden: true, limit: 7, offset: 5 };
    const pageIds = listThreadsWithPendingInteractionState(db, options).map(
      (thread) => thread.id,
    );
    const scope = buildThreadListEnrichmentScope(db, options);
    const scopeIds = db
      .all<{ id: string }>(sql`SELECT scoped.id FROM (${scope.ids}) AS scoped`)
      .map((row) => row.id);
    expect(scopeIds).toEqual(pageIds);
  });
});
