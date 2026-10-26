import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { noopNotifier } from "../src/notifier.js";
import {
  archiveThread,
  createEnvironment,
  createProject,
  createThread,
  environmentHasLiveThreads,
  judgeLegacyUnreleasedEnvironment,
  listEnvironmentReleaseConsents,
  listUnreleasedEnvironmentThreadIds,
  markThreadDeleted,
  migrate,
  unarchiveThread,
  upsertHost,
  FAILED_CREATE_RELEASE_ACTOR,
  SYSTEM_RELEASE_ACTOR,
} from "../src/index.js";
import { createMigratedConnection } from "../src/testing.js";
import {
  dropEnvironmentRetentionSchema,
  dropLegacyUnreleasedEnvironments,
} from "./helpers/rewind.js";
import {
  environmentReleaseConsents,
  forkLegacyUnreleasedEnvironments,
  threads,
} from "../src/schema.js";

const MIGRATION_WHEN = 1792744408107;
const LEGACY_MARKER_MIGRATION_WHEN = 1793035087043;

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "host" });
  const { project } = createProject(db, noopNotifier, {
    name: "project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/project" },
  });
  const environment = createEnvironment(db, noopNotifier, {
    projectId: project.id,
    hostId: host.id,
    path: "/tmp/project-env",
    providerOwnsPath: true,
    status: "ready",
  });
  const thread = () =>
    createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "provider",
      status: "idle",
      environmentId: environment.id,
    });
  return { db, environment, thread };
}

