import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { areHostPathsEqual, isHostPathWithin } from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import {
  createEnvironmentRetentionId,
  createEnvironmentRetentionTransitionId,
} from "../ids.js";
import {
  environmentRetentions,
  environmentRetentionTransitions,
} from "../schema.js";

type RetentionConnection = DbConnection | DbTransaction;
export type EnvironmentRetentionRow = typeof environmentRetentions.$inferSelect;
export type EnvironmentRetentionState = EnvironmentRetentionRow["state"];
export type EnvironmentRetentionTransitionRow =
  typeof environmentRetentionTransitions.$inferSelect;

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

function logTransition(
  db: RetentionConnection,
  row: Pick<
    EnvironmentRetentionRow,
    "id" | "environmentId" | "hostId" | "keptPath"
  >,
  fromState: string | null,
  toState: string,
  detail: string,
): void {
  db.insert(environmentRetentionTransitions)
    .values({
      id: createEnvironmentRetentionTransitionId(),
      retentionId: row.id,
      environmentId: row.environmentId,
      hostId: row.hostId,
      fromState,
      toState,
      path: row.keptPath,
      detail,
      at: Date.now(),
    })
    .run();
}

function removePathlessRows(
  db: RetentionConnection,
  environmentId: string,
  reason: string,
): void {
  const pathless = db
    .select()
    .from(environmentRetentions)
    .where(
      and(
        eq(environmentRetentions.environmentId, environmentId),
        isNull(environmentRetentions.keptPath),
        eq(environmentRetentions.state, "intent"),
      ),
    )
    .all();
  for (const row of pathless) {
    logTransition(db, row, row.state, "merged", reason);
    db.delete(environmentRetentions)
      .where(eq(environmentRetentions.id, row.id))
      .run();
  }
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
  let result: EnvironmentRetentionRow;
  if (existing !== undefined) {
    if (existing.state === "released_by_owner") return existing;
    if (existing.state !== "closed" && existing.state !== "intent") {
      if (input.state === "intent") return existing;
      if (existing.state === "unresolved" && input.state === "retained")
        return existing;
    }
    if (existing.state === input.state && existing.state !== "closed")
      return existing;
    result = db
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
    logTransition(db, result, existing.state, input.state, input.message);
  } else {
    result = db
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
    logTransition(db, result, null, input.state, input.message);
  }
  if (input.keptPath !== null)
    removePathlessRows(
      db,
      input.environmentId,
      `merged into the row for ${input.keptPath}`,
    );
  return result;
}

export function markEnvironmentRetentionsUnresolved(
  db: RetentionConnection,
  environmentId: string,
  message: string,
): void {
  const intents = db
    .select()
    .from(environmentRetentions)
    .where(
      and(
        eq(environmentRetentions.environmentId, environmentId),
        eq(environmentRetentions.state, "intent"),
      ),
    )
    .all();
  for (const row of intents) {
    db.update(environmentRetentions)
      .set({ state: "unresolved", message, updatedAt: Date.now() })
      .where(eq(environmentRetentions.id, row.id))
      .run();
    logTransition(db, row, "intent", "unresolved", message);
  }
  const hasPathRow = db
    .select({ keptPath: environmentRetentions.keptPath })
    .from(environmentRetentions)
    .where(
      and(
        eq(environmentRetentions.environmentId, environmentId),
        inArray(environmentRetentions.state, BLOCKING_STATES),
      ),
    )
    .all()
    .some((row) => row.keptPath !== null);
  if (hasPathRow)
    for (const row of intents) {
      if (row.keptPath !== null) continue;
      logTransition(
        db,
        row,
        "unresolved",
        "merged",
        "merged into the row that has a path",
      );
      db.delete(environmentRetentions)
        .where(eq(environmentRetentions.id, row.id))
        .run();
    }
}

export function deleteEnvironmentRetentionIntents(
  db: RetentionConnection,
  environmentId: string,
  reason = "the create reported that nothing was kept",
): void {
  const intents = db
    .select()
    .from(environmentRetentions)
    .where(
      and(
        eq(environmentRetentions.environmentId, environmentId),
        eq(environmentRetentions.state, "intent"),
      ),
    )
    .all();
  for (const row of intents) {
    logTransition(db, row, "intent", "deleted", reason);
    db.delete(environmentRetentions)
      .where(eq(environmentRetentions.id, row.id))
      .run();
  }
}

export function closeEnvironmentRetention(
  db: RetentionConnection,
  args: { id: string; proof: string },
): boolean {
  const now = Date.now();
  const before = db
    .select()
    .from(environmentRetentions)
    .where(
      and(
        eq(environmentRetentions.id, args.id),
        inArray(environmentRetentions.state, BLOCKING_STATES),
      ),
    )
    .get();
  if (before === undefined) return false;
  db.update(environmentRetentions)
    .set({
      state: "closed",
      closedAt: now,
      closedProof: args.proof,
      updatedAt: now,
    })
    .where(eq(environmentRetentions.id, args.id))
    .run();
  logTransition(db, before, before.state, "closed", args.proof);
  return true;
}

export function listEnvironmentRetentionTransitions(
  db: RetentionConnection,
  retentionId: string,
): EnvironmentRetentionTransitionRow[] {
  return db
    .select()
    .from(environmentRetentionTransitions)
    .where(eq(environmentRetentionTransitions.retentionId, retentionId))
    .orderBy(asc(environmentRetentionTransitions.at), sql`rowid`)
    .all();
}

export function listEnvironmentRetentionTransitionsForEnvironment(
  db: RetentionConnection,
  environmentId: string,
): EnvironmentRetentionTransitionRow[] {
  return db
    .select()
    .from(environmentRetentionTransitions)
    .where(eq(environmentRetentionTransitions.environmentId, environmentId))
    .orderBy(asc(environmentRetentionTransitions.at), sql`rowid`)
    .all();
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

export function listOpenEnvironmentRetentionsForProvider(
  db: RetentionConnection,
  providerId: string,
): EnvironmentRetentionRow[] {
  return db
    .select()
    .from(environmentRetentions)
    .where(
      and(
        inArray(environmentRetentions.state, BLOCKING_STATES),
        eq(environmentRetentions.providerId, providerId),
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
