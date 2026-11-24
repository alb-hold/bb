import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import {
  awaitNativeTerminalSessionStart,
  createConnection,
  createNativeTerminalThread,
  createProject,
  createThread,
  getNativeTerminalThread,
  migrate,
  noopNotifier,
  rebindNativeTerminalThreadSessionId,
  recordNativeTerminalThreadSessionId,
  setNativeTerminalThreadTerminal,
  stampNativeTerminalThreadActivity,
  stampNativeTerminalThreadToolCall,
  upsertHost,
} from "../src/index.js";
import { createMigratedConnection } from "../src/testing.js";

const connections: ReturnType<typeof createConnection>[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.$client.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function seedAwaitingNativeThread(
  db: ReturnType<typeof createConnection>,
  args: {
    nativeSessionId: string;
    terminalSessionId: string;
  },
) {
  const host = upsertHost(db, noopNotifier, { name: "activity-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "activity-project",
    source: {
      type: "local_path",
      hostId: host.id,
      path: "/tmp/native-session-start-wait",
    },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "claude-code",
  });
  createNativeTerminalThread(db, {
    threadId: thread.id,
    providerId: "claude-code",
    nativeSessionId: args.nativeSessionId,
    initialPrompt: null,
    initialImages: [],
    model: null,
  });
  setNativeTerminalThreadTerminal(db, {
    threadId: thread.id,
    terminalSessionId: args.terminalSessionId,
  });
  awaitNativeTerminalSessionStart(db, {
    threadId: thread.id,
    terminalSessionId: args.terminalSessionId,
  });
  return { threadId: thread.id };
}

function readAwaitedTerminalColumn(
  db: ReturnType<typeof createConnection>,
  threadId: string,
): string | null {
  const row = db.$client
    .prepare(
      "SELECT session_start_awaited_terminal_id AS awaited FROM fork_native_terminal_threads WHERE thread_id = ?",
    )
    .get(threadId) as { awaited: string | null } | undefined;
  return row?.awaited ?? null;
}

describe("native terminal activity receipt", () => {
  it("persists receipts across reopen, fences terminal bindings, and resets on rebind", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-native-activity-"));
    directories.push(directory);
    const path = join(directory, "test.sqlite");
    let db = createConnection(path);
    connections.push(db);
    migrate(db);
    const host = upsertHost(db, noopNotifier, { name: "activity-host" });
    const { project } = createProject(db, noopNotifier, {
      name: "activity-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: join(directory, "project"),
      },
    });
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "claude",
    });
    createNativeTerminalThread(db, {
      threadId: thread.id,
      providerId: "claude",
      nativeSessionId: null,
      initialPrompt: null,
      initialImages: [],
      model: null,
    });
    expect(
      recordNativeTerminalThreadSessionId(db, {
        threadId: thread.id,
        nativeSessionId: "session-current",
      }),
    ).toEqual({ kind: "recorded" });
    expect(
      recordNativeTerminalThreadSessionId(db, {
        threadId: thread.id,
        nativeSessionId: "session-current",
      }),
    ).toEqual({ kind: "unchanged" });
    expect(
      recordNativeTerminalThreadSessionId(db, {
        threadId: thread.id,
        nativeSessionId: "session-different",
      }),
    ).toEqual({ kind: "already-bound", nativeSessionId: "session-current" });

    setNativeTerminalThreadTerminal(db, {
      threadId: thread.id,
      terminalSessionId: "terminal-current",
    });
    expect(
      stampNativeTerminalThreadActivity(db, {
        at: 1_000,
        terminalSessionId: "terminal-obsolete",
        threadId: thread.id,
      }),
    ).toEqual({ updated: false });
    expect(
      stampNativeTerminalThreadActivity(db, {
        at: 2_000,
        terminalSessionId: "terminal-current",
        threadId: thread.id,
      }),
    ).toEqual({ updated: true, previousLastEvidenceAt: null });
    db.$client.close();
    connections.splice(connections.indexOf(db), 1);

    db = createConnection(path);
    connections.push(db);
    migrate(db);
    expect(getNativeTerminalThread(db, thread.id)?.lastEvidenceAt).toBe(2_000);

    setNativeTerminalThreadTerminal(db, {
      threadId: thread.id,
      terminalSessionId: "terminal-rebound",
    });
    expect(getNativeTerminalThread(db, thread.id)?.lastEvidenceAt).toBeNull();
    expect(
      stampNativeTerminalThreadActivity(db, {
        at: 3_000,
        terminalSessionId: "terminal-current",
        threadId: thread.id,
      }),
    ).toEqual({ updated: false });
  });
});

