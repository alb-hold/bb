import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

export type ThreadListEnrichmentScope =
  | { kind: "query"; ids: SQL }
  | { kind: "ids"; ids: readonly string[] };

export function threadListEnrichmentRequestedThreads(
  scope: ThreadListEnrichmentScope,
): SQL {
  return scope.kind === "query"
    ? sql`SELECT scoped.id AS column1 FROM (${scope.ids}) AS scoped`
    : sql`SELECT value AS column1 FROM json_each(${JSON.stringify(scope.ids)})`;
}

export function threadListEnrichmentScopePredicate(
  threadId: SQLWrapper,
  scope: ThreadListEnrichmentScope,
): SQL {
  return scope.kind === "query"
    ? sql`${threadId} IN (${scope.ids})`
    : sql`${threadId} IN (SELECT value FROM json_each(${JSON.stringify(scope.ids)}))`;
}
