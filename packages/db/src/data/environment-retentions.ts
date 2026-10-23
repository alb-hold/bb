import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { areHostPathsEqual, isHostPathWithin } from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import { createEnvironmentRetentionId } from "../ids.js";
import { environmentRetentions } from "../schema.js";

type RetentionConnection = DbConnection | DbTransaction;
export type EnvironmentRetentionRow = typeof environmentRetentions.$inferSelect;
export type EnvironmentRetentionState = EnvironmentRetentionRow["state"];

const BLOCKING_STATES: EnvironmentRetentionState[] = [
  "intent",
  "retained",
  "unresolved",
];

export interface RecordEnvironmentRetentionInput {
  environmentId: string;
  projectId: string;
  hostId: string;
  ownerThreadId: string | null;
  providerId: string;
  originalPath: string;
  keptPath: string;
  state: Exclude<EnvironmentRetentionState, "released_by_owner">;
  message: string;
}

export function recordEnvironmentRetention(
  db: RetentionConnection,
  input: RecordEnvironmentRetentionInput,
): EnvironmentRetentionRow {
  const now = Date.now();
  const existing = db
    .select()
    .from(environmentRetentions)
    .where(
      and(
        eq(environmentRetentions.environmentId, input.environmentId),
        eq(environmentRetentions.keptPath, input.keptPath),
      ),
    )
    .get();
  if (existing !== undefined) {
    if (existing.state === "released_by_owner") return existing;
    return db
      .update(environmentRetentions)
      .set({ state: input.state, message: input.message, updatedAt: now })
      .where(eq(environmentRetentions.id, existing.id))
      .returning()
      .get();
  }
  return db
    .insert(environmentRetentions)
    .values({
      id: createEnvironmentRetentionId(),
      environmentId: input.environmentId,
      projectId: input.projectId,
      hostId: input.hostId,
      ownerThreadId: input.ownerThreadId,
      providerId: input.providerId,
      originalPath: input.originalPath,
      keptPath: input.keptPath,
      state: input.state,
      message: input.message,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function markEnvironmentRetentionsUnresolved(
  db: RetentionConnection,
  environmentId: string,
  message: string,
): void {
  db.update(environmentRetentions)
    .set({ state: "unresolved", message, updatedAt: Date.now() })
    .where(
      and(
        eq(environmentRetentions.environmentId, environmentId),
        eq(environmentRetentions.state, "intent"),
      ),
    )
    .run();
}

export function deleteEnvironmentRetentionIntents(
  db: RetentionConnection,
  environmentId: string,
): void {
  db.delete(environmentRetentions)
    .where(
      and(
        eq(environmentRetentions.environmentId, environmentId),
        eq(environmentRetentions.state, "intent"),
      ),
    )
    .run();
}

export function listOpenEnvironmentRetentionsForHost(
  db: RetentionConnection,
  hostId: string,
): EnvironmentRetentionRow[] {
  return db
    .select()
    .from(environmentRetentions)
    .where(
      and(
        eq(environmentRetentions.hostId, hostId),
        inArray(environmentRetentions.state, BLOCKING_STATES),
      ),
    )
    .all();
}

export function listOpenEnvironmentRetentionsForProject(
  db: RetentionConnection,
  projectId: string,
): EnvironmentRetentionRow[] {
  return db
    .select()
    .from(environmentRetentions)
    .where(
      and(
        eq(environmentRetentions.projectId, projectId),
        inArray(environmentRetentions.state, BLOCKING_STATES),
      ),
    )
    .all();
}

export function listOpenEnvironmentRetentionsForEnvironment(
  db: RetentionConnection,
  environmentId: string,
): EnvironmentRetentionRow[] {
  return db
    .select()
    .from(environmentRetentions)
    .where(
      and(
        eq(environmentRetentions.environmentId, environmentId),
        inArray(environmentRetentions.state, BLOCKING_STATES),
      ),
    )
    .all();
}

export function findOpenEnvironmentRetentionOverlapping(
  db: RetentionConnection,
  args: { hostId: string; path: string },
): EnvironmentRetentionRow | null {
  for (const row of listOpenEnvironmentRetentionsForHost(db, args.hostId)) {
    for (const recorded of [row.keptPath, row.originalPath]) {
      if (
        areHostPathsEqual(recorded, args.path) ||
        isHostPathWithin({ rootPath: args.path, candidatePath: recorded }) ||
        isHostPathWithin({ rootPath: recorded, candidatePath: args.path })
      )
        return row;
    }
  }
  return null;
}

export function countOpenEnvironmentRetentionsExcept(
  db: RetentionConnection,
  args: { hostId: string; environmentId: string },
): number {
  const row = db
    .select({ total: sql<number>`count(*)` })
    .from(environmentRetentions)
    .where(
      and(
        eq(environmentRetentions.hostId, args.hostId),
        ne(environmentRetentions.environmentId, args.environmentId),
        inArray(environmentRetentions.state, BLOCKING_STATES),
      ),
    )
    .get();
  return row?.total ?? 0;
}
