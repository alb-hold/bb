import { describe, expect, it } from "vitest";
import {
  PERSONAL_PROJECT_ID,
  type ThreadParentNotifications,
} from "@bb/domain";
import {
  resolveParentNotificationsChoice,
} from "@bb/domain/thread-parent-notifications-storage";
import {
  createConnection,
  createThread,
  getThread,
  migrate,
  noopNotifier,
  updateThread,
  type DbConnection,
} from "../src/index.js";
import { dropThreadParentNotificationsHoldColumn } from "./helpers/rewind.js";

const STOCK_PARENT_NOTIFICATIONS_VALUES: readonly string[] = [
  "auto",
  "stuck",
  "off",
];
const HOLD_MIGRATION_TIMESTAMP = 1794850000000;

interface StoredColumns {
  hold: number | null;
  stored: string;
}

function seedThread(
  db: DbConnection,
  parentNotifications: ThreadParentNotifications,
) {
  return createThread(db, noopNotifier, {
    projectId: PERSONAL_PROJECT_ID,
    providerId: "test-provider",
    status: "idle",
    parentNotifications,
  });
}

function storedColumns(db: DbConnection, threadId: string): StoredColumns {
  const row = db.$client
    .prepare<
      [string],
      { hold: number | null; stored: string }
    >("SELECT parent_notifications AS stored, parent_notifications_hold_while_idle AS hold FROM threads WHERE id = ?")
    .get(threadId);
  if (!row) throw new Error(`thread ${threadId} missing`);
  return row;
}

describe("parent notifications inbox storage", () => {
  it("stores the inbox choice as auto plus a hold flag that a stock parse accepts", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      const thread = seedThread(db, "inbox");

      const columns = storedColumns(db, thread.id);
      expect(STOCK_PARENT_NOTIFICATIONS_VALUES).toContain(columns.stored);
      expect(columns).toEqual({ stored: "auto", hold: 1 });
      expect(
        resolveParentNotificationsChoice(getThread(db, thread.id) ?? thread),
      ).toBe("inbox");
    } finally {
      db.$client.close();
    }
  });

  it("keeps every stored value inside the stock set for each choice", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      for (const choice of ["auto", "inbox", "stuck", "off"] as const) {
        const thread = seedThread(db, choice);
        const columns = storedColumns(db, thread.id);
        expect(STOCK_PARENT_NOTIFICATIONS_VALUES).toContain(columns.stored);
        expect(
          resolveParentNotificationsChoice(getThread(db, thread.id) ?? thread),
        ).toBe(choice);
      }
    } finally {
      db.$client.close();
    }
  });

  it("clears the hold when the choice moves away from inbox and sets it when it moves back", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      const thread = seedThread(db, "inbox");

      updateThread(db, noopNotifier, thread.id, { parentNotifications: "stuck" });
      expect(storedColumns(db, thread.id)).toEqual({
        stored: "stuck",
        hold: null,
      });

      updateThread(db, noopNotifier, thread.id, { parentNotifications: "inbox" });
      expect(storedColumns(db, thread.id)).toEqual({ stored: "auto", hold: 1 });

      updateThread(db, noopNotifier, thread.id, { parentNotifications: "auto" });
      expect(storedColumns(db, thread.id)).toEqual({
        stored: "auto",
        hold: null,
      });
    } finally {
      db.$client.close();
    }
  });

  it("migrates a row stored with the retired inbox value to auto plus the hold flag", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      const inbox = seedThread(db, "inbox");
      const stuck = seedThread(db, "stuck");
      dropThreadParentNotificationsHoldColumn(db);
      db.$client
        .prepare(
          "UPDATE threads SET parent_notifications = 'inbox' WHERE id = ?",
        )
        .run(inbox.id);
      db.$client
        .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
        .run(HOLD_MIGRATION_TIMESTAMP);

      migrate(db);

      expect(storedColumns(db, inbox.id)).toEqual({ stored: "auto", hold: 1 });
      expect(storedColumns(db, stuck.id)).toEqual({
        stored: "stuck",
        hold: null,
      });
    } finally {
      db.$client.close();
    }
  });
});
