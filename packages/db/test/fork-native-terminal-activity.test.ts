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
import { ensureNativeTerminalThreadsTable } from "../src/fork-native-terminal-threads.js";
import { createMigratedConnection } from "../src/testing.js";
import { dropNativeIdleReapColumns } from "./helpers/rewind.js";

const MIGRATION_0166_CREATED_AT = 1795519008894;
const STAGED_WAIT_COLUMN = "_bb_session_start_awaited_terminal_id_pending";

const connections: ReturnType<typeof createConnection>[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.$client.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function closeConnection(db: ReturnType<typeof createConnection>): void {
  const index = connections.indexOf(db);
  if (index !== -1) connections.splice(index, 1);
  db.$client.close();
}

function readNativeTerminalTableColumnNames(
  db: ReturnType<typeof createConnection>,
): string[] {
  return (
    db.$client
      .prepare("PRAGMA table_info(fork_native_terminal_threads)")
      .all() as Array<{ name: string }>
  ).map((column) => column.name);
}

function hasMigration0166Applied(
  db: ReturnType<typeof createConnection>,
): boolean {
  return (
    db.$client
      .prepare("SELECT 1 FROM __drizzle_migrations WHERE created_at = ?")
      .get(MIGRATION_0166_CREATED_AT) !== undefined
  );
}

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
  return { projectId: project.id, threadId: thread.id };
}

