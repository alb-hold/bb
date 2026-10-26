import { and, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import type { DbConnection, DbTransaction } from "../connection.js";
import { createEnvironmentReleaseConsentId } from "../ids.js";
import {
  environmentReleaseConsents,
  forkLegacyUnreleasedEnvironments,
  threads,
} from "../schema.js";

type ConsentConnection = DbConnection | DbTransaction;
export type EnvironmentReleaseConsentRow =
  typeof environmentReleaseConsents.$inferSelect;
export type EnvironmentReleaseActorKind =
  EnvironmentReleaseConsentRow["actorKind"];

export interface EnvironmentReleaseActor {
  kind: EnvironmentReleaseActorKind;
  threadId: string | null;
}

export const SYSTEM_RELEASE_ACTOR: EnvironmentReleaseActor = {
  kind: "system",
  threadId: null,
};

export const FAILED_CREATE_RELEASE_ACTOR: EnvironmentReleaseActor = {
  kind: "system:failed-create",
  threadId: null,
};

export function recordThreadEnvironmentReleases(
  db: ConsentConnection,
  threadIds: readonly string[],
  actor: EnvironmentReleaseActor,
): void {
  if (threadIds.length === 0) return;
  const rows = db
    .select({ id: threads.id, environmentId: threads.environmentId })
    .from(threads)
    .where(
      and(
        inArray(threads.id, [...threadIds]),
        isNotNull(threads.environmentId),
      ),
    )
    .all();
  const now = Date.now();
  for (const row of rows) {
    if (row.environmentId === null) continue;
    db.insert(environmentReleaseConsents)
      .values({
        id: createEnvironmentReleaseConsentId(),
        environmentId: row.environmentId,
        threadId: row.id,
        actorKind: actor.kind,
        actorThreadId: actor.threadId,
        grantedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          environmentReleaseConsents.environmentId,
          environmentReleaseConsents.threadId,
        ],
        set: {
          actorKind: actor.kind,
          actorThreadId: actor.threadId,
          grantedAt: now,
        },
      })
      .run();
  }
}

export function revokeThreadEnvironmentReleases(
  db: ConsentConnection,
  threadId: string,
): void {
  db.delete(environmentReleaseConsents)
    .where(eq(environmentReleaseConsents.threadId, threadId))
    .run();
}

export function listUnreleasedEnvironmentThreadIds(
  db: ConsentConnection,
  environmentId: string,
): string[] {
  return db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.environmentId, environmentId),
        notInArray(
          threads.id,
          db
            .select({ id: environmentReleaseConsents.threadId })
            .from(environmentReleaseConsents)
            .where(eq(environmentReleaseConsents.environmentId, environmentId)),
        ),
      ),
    )
    .all()
    .map((row) => row.id);
}

export function listEnvironmentReleaseConsents(
  db: ConsentConnection,
  environmentId: string,
): EnvironmentReleaseConsentRow[] {
  return db
    .select()
    .from(environmentReleaseConsents)
    .where(eq(environmentReleaseConsents.environmentId, environmentId))
    .all();
}

export type LegacyUnreleasedVerdict =
  | { legacy: true; recordedAt: number; threadIds: string[] }
  | {
      legacy: false;
      reason:
        | "no-marker"
        | "thread-not-archived-or-deleted"
        | "archived-or-deleted-after-install";
    };

function stampedBefore(stamp: number | null, recordedAt: number): boolean {
  return stamp === null || stamp < recordedAt;
}

export function judgeLegacyUnreleasedEnvironment(
  db: ConsentConnection,
  environmentId: string,
): LegacyUnreleasedVerdict {
  const marker = db
    .select({ recordedAt: forkLegacyUnreleasedEnvironments.recordedAt })
    .from(forkLegacyUnreleasedEnvironments)
    .where(eq(forkLegacyUnreleasedEnvironments.environmentId, environmentId))
    .get();
  if (marker === undefined) return { legacy: false, reason: "no-marker" };
  const unreleased = db
    .select({
      id: threads.id,
      archivedAt: threads.archivedAt,
      deletedAt: threads.deletedAt,
    })
    .from(threads)
    .where(
      and(
        eq(threads.environmentId, environmentId),
        notInArray(
          threads.id,
          db
            .select({ id: environmentReleaseConsents.threadId })
            .from(environmentReleaseConsents)
            .where(eq(environmentReleaseConsents.environmentId, environmentId)),
        ),
      ),
    )
    .all();
  for (const thread of unreleased) {
    if (thread.archivedAt === null && thread.deletedAt === null) {
      return { legacy: false, reason: "thread-not-archived-or-deleted" };
    }
    if (
      !stampedBefore(thread.archivedAt, marker.recordedAt) ||
      !stampedBefore(thread.deletedAt, marker.recordedAt)
    ) {
      return { legacy: false, reason: "archived-or-deleted-after-install" };
    }
  }
  return {
    legacy: true,
    recordedAt: marker.recordedAt,
    threadIds: unreleased.map((thread) => thread.id),
  };
}
