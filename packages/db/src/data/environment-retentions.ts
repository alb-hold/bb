import { and, eq, inArray, isNull } from "drizzle-orm";
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
  originalPath: string | null;
  keptPath: string | null;
  state: "intent" | "retained" | "unresolved";
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
        input.keptPath === null
          ? isNull(environmentRetentions.keptPath)
          : eq(environmentRetentions.keptPath, input.keptPath),
      ),
    )
    .get();
  if (existing !== undefined) {
    if (existing.state === "released_by_owner") return existing;
    if (existing.state !== "closed" && existing.state !== "intent") {
      if (input.state === "intent") return existing;
      if (existing.state === "unresolved" && input.state === "retained")
        return existing;
    }
    return db
      .update(environmentRetentions)
      .set({
        state: input.state,
        message: input.message,
        closedAt: null,
        closedProof: null,
        updatedAt: now,
      })
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

export function closeEnvironmentRetention(
  db: RetentionConnection,
  args: { id: string; proof: string },
): boolean {
  const now = Date.now();
  const updated = db
    .update(environmentRetentions)
    .set({
      state: "closed",
      closedAt: now,
      closedProof: args.proof,
      updatedAt: now,
    })
    .where(
      and(
        eq(environmentRetentions.id, args.id),
        inArray(environmentRetentions.state, BLOCKING_STATES),
      ),
    )
    .returning({ id: environmentRetentions.id })
    .all();
  return updated.length > 0;
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

export function listOpenEnvironmentRetentionsForThread(
  db: RetentionConnection,
  threadId: string,
): EnvironmentRetentionRow[] {
  return db
    .select()
    .from(environmentRetentions)
    .where(
      and(
        eq(environmentRetentions.ownerThreadId, threadId),
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

export function listOpenEnvironmentRetentionsWithPath(
  db: RetentionConnection,
  providerId?: string,
): EnvironmentRetentionRow[] {
  return db
    .select()
    .from(environmentRetentions)
    .where(
      and(
        inArray(environmentRetentions.state, BLOCKING_STATES),
        providerId === undefined
          ? undefined
          : eq(environmentRetentions.providerId, providerId),
      ),
    )
    .all()
    .filter((row) => row.keptPath !== null);
}

export function findOpenEnvironmentRetentionOverlapping(
  db: RetentionConnection,
  args: { hostId: string; path: string },
): EnvironmentRetentionRow | null {
  for (const row of listOpenEnvironmentRetentionsForHost(db, args.hostId)) {
    for (const recorded of [row.keptPath, row.originalPath]) {
      if (recorded === null) continue;
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