describe("environment release consents", () => {
  it.each([
    ["user", { kind: "user", threadId: null }],
    ["self", { kind: "self", threadId: "thr_self" }],
    ["coordinator", { kind: "coordinator", threadId: "thr_parent" }],
    ["system", SYSTEM_RELEASE_ACTOR],
    ["failed create", FAILED_CREATE_RELEASE_ACTOR],
  ] as const)("records an archive by the %s with the actor", (_name, actor) => {
    const { db, environment, thread } = setup();
    const archived = thread();
    expect(listUnreleasedEnvironmentThreadIds(db, environment.id)).toEqual([
      archived.id,
    ]);

    archiveThread(db, noopNotifier, archived.id, actor);

    expect(listUnreleasedEnvironmentThreadIds(db, environment.id)).toEqual([]);
    expect(listEnvironmentReleaseConsents(db, environment.id)).toMatchObject([
      {
        environmentId: environment.id,
        threadId: archived.id,
        actorKind: actor.kind,
        actorThreadId: actor.threadId,
      },
    ]);
  });

  it.each([
    ["user", { kind: "user", threadId: null }],
    ["self", { kind: "self", threadId: "thr_self" }],
    ["coordinator", { kind: "coordinator", threadId: "thr_parent" }],
    ["system", SYSTEM_RELEASE_ACTOR],
    ["failed create", FAILED_CREATE_RELEASE_ACTOR],
  ] as const)("records a delete by the %s with the actor", (_name, actor) => {
    const { db, environment, thread } = setup();
    const deleted = thread();

    markThreadDeleted(db, noopNotifier, {
      threadId: deleted.id,
      release: actor,
    });

    expect(listUnreleasedEnvironmentThreadIds(db, environment.id)).toEqual([]);
    expect(listEnvironmentReleaseConsents(db, environment.id)).toMatchObject([
      { threadId: deleted.id, actorKind: actor.kind },
    ]);
  });

  it("does not count a thread that was archived without a record, and withdraws the release on unarchive", () => {
    const { db, environment, thread } = setup();
    const raw = thread();
    db.update(threads)
      .set({ archivedAt: Date.now() })
      .where(eq(threads.id, raw.id))
      .run();
    expect(listUnreleasedEnvironmentThreadIds(db, environment.id)).toEqual([
      raw.id,
    ]);

    const archived = thread();
    archiveThread(db, noopNotifier, archived.id, {
      kind: "user",
      threadId: null,
    });
    expect(listUnreleasedEnvironmentThreadIds(db, environment.id)).toEqual([
      raw.id,
    ]);

    expect(unarchiveThread(db, noopNotifier, archived.id)).not.toBeNull();
    expect(
      listUnreleasedEnvironmentThreadIds(db, environment.id).sort(),
    ).toEqual([raw.id, archived.id].sort());
  });

  it("records no consent for an archive that passes no release, and leaves the thread unreleased", () => {
    const { db, environment, thread } = setup();
    const archived = thread();

    archiveThread(db, noopNotifier, archived.id, null);

    expect(listEnvironmentReleaseConsents(db, environment.id)).toEqual([]);
    expect(listUnreleasedEnvironmentThreadIds(db, environment.id)).toEqual([
      archived.id,
    ]);
  });

  it("records no consent for a delete that passes no release, and leaves the thread unreleased", () => {
    const { db, environment, thread } = setup();
    const deleted = thread();

    markThreadDeleted(db, noopNotifier, {
      release: null,
      threadId: deleted.id,
    });

    expect(listEnvironmentReleaseConsents(db, environment.id)).toEqual([]);
    expect(listUnreleasedEnvironmentThreadIds(db, environment.id)).toEqual([
      deleted.id,
    ]);
  });

  it("cannot be made to grant consent by leaving the release out of an archive or a delete", () => {
    const { db, environment, thread } = setup();
    const archived = thread();
    const deleted = thread();

    Reflect.apply(archiveThread, undefined, [db, noopNotifier, archived.id]);
    Reflect.apply(markThreadDeleted, undefined, [
      db,
      noopNotifier,
      { threadId: deleted.id },
    ]);

    expect(listEnvironmentReleaseConsents(db, environment.id)).toEqual([]);
    expect(
      listUnreleasedEnvironmentThreadIds(db, environment.id).sort(),
    ).toEqual([archived.id, deleted.id].sort());
  });

  it("releases only the threads that were archived, not their siblings on the environment", () => {
    const { db, environment, thread } = setup();
    const first = thread();
    const second = thread();

    archiveThread(db, noopNotifier, first.id, { kind: "user", threadId: null });

    expect(listUnreleasedEnvironmentThreadIds(db, environment.id)).toEqual([
      second.id,
    ]);
  });

  describe("threads archived or deleted before migration 0148", () => {
    function migrateLegacyThreads(
      db: ReturnType<typeof setup>["db"],
      archived: readonly { id: string }[],
      deleted: readonly { id: string }[],
    ) {
      for (const thread of archived)
        db.update(threads)
          .set({ archivedAt: 5_000 })
          .where(eq(threads.id, thread.id))
          .run();
      for (const thread of deleted)
        db.update(threads)
          .set({ deletedAt: 6_000 })
          .where(eq(threads.id, thread.id))
          .run();
      db.delete(environmentReleaseConsents).run();
      db.$client
        .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
        .run(MIGRATION_WHEN);
      dropEnvironmentRetentionSchema(db);
      migrate(db);
    }

    it("stays unreleased and kept when its environment is shared with a live thread", () => {
      const { db, environment, thread } = setup();
      const archivedBefore = thread();
      const liveBefore = thread();

      migrateLegacyThreads(db, [archivedBefore], []);

      expect(listEnvironmentReleaseConsents(db, environment.id)).toEqual([]);
      expect(
        listUnreleasedEnvironmentThreadIds(db, environment.id).sort(),
      ).toEqual([archivedBefore.id, liveBefore.id].sort());
    });

    it("stays unreleased and kept when its environment is not shared", () => {
      const { db, environment, thread } = setup();
      const archivedBefore = thread();
      const deletedBefore = thread();

      migrateLegacyThreads(db, [archivedBefore], [deletedBefore]);

      expect(listEnvironmentReleaseConsents(db, environment.id)).toEqual([]);
      expect(
        listUnreleasedEnvironmentThreadIds(db, environment.id).sort(),
      ).toEqual([archivedBefore.id, deletedBefore.id].sort());
    });

    it("gives consent to a thread archived after the migration while the legacy one stays unreleased", () => {
      const { db, environment, thread } = setup();
      const archivedBefore = thread();
      const archivedAfter = thread();
      migrateLegacyThreads(db, [archivedBefore], []);

      archiveThread(db, noopNotifier, archivedAfter.id, {
        kind: "user",
        threadId: null,
      });

      expect(listEnvironmentReleaseConsents(db, environment.id)).toMatchObject([
        { threadId: archivedAfter.id, actorKind: "user" },
      ]);
      expect(listUnreleasedEnvironmentThreadIds(db, environment.id)).toEqual([
        archivedBefore.id,
      ]);
    });
  });
});