function seedSettledNativeThread(
  db: ReturnType<typeof createConnection>,
  args: {
    projectId: string;
    nativeSessionId: string;
    terminalSessionId: string;
  },
) {
  const thread = createThread(db, noopNotifier, {
    projectId: args.projectId,
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
    dropNativeIdleReapColumns(db);
    db.$client
      .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
      .run(MIGRATION_0166_CREATED_AT);

    expect(() => migrate(db)).not.toThrow();
    expect(getNativeTerminalThread(db, threadId)?.awaitingSessionStart).toBe(
      true,
    );
    expect(readAwaitedTerminalColumn(db, threadId)).toBe(
      "terminal-preexisting",
    );
  });

  it("recovers original wait values after a crash between staging rename and migrator", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-native-wait-crash-1-"));
    directories.push(directory);
    const dbPath = join(directory, "test.sqlite");
    const db = createConnection(dbPath);
    connections.push(db);
    migrate(db);
    const { projectId, threadId: awaitingThreadId } = seedAwaitingNativeThread(
      db,
      {
        nativeSessionId: "session-crash-before-migrator",
        terminalSessionId: "terminal-crash-before-migrator",
      },
    );
    const { threadId: settledThreadId } = seedSettledNativeThread(db, {
      projectId,
      nativeSessionId: "session-settled-before-migrator",
      terminalSessionId: "terminal-settled-before-migrator",
    });
    dropNativeIdleReapColumns(db);
    db.$client
      .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
      .run(MIGRATION_0166_CREATED_AT);

    const originalExec = db.$client.exec.bind(db.$client);
    db.$client.exec = ((source: string) => {
      const result = originalExec(source);
      if (
        source.includes(
          `RENAME COLUMN session_start_awaited_terminal_id TO ${STAGED_WAIT_COLUMN}`,
        )
      ) {
        throw new Error("simulated crash after staging rename");
      }
      return result;
    }) as typeof db.$client.exec;

    expect(() => migrate(db)).toThrow("simulated crash after staging rename");
    closeConnection(db);

    const reopened = createConnection(dbPath);
    connections.push(reopened);
    expect(hasMigration0166Applied(reopened)).toBe(false);
    expect(readNativeTerminalTableColumnNames(reopened)).toContain(
      STAGED_WAIT_COLUMN,
    );
    expect(readNativeTerminalTableColumnNames(reopened)).not.toContain(
      "session_start_awaited_terminal_id",
    );

    expect(() => migrate(reopened)).not.toThrow();
    expect(hasMigration0166Applied(reopened)).toBe(true);
    expect(readNativeTerminalTableColumnNames(reopened)).toContain(
      "session_start_awaited_terminal_id",
    );
    expect(readNativeTerminalTableColumnNames(reopened)).not.toContain(
      STAGED_WAIT_COLUMN,
    );
    expect(readAwaitedTerminalColumn(reopened, awaitingThreadId)).toBe(
      "terminal-crash-before-migrator",
    );
    expect(
      getNativeTerminalThread(reopened, awaitingThreadId)?.awaitingSessionStart,
    ).toBe(true);
    expect(readAwaitedTerminalColumn(reopened, settledThreadId)).toBeNull();
    expect(
      getNativeTerminalThread(reopened, settledThreadId)?.awaitingSessionStart,
    ).toBe(false);
  });

  it("recovers original wait values after a crash between migration 0166 commit and restore", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-native-wait-crash-2-"));
    directories.push(directory);
    const dbPath = join(directory, "test.sqlite");
    const db = createConnection(dbPath);
    connections.push(db);
    migrate(db);
    const { projectId, threadId: awaitingThreadId } = seedAwaitingNativeThread(
      db,
      {
        nativeSessionId: "session-crash-before-restore",
        terminalSessionId: "terminal-crash-before-restore",
      },
    );
    const { threadId: settledThreadId } = seedSettledNativeThread(db, {
      projectId,
      nativeSessionId: "session-settled-before-restore",
      terminalSessionId: "terminal-settled-before-restore",
    });
    dropNativeIdleReapColumns(db);
    db.$client
      .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
      .run(MIGRATION_0166_CREATED_AT);

    const originalExec = db.$client.exec.bind(db.$client);
    db.$client.exec = ((source: string) => {
      if (source.includes(STAGED_WAIT_COLUMN) && hasMigration0166Applied(db)) {
        throw new Error("simulated crash before restore");
      }
      return originalExec(source);
    }) as typeof db.$client.exec;

    expect(() => migrate(db)).toThrow("simulated crash before restore");
    closeConnection(db);

    const reopened = createConnection(dbPath);
    connections.push(reopened);
    expect(hasMigration0166Applied(reopened)).toBe(true);
    expect(readNativeTerminalTableColumnNames(reopened)).toContain(
      "session_start_awaited_terminal_id",
    );
    expect(readNativeTerminalTableColumnNames(reopened)).toContain(
      STAGED_WAIT_COLUMN,
    );
    expect(readAwaitedTerminalColumn(reopened, awaitingThreadId)).toBeNull();

    expect(() => migrate(reopened)).not.toThrow();
    expect(hasMigration0166Applied(reopened)).toBe(true);
    expect(readNativeTerminalTableColumnNames(reopened)).toContain(
      "session_start_awaited_terminal_id",
    );
    expect(readNativeTerminalTableColumnNames(reopened)).not.toContain(
      STAGED_WAIT_COLUMN,
    );
    expect(readAwaitedTerminalColumn(reopened, awaitingThreadId)).toBe(
      "terminal-crash-before-restore",
    );
    expect(
      getNativeTerminalThread(reopened, awaitingThreadId)?.awaitingSessionStart,
    ).toBe(true);
    expect(readAwaitedTerminalColumn(reopened, settledThreadId)).toBeNull();
    expect(
      getNativeTerminalThread(reopened, settledThreadId)?.awaitingSessionStart,
    ).toBe(false);
  });

  it("backfills only NULL real wait rows when 0166 is already journaled and drops the staging column", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-native-wait-journaled-"));
    directories.push(directory);
    const dbPath = join(directory, "test.sqlite");
    const db = createConnection(dbPath);
    connections.push(db);
    migrate(db);
    const { projectId, threadId: backfillThreadId } = seedAwaitingNativeThread(
      db,
      {
        nativeSessionId: "session-backfill-null",
        terminalSessionId: "terminal-backfill-null",
      },
    );
    const { threadId: preserveThreadId } = seedSettledNativeThread(db, {
      projectId,
      nativeSessionId: "session-preserve-non-null",
      terminalSessionId: "terminal-preserve-newer",
    });
    db.$client.exec(
      `ALTER TABLE fork_native_terminal_threads ADD COLUMN ${STAGED_WAIT_COLUMN} TEXT`,
    );
    db.$client
      .prepare(
        `UPDATE fork_native_terminal_threads
         SET session_start_awaited_terminal_id = NULL,
             ${STAGED_WAIT_COLUMN} = ?
         WHERE thread_id = ?`,
      )
      .run("terminal-backfill-null", backfillThreadId);
    db.$client
      .prepare(
        `UPDATE fork_native_terminal_threads
         SET session_start_awaited_terminal_id = ?,
             ${STAGED_WAIT_COLUMN} = ?
         WHERE thread_id = ?`,
      )
      .run(
        "terminal-preserve-newer",
        "terminal-older-staged",
        preserveThreadId,
      );
    closeConnection(db);

    const reopened = createConnection(dbPath);
    connections.push(reopened);
    expect(() => migrate(reopened)).not.toThrow();
    expect(readNativeTerminalTableColumnNames(reopened)).not.toContain(
      STAGED_WAIT_COLUMN,
    );
    expect(readAwaitedTerminalColumn(reopened, backfillThreadId)).toBe(
      "terminal-backfill-null",
    );
    expect(readAwaitedTerminalColumn(reopened, preserveThreadId)).toBe(
      "terminal-preserve-newer",
    );
  });

  it("converges identically whether ensureNativeTerminalThreadsTable runs before or after migrate", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-native-wait-order-"));
    directories.push(directory);
    const dbPath = join(directory, "test.sqlite");
    const db = createConnection(dbPath);
    connections.push(db);
    migrate(db);
    const { threadId } = seedAwaitingNativeThread(db, {
      nativeSessionId: "session-ensure-order",
      terminalSessionId: "terminal-ensure-order",
    });
    dropNativeIdleReapColumns(db);
    db.$client
      .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
      .run(MIGRATION_0166_CREATED_AT);
    db.$client.exec(
      `ALTER TABLE fork_native_terminal_threads RENAME COLUMN session_start_awaited_terminal_id TO ${STAGED_WAIT_COLUMN}`,
    );
    closeConnection(db);

    const reopened = createConnection(dbPath);
    connections.push(reopened);
    ensureNativeTerminalThreadsTable(reopened);
    expect(() => migrate(reopened)).not.toThrow();
    expect(hasMigration0166Applied(reopened)).toBe(true);
    expect(readNativeTerminalTableColumnNames(reopened)).toContain(
      "session_start_awaited_terminal_id",
    );
    expect(readNativeTerminalTableColumnNames(reopened)).not.toContain(
      STAGED_WAIT_COLUMN,
    );
    expect(readAwaitedTerminalColumn(reopened, threadId)).toBe(
      "terminal-ensure-order",
    );
    expect(
      getNativeTerminalThread(reopened, threadId)?.awaitingSessionStart,
    ).toBe(true);
  });
});
