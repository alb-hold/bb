import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createConnection,
  createNativeTerminalThread,
  createProject,
  createThread,
  getNativeTerminalThread,
  migrate,
  noopNotifier,
  recordNativeTerminalThreadSessionId,
  stampNativeTerminalThreadActivity,
  upsertHost,
  setNativeTerminalThreadTerminal,
} from "../src/index.js";

const connections: ReturnType<typeof createConnection>[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.$client.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
