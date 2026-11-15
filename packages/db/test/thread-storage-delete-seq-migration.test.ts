import { expect, it } from "vitest";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import {
  createConnection,
  createThread,
  listPendingThreadStorageDeletions,
  markThreadDeleted,
  markThreadStorageDeleted,
  migrate,
  noopNotifier,
  type DbConnection,
} from "../src/index.js";

const STORAGE_DELETE_SEQ_MIGRATION_TIMESTAMP = 1794760510189;

function seedThreadId(db: DbConnection): string {
  return createThread(db, noopNotifier, {
    projectId: PERSONAL_PROJECT_ID,
    providerId: "test-provider",
    status: "idle",
  }).id;
}

function seedRowidOrderUnlikeIdOrder(db: DbConnection): string[] {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const first = seedThreadId(db);
    const second = seedThreadId(db);
    if (first > second) return [first, second];
  }
  throw new Error("no thread pair with ids opposite to rowid order");
}

function rewindStorageDeleteSeq(db: DbConnection): void {
  db.$client.exec(`
    ALTER TABLE threads DROP COLUMN storage_delete_seq;
    DELETE FROM __drizzle_migrations WHERE created_at >= ${STORAGE_DELETE_SEQ_MIGRATION_TIMESTAMP};
  `);
}

function storedSeqs(db: DbConnection): Map<string, number | null> {
  return new Map(
    db.$client
      .prepare<[], { id: string; storage_delete_seq: number | null }>(
        "SELECT id, storage_delete_seq FROM threads",
      )
      .all()
      .map((row) => [row.id, row.storage_delete_seq]),
  );
}

it("backfills null storage delete seqs of pre-migration rows in rowid order", () => {
  const db = createConnection(":memory:");
  try {
    migrate(db);
    const [olderRowid, newerRowid] = seedRowidOrderUnlikeIdOrder(db);
    const notDeleted = seedThreadId(db);
    const storageAlreadyDeleted = seedThreadId(db);
    const deletedLast = 3_000;
    for (const [threadId, deletedAt] of [
      [newerRowid, 1_000],
      [olderRowid, deletedLast],
      [storageAlreadyDeleted, 2_000],
    ] as const) {
      markThreadDeleted(db, noopNotifier, { threadId: threadId ?? "" });
      db.$client
        .prepare("UPDATE threads SET deleted_at = ? WHERE id = ?")
        .run(deletedAt, threadId);
    }
    markThreadStorageDeleted(db, { threadId: storageAlreadyDeleted });
    rewindStorageDeleteSeq(db);
    migrate(db);
    expect([...storedSeqs(db).values()].every((seq) => seq === null)).toBe(
      true,
    );

    const pending = listPendingThreadStorageDeletions(db);

    expect(
      pending.map((row) => [row.id, row.storageDeleteSeq] as const),
    ).toEqual([
      [olderRowid, 1],
      [newerRowid, 2],
    ]);
    const seqs = storedSeqs(db);
    expect(seqs.get(notDeleted)).toBeNull();
    expect(seqs.get(storageAlreadyDeleted)).toBeNull();
    expect(
      listPendingThreadStorageDeletions(db).map((row) => row.storageDeleteSeq),
    ).toEqual([1, 2]);
  } finally {
    db.$client.close();
  }
});