describe("the release of a whole thread tree", () => {
  const user = { kind: "user", threadId: null } as const;

  function treeFixture() {
    const { db, environment, thread } = setup();
    const create = (relation: {
      parentThreadId?: string;
      lifecycleOwnerThreadId?: string;
    }) =>
      createThread(db, noopNotifier, {
        projectId: environment.projectId,
        providerId: "provider",
        status: "idle",
        environmentId: environment.id,
        ...relation,
      });
    return { db, environment, thread, create };
  }

  function expectTreeReleasedAndLiveThreadBlocking(
    db: ReturnType<typeof setup>["db"],
    environmentId: string,
    released: readonly string[],
    live: string,
  ) {
    const consents = listEnvironmentReleaseConsents(db, environmentId);
    expect(consents.map((row) => row.threadId).sort()).toEqual(
      [...released].sort(),
    );
    expect(consents.every((row) => row.actorKind === "user")).toBe(true);
    expect(consents.map((row) => row.threadId)).not.toContain(live);
    expect(listUnreleasedEnvironmentThreadIds(db, environmentId)).toEqual([
      live,
    ]);
    expect(environmentHasLiveThreads(db, environmentId)).toBe(true);
  }

  it("records a release for the parent, child and grandchild of an archive, and the unrelated live thread on the environment keeps blocking its removal", () => {
    const { db, environment, thread, create } = treeFixture();
    const parent = thread();
    const child = create({ lifecycleOwnerThreadId: parent.id });
    const grandchild = create({ lifecycleOwnerThreadId: child.id });
    const live = thread();

    archiveThread(db, noopNotifier, parent.id, user);

    expectTreeReleasedAndLiveThreadBlocking(
      db,
      environment.id,
      [parent.id, child.id, grandchild.id],
      live.id,
    );
  });

  it("records a release for the parent, child and grandchild of a delete, and the unrelated live thread on the environment keeps blocking its removal", () => {
    const { db, environment, thread, create } = treeFixture();
    const parent = thread();
    const child = create({ parentThreadId: parent.id });
    const grandchild = create({ lifecycleOwnerThreadId: child.id });
    const live = thread();

    markThreadDeleted(db, noopNotifier, { threadId: parent.id, release: user });

    expectTreeReleasedAndLiveThreadBlocking(
      db,
      environment.id,
      [parent.id, child.id, grandchild.id],
      live.id,
    );
  });
});

