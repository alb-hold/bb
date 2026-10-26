import { describe, expect, it } from "vitest";
import { listExistingThreadIds, threadIdsWithRowsQuery } from "../src/index.js";
import { createMigratedConnection } from "../src/testing.js";

describe("the lookup of which thread ids have a row", () => {
  it("answers from the primary key index alone, without touching a thread row or scanning", () => {
    const db = createMigratedConnection();
    const ids = Array.from(
      { length: 5 },
      (_, index) => `thr_aaaaaaaaa${index}`,
    );
    const statement = threadIdsWithRowsQuery(db, ids).toSQL();

    const plan = db.$client
      .prepare<unknown[], { detail: string }>(
        `EXPLAIN QUERY PLAN ${statement.sql}`,
      )
      .all(...statement.params)
      .map((row) => row.detail);

    expect(plan).toEqual([
      "SEARCH threads USING COVERING INDEX sqlite_autoindex_threads_1 (id=?)",
    ]);
    expect(listExistingThreadIds(db, ids)).toEqual([]);
  });
});
