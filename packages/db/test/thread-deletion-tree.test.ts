import { eq, inArray, isNotNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { noopNotifier } from "../src/notifier.js";
import {
  archiveThread,
  createEnvironment,
  createProject,
  createThread,
  listEnvironmentReleaseConsents,
  listThreadDeletionTree,
  markThreadDeleted,
  upsertHost,
} from "../src/index.js";
import { createMigratedConnection } from "../src/testing.js";
import { environmentReleaseConsents, threads } from "../src/schema.js";

function fixture() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "host" });
  const { project } = createProject(db, noopNotifier, {
    name: "project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/project" },
  });
  const make = (
    name: string,
    relation: {
      parentThreadId?: string;
      lifecycleOwnerThreadId?: string;
    } = {},
  ) => {
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      path: `/tmp/project-${name}`,
      providerOwnsPath: true,
      status: "ready",
    });
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "provider",
      status: "idle",
      environmentId: environment.id,
      ...relation,
    });
    return { thread, environment };
  };
  const parent = make("parent");
  const root = make("root", { parentThreadId: parent.thread.id });
  const lifecycleChild = make("lifecycle", {
    lifecycleOwnerThreadId: root.thread.id,
  });
  const sidebarChild = make("sidebar", { parentThreadId: root.thread.id });
  const sidebarGrandchild = make("sidebar-grandchild", {
    parentThreadId: sidebarChild.thread.id,
  });
  const archivedChild = make("archived", { parentThreadId: root.thread.id });
  archiveThread(db, noopNotifier, archivedChild.thread.id, null);
  const sibling = make("sibling", { parentThreadId: parent.thread.id });
  const unrelated = make("unrelated");
  return {
    db,
    parent,
    root,
    lifecycleChild,
    sidebarChild,
    sidebarGrandchild,
    archivedChild,
    sibling,
    unrelated,
  };
}

const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();

describe("the set of threads a delete selects", () => {
  it("is the lifecycle set plus the sidebar children and their descendants, and nothing of the parent or the siblings", () => {
    const f = fixture();
    const deletion = ids(listThreadDeletionTree(f.db, f.root.thread.id));
    expect(deletion).toEqual(
      [
        f.root.thread.id,
        f.lifecycleChild.thread.id,
        f.sidebarChild.thread.id,
        f.sidebarGrandchild.thread.id,
        f.archivedChild.thread.id,
      ].sort(),
    );
    archiveThread(f.db, noopNotifier, f.root.thread.id, null);
    const lifecycle = ids(
      f.db
        .select({ id: threads.id })
        .from(threads)
        .where(isNotNull(threads.archivedAt))
        .all(),
    ).filter((id) => id !== f.archivedChild.thread.id);
    expect(lifecycle).toEqual(
      [f.root.thread.id, f.lifecycleChild.thread.id].sort(),
    );
    expect(deletion).toEqual(expect.arrayContaining(lifecycle));
    expect(deletion.filter((id) => !lifecycle.includes(id))).toEqual(
      [
        f.sidebarChild.thread.id,
        f.sidebarGrandchild.thread.id,
        f.archivedChild.thread.id,
      ].sort(),
    );
  });

  it("records the same release for a sidebar-only child as for a lifecycle child, and deletes the whole set in one transaction", () => {
    const f = fixture();
    markThreadDeleted(f.db, noopNotifier, {
      threadId: f.root.thread.id,
      release: { kind: "user", threadId: null },
    });
    const deleted = [
      f.root,
      f.lifecycleChild,
      f.sidebarChild,
      f.sidebarGrandchild,
      f.archivedChild,
    ];
    const kept = [f.parent, f.sibling, f.unrelated];
    for (const entry of deleted) {
      expect(
        f.db
          .select({ deletedAt: threads.deletedAt })
          .from(threads)
          .where(eq(threads.id, entry.thread.id))
          .get()?.deletedAt,
      ).not.toBeNull();
      expect(
        listEnvironmentReleaseConsents(f.db, entry.environment.id).map(
          ({ threadId, actorKind, actorThreadId }) => ({
            threadId,
            actorKind,
            actorThreadId,
          }),
        ),
      ).toEqual([
        { threadId: entry.thread.id, actorKind: "user", actorThreadId: null },
      ]);
    }
    for (const entry of kept) {
      expect(
        f.db
          .select({ deletedAt: threads.deletedAt })
          .from(threads)
          .where(eq(threads.id, entry.thread.id))
          .get()?.deletedAt,
      ).toBeNull();
      expect(
        listEnvironmentReleaseConsents(f.db, entry.environment.id),
      ).toEqual([]);
    }
  });

  it("leaves no thread deleted and no consent recorded when one thread of the set is refused", () => {
    const f = fixture();
    f.db.$client.exec(
      `CREATE TRIGGER refuse_sidebar_grandchild BEFORE INSERT ON environment_release_consents WHEN NEW.thread_id = '${f.sidebarGrandchild.thread.id}' BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    );
    const set = [
      f.root,
      f.lifecycleChild,
      f.sidebarChild,
      f.sidebarGrandchild,
      f.archivedChild,
    ].map((entry) => entry.thread.id);
    expect(() =>
      markThreadDeleted(f.db, noopNotifier, {
        threadId: f.root.thread.id,
        release: { kind: "user", threadId: null },
      }),
    ).toThrow("refused");
    expect(
      f.db
        .select({ id: threads.id, deletedAt: threads.deletedAt })
        .from(threads)
        .where(inArray(threads.id, set))
        .all()
        .filter((row) => row.deletedAt !== null),
    ).toEqual([]);
    expect(
      f.db
        .select()
        .from(environmentReleaseConsents)
        .where(inArray(environmentReleaseConsents.threadId, set))
        .all(),
    ).toEqual([]);
  });
});
