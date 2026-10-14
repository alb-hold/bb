import { afterEach, describe, expect, it } from "vitest";
import {
  createConnection,
  createTerminalSession,
  ensureTerminalAttentionTable,
  getTerminalAttention,
  migrate,
  noopNotifier,
  upsertHost,
  upsertTerminalAttention,
} from "../src/index.js";

const connections: ReturnType<typeof createConnection>[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) {
    connection.$client.close();
  }
});

describe("fork terminal attention table", () => {
  it("initializes after the stock migration chain and is idempotent", () => {
    const db = createConnection(":memory:");
    connections.push(db);
    migrate(db);
    const initializedByMigrate = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("fork_terminal_attention");
    expect(initializedByMigrate).toBeDefined();
    ensureTerminalAttentionTable(db);
    ensureTerminalAttentionTable(db);

    const table = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("fork_terminal_attention");
    const columns = db.$client
      .prepare("PRAGMA table_info(fork_terminal_attention)")
      .all() as Array<{ name: string }>;

    expect(table).toBeDefined();
    expect(columns.map((column) => column.name)).toEqual([
      "terminal_session_id",
      "seq",
      "kind",
      "title",
      "body",
      "attention_at",
      "cleared_at",
      "updated_at",
    ]);
  });

  it("deletes attention when its terminal session is deleted", () => {
    const db = createConnection(":memory:");
    connections.push(db);
    migrate(db);
    const host = upsertHost(db, noopNotifier, { name: "test-host" });
    const terminal = createTerminalSession(db, {
      cols: 80,
      daemonSessionId: null,
      environmentId: null,
      hostId: host.id,
      initialCwd: "/tmp",
      rows: 24,
      status: "running",
      threadId: null,
      title: "Test terminal",
    });
    upsertTerminalAttention(db, {
      terminalSessionId: terminal.id,
      seq: 1,
      kind: "bell",
      title: null,
      body: null,
      attentionAt: 100,
    });

    db.$client
      .prepare("DELETE FROM terminal_sessions WHERE id = ?")
      .run(terminal.id);

    expect(getTerminalAttention(db, terminal.id)).toBeNull();
  });
});
