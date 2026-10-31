import { expect, it } from "vitest";
import { createMigratedConnection } from "../src/testing.js";
import {
  createConnection,
  migrate,
  upsertHost,
  createProject,
  createThread,
  createNativeTerminalThread,
  noopNotifier,
} from "../src/index.js";
import { readFileSync } from "node:fs";

it("adopts the existing fork table and preserves rows during the generated column migration", () => {
  const db = createMigratedConnection();
  try {
    const host = upsertHost(db, noopNotifier, { name: "migration-host" });
    const { project } = createProject(db, noopNotifier, {
      name: "migration-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/native-migration",
      },
    });
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    createNativeTerminalThread(db, {
      threadId: thread.id,
      providerId: "codex",
      nativeSessionId: "retained-native-session",
      initialPrompt: null,
      initialImages: [],
      model: null,
    });
    const journal = JSON.parse(
      readFileSync(
        new URL("../drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as { entries: { tag: string; when: number }[] };
    const adoption = journal.entries.find(
      (entry) => entry.tag === "0149_fork_native_terminal_schema",
    );
    expect(adoption).toBeDefined();
    db.$client.exec(
      "ALTER TABLE fork_native_terminal_threads DROP COLUMN lost_idle_terminal_session_id",
    );
    db.$client
      .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
      .run(adoption!.when);
    migrate(db);
    expect(
      db.$client
        .prepare(
          "SELECT native_session_id, lost_idle_terminal_session_id FROM fork_native_terminal_threads",
        )
        .all(),
    ).toEqual([
      {
        native_session_id: "retained-native-session",
        lost_idle_terminal_session_id: null,
      },
    ]);
    migrate(db);
    const reopened = createConnection(db.$client.serialize());
    try {
      expect(
        reopened.$client
          .prepare(
            "SELECT native_session_id, lost_idle_terminal_session_id FROM fork_native_terminal_threads",
          )
          .all(),
      ).toEqual([
        {
          native_session_id: "retained-native-session",
          lost_idle_terminal_session_id: null,
        },
      ]);
    } finally {
      reopened.$client.close();
    }
  } finally {
    db.$client.close();
  }
});