describe("native terminal session-start wait", () => {
  it("adds session_start_awaited_terminal_id through Drizzle migrations", () => {
    const db = createConnection(":memory:");
    connections.push(db);
    db.$client.exec(
      "CREATE TEMP TABLE bb_migration_local_host (id TEXT PRIMARY KEY)",
    );
    db.$client.exec(
      "CREATE TEMP TABLE bb_migration_existing_installation (existing INTEGER NOT NULL)",
    );
    db.$client.exec(
      "INSERT INTO bb_migration_existing_installation VALUES (0)",
    );
    db.$client.exec(
      "CREATE TEMP TABLE bb_migration_queued_message_groups (id TEXT PRIMARY KEY, group_with_next INTEGER NOT NULL)",
    );
    db.$client.pragma("foreign_keys = OFF");
    drizzleMigrate(db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    db.$client.pragma("foreign_keys = ON");

    expect(
      db.$client
        .prepare("PRAGMA table_info(fork_native_terminal_threads)")
        .all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "session_start_awaited_terminal_id",
          notnull: 0,
        }),
      ]),
    );
  });

  it("clears awaitingSessionStart when rebinding the native session id", () => {
    const db = createMigratedConnection();
    connections.push(db);
    const { threadId } = seedAwaitingNativeThread(db, {
      nativeSessionId: "session-initial",
      terminalSessionId: "terminal-1",
    });
    expect(getNativeTerminalThread(db, threadId)?.awaitingSessionStart).toBe(
      true,
    );

    expect(
      rebindNativeTerminalThreadSessionId(db, {
        threadId,
        nativeSessionId: "session-rotated",
        replacesNativeSessionId: "session-initial",
      }),
    ).toEqual({ kind: "rebound" });

    const updated = getNativeTerminalThread(db, threadId);
    expect(updated?.nativeSessionId).toBe("session-rotated");
    expect(updated?.awaitingSessionStart).toBe(false);
    expect(readAwaitedTerminalColumn(db, threadId)).toBeNull();
  });

  it("clears awaitingSessionStart on current-terminal holder activity without SessionStart and ignores obsolete terminals", () => {
    const db = createMigratedConnection();
    connections.push(db);
    const { threadId } = seedAwaitingNativeThread(db, {
      nativeSessionId: "session-activity",
      terminalSessionId: "terminal-current",
    });

    expect(
      stampNativeTerminalThreadActivity(db, {
        at: 1_000,
        terminalSessionId: "terminal-obsolete",
        threadId,
      }),
    ).toEqual({ updated: false });
    expect(getNativeTerminalThread(db, threadId)?.awaitingSessionStart).toBe(
      true,
    );

    expect(
      stampNativeTerminalThreadActivity(db, {
        at: 2_000,
        terminalSessionId: "terminal-current",
        threadId,
      }),
    ).toEqual({ updated: true, previousLastEvidenceAt: null });
    expect(getNativeTerminalThread(db, threadId)?.awaitingSessionStart).toBe(
      false,
    );
    expect(readAwaitedTerminalColumn(db, threadId)).toBeNull();
  });

  it("clears awaitingSessionStart on current-terminal tool-call evidence without SessionStart and ignores obsolete terminals", () => {
    const db = createMigratedConnection();
    connections.push(db);
    const { threadId } = seedAwaitingNativeThread(db, {
      nativeSessionId: "session-tool-call",
      terminalSessionId: "terminal-current",
    });

    expect(
      stampNativeTerminalThreadToolCall(db, {
        at: 1_000,
        terminalSessionId: "terminal-obsolete",
        threadId,
      }),
    ).toEqual({ updated: false });
    expect(getNativeTerminalThread(db, threadId)?.awaitingSessionStart).toBe(
      true,
    );

    expect(
      stampNativeTerminalThreadToolCall(db, {
        at: 2_000,
        terminalSessionId: "terminal-current",
        threadId,
      }),
    ).toEqual({ updated: true, previousLastToolCallAt: null });
    expect(getNativeTerminalThread(db, threadId)?.awaitingSessionStart).toBe(
      false,
    );
    expect(readAwaitedTerminalColumn(db, threadId)).toBeNull();
  });

  it("clears awaitingSessionStart when the terminal is replaced", () => {
    const db = createMigratedConnection();
    connections.push(db);
    const { threadId } = seedAwaitingNativeThread(db, {
      nativeSessionId: "session-replace",
      terminalSessionId: "terminal-old",
    });
    expect(getNativeTerminalThread(db, threadId)?.awaitingSessionStart).toBe(
      true,
    );

    setNativeTerminalThreadTerminal(db, {
      threadId,
      terminalSessionId: "terminal-new",
    });

    expect(getNativeTerminalThread(db, threadId)?.awaitingSessionStart).toBe(
      false,
    );
    expect(readAwaitedTerminalColumn(db, threadId)).toBeNull();
  });

  it("upgrades cleanly when session_start_awaited_terminal_id already exists before migration 0166", () => {
    const db = createMigratedConnection();
    connections.push(db);
    const { threadId } = seedAwaitingNativeThread(db, {
      nativeSessionId: "session-preexisting-column",
      terminalSessionId: "terminal-preexisting",
    });
    db.$client
      .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
      .run(1795519008894);

    expect(() => migrate(db)).not.toThrow();
    expect(getNativeTerminalThread(db, threadId)?.awaitingSessionStart).toBe(
      true,
    );
    expect(readAwaitedTerminalColumn(db, threadId)).toBe(
      "terminal-preexisting",
    );
  });
});