describe("the legacy unreleased environment marker (migration 0150)", () => {
  const user = { kind: "user", threadId: null } as const;

  function setupTwo() {
    const base = setup();
    const second = createEnvironment(base.db, noopNotifier, {
      projectId: base.environment.projectId,
      hostId: base.environment.hostId,
      path: "/tmp/project-env-2",
      providerOwnsPath: true,
      status: "ready",
    });
    const empty = createEnvironment(base.db, noopNotifier, {
      projectId: base.environment.projectId,
      hostId: base.environment.hostId,
      path: "/tmp/project-env-empty",
      providerOwnsPath: true,
      status: "ready",
    });
    const secondThread = () =>
      createThread(base.db, noopNotifier, {
        projectId: base.environment.projectId,
        providerId: "provider",
        status: "idle",
        environmentId: second.id,
      });
    return { ...base, second, empty, secondThread };
  }

  function rerunMigration0150(db: ReturnType<typeof setup>["db"]): void {
    dropLegacyUnreleasedEnvironments(db);
    db.$client
      .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
      .run(LEGACY_MARKER_MIGRATION_WHEN);
    migrate(db);
  }

  function markers(db: ReturnType<typeof setup>["db"]): string[] {
    return db
      .select({ id: forkLegacyUnreleasedEnvironments.environmentId })
      .from(forkLegacyUnreleasedEnvironments)
      .all()
      .map((row) => row.id)
      .sort();
  }

  it("records no marker on a fresh database", () => {
    const { db } = setup();
    expect(markers(db)).toEqual([]);
  });

  it("marks exactly the environments with a thread that has no consent, once", () => {
    const { db, environment, second, empty, thread, secondThread } = setupTwo();
    thread();
    const releasedThread = secondThread();
    archiveThread(db, noopNotifier, releasedThread.id, user);
    expect(markers(db)).toEqual([]);

    rerunMigration0150(db);

    expect(markers(db)).toEqual([environment.id]);
    expect(markers(db)).not.toContain(second.id);
    expect(markers(db)).not.toContain(empty.id);
    rerunMigration0150(db);
    expect(markers(db)).toEqual([environment.id]);
  });

  it("marks an environment that has both a released and an unreleased thread", () => {
    const { db, environment, thread } = setup();
    const released = thread();
    thread();
    archiveThread(db, noopNotifier, released.id, user);

    rerunMigration0150(db);

    expect(markers(db)).toEqual([environment.id]);
  });

  it("stamps every marker with the time the migration ran", () => {
    const { db, thread } = setup();
    thread();
    const before = Date.now();

    rerunMigration0150(db);

    const rows = db.select().from(forkLegacyUnreleasedEnvironments).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recordedAt).toBeGreaterThan(before - 2_000);
    expect(rows[0]?.recordedAt).toBeLessThanOrEqual(Date.now());
  });

  it("removes the marker with its environment", () => {
    const { db, environment, thread } = setup();
    thread();
    rerunMigration0150(db);
    db.$client.pragma("foreign_keys = ON");
    db.$client
      .prepare("DELETE FROM environments WHERE id = ?")
      .run(environment.id);
    expect(markers(db)).toEqual([]);
  });

  describe("judging whether an unreleased environment is legacy", () => {
    function legacyFixture(
      archivedAt: number | null,
      deletedAt: number | null,
    ) {
      const { db, environment, thread } = setup();
      const old = thread();
      db.update(threads)
        .set({ archivedAt, deletedAt })
        .where(eq(threads.id, old.id))
        .run();
      rerunMigration0150(db);
      const recordedAt = db
        .select()
        .from(forkLegacyUnreleasedEnvironments)
        .get()?.recordedAt;
      if (recordedAt === undefined) throw new Error("no marker recorded");
      return { db, environment, thread, old, recordedAt };
    }

    it("is legacy when every unreleased thread was archived or deleted before the migration ran", () => {
      const { db, environment, old } = legacyFixture(5_000, null);
      expect(
        judgeLegacyUnreleasedEnvironment(db, environment.id),
      ).toMatchObject({ legacy: true, threadIds: [old.id] });
    });

    it("is legacy for a thread deleted before the migration ran", () => {
      const { db, environment, old } = legacyFixture(null, 6_000);
      expect(
        judgeLegacyUnreleasedEnvironment(db, environment.id),
      ).toMatchObject({ legacy: true, threadIds: [old.id] });
    });

    it("is not legacy without a marker", () => {
      const { db, environment, thread } = setup();
      const old = thread();
      db.update(threads)
        .set({ archivedAt: 5_000 })
        .where(eq(threads.id, old.id))
        .run();
      expect(judgeLegacyUnreleasedEnvironment(db, environment.id)).toEqual({
        legacy: false,
        reason: "no-marker",
      });
    });

    it("is not legacy when an unreleased thread was archived after the migration ran", () => {
      const { db, environment, thread, recordedAt } = legacyFixture(
        5_000,
        null,
      );
      const later = thread();
      db.update(threads)
        .set({ archivedAt: recordedAt + 1 })
        .where(eq(threads.id, later.id))
        .run();
      expect(judgeLegacyUnreleasedEnvironment(db, environment.id)).toEqual({
        legacy: false,
        reason: "archived-or-deleted-after-install",
      });
    });

    it("is not legacy when the thread was archived at the very moment the migration ran", () => {
      const { db, environment, old, recordedAt } = legacyFixture(5_000, null);
      db.update(threads)
        .set({ archivedAt: recordedAt })
        .where(eq(threads.id, old.id))
        .run();
      expect(
        judgeLegacyUnreleasedEnvironment(db, environment.id),
      ).toMatchObject({ legacy: false });
    });

    it("is not legacy when a thread archived before the migration was deleted after it without a release", () => {
      const { db, environment, old, recordedAt } = legacyFixture(5_000, null);
      db.update(threads)
        .set({ deletedAt: recordedAt + 10 })
        .where(eq(threads.id, old.id))
        .run();
      expect(judgeLegacyUnreleasedEnvironment(db, environment.id)).toEqual({
        legacy: false,
        reason: "archived-or-deleted-after-install",
      });
    });

    it("is not legacy while an unreleased thread is neither archived nor deleted", () => {
      const { db, environment, thread } = legacyFixture(5_000, null);
      thread();
      expect(judgeLegacyUnreleasedEnvironment(db, environment.id)).toEqual({
        legacy: false,
        reason: "thread-not-archived-or-deleted",
      });
    });

    it("does not count a thread released after the migration ran against the environment", () => {
      const { db, environment, thread } = legacyFixture(5_000, null);
      const later = thread();
      archiveThread(db, noopNotifier, later.id, user);
      expect(
        judgeLegacyUnreleasedEnvironment(db, environment.id),
      ).toMatchObject({ legacy: true });
    });
  });
});
