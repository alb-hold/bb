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
import {
  dropThreadParentNotificationsHoldColumn,
  dropThreadStorageDeleteSeqColumn,
} from "./helpers/rewind.js";

const STORAGE_DELETE_SEQ_MIGRATION_TIMESTAMP = 1794762191729;

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
  dropThreadStorageDeleteSeqColumn(db);
  dropThreadParentNotificationsHoldColumn(db);
  db.$client
    .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
    .run(STORAGE_DELETE_SEQ_MIGRATION_TIMESTAMP);
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

it("finds the next storage delete seq through its index instead of scanning threads", () => {
  const db = createConnection(":memory:");
  try {
    migrate(db);
    const plan = db.$client
      .prepare<[], { detail: string }>(
        "EXPLAIN QUERY PLAN UPDATE threads SET storage_delete_seq = (SELECT coalesce(max(storage_delete_seq), 0) + 1 FROM threads) WHERE id = 'thr_a'",
      )
      .all()
      .map((row) => row.detail);

    expect(plan).toContain(
      "SEARCH threads USING COVERING INDEX threads_storage_delete_seq_idx",
    );
    expect(plan.some((detail) => detail.startsWith("SCAN threads"))).toBe(
      false,
    );
  } finally {
    db.$client.close();
  }
});
