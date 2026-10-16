import { afterEach, describe, expect, it } from "vitest";
import {
  clearThreadRowState,
  createConnection,
  createProject,
  createThread,
  getThreadRowState,
  migrate,
  noopNotifier,
  putThreadRowState,
  upsertHost,
} from "../src/index.js";

const connections: ReturnType<typeof createConnection>[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.$client.close();
});

describe("thread row state", () => {
  it("persists statuses and progress by thread and removes empty rows", () => {
    const db = createConnection(":memory:");
    connections.push(db);
    migrate(db);
    const host = upsertHost(db, noopNotifier, { name: "row-state-host" });
    const { project } = createProject(db, noopNotifier, {
      name: "row-state-project",
      source: { type: "local_path", hostId: host.id, path: "/tmp/row-state" },
    });
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const state = {
      statuses: {
        review: { value: "Ready", icon: "✓", color: "green", priority: 2 },
      },
      progress: { value: 0.5, label: "Halfway" },
    };

    putThreadRowState(db, thread.id, state);
    expect(getThreadRowState(db, thread.id)).toEqual(state);
    putThreadRowState(db, thread.id, { statuses: {}, progress: null });
    expect(getThreadRowState(db, thread.id)).toEqual({
      statuses: {},
      progress: null,
    });
    expect(
      db.$client
        .prepare("SELECT 1 FROM fork_thread_row_states WHERE thread_id = ?")
        .get(thread.id),
    ).toBeUndefined();
  });

  it("clears row state when asked", () => {
    const db = createConnection(":memory:");
    connections.push(db);
    migrate(db);
    const host = upsertHost(db, noopNotifier, { name: "row-state-clear-host" });
    const { project } = createProject(db, noopNotifier, {
      name: "row-state-clear-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/row-state-clear",
      },
    });
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    putThreadRowState(db, thread.id, { statuses: {}, progress: { value: 1 } });
    clearThreadRowState(db, thread.id);
    expect(getThreadRowState(db, thread.id)).toEqual({
      statuses: {},
      progress: null,
    });
  });

  it("hides expired state while retaining recently updated state", () => {
    const db = createConnection(":memory:");
    connections.push(db);
    migrate(db);
    const host = upsertHost(db, noopNotifier, {
      name: "row-state-expiry-host",
    });
    const { project } = createProject(db, noopNotifier, {
      name: "row-state-expiry-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/row-state-expiry",
      },
    });
    const stale = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const live = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const now = 2_000_000;
    const state = { statuses: { task: { value: "Working" } }, progress: null };
    putThreadRowState(db, stale.id, state);
    putThreadRowState(db, live.id, state);
    db.$client
      .prepare(
        "UPDATE fork_thread_row_states SET updated_at = ? WHERE thread_id = ?",
      )
      .run(now - 60 * 60 * 1000 - 1, stale.id);
    db.$client
      .prepare(
        "UPDATE fork_thread_row_states SET updated_at = ? WHERE thread_id = ?",
      )
      .run(now - 60 * 60 * 1000 + 1, live.id);

    expect(getThreadRowState(db, stale.id, now)).toEqual({
      statuses: {},
      progress: null,
    });
    expect(getThreadRowState(db, live.id, now)).toEqual(state);
  });
});
