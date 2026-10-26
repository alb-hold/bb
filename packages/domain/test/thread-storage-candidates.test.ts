import { describe, expect, it } from "vitest";
import {
  listThreadStorageIds,
  threadIdOfWorktreeFolder,
  withoutThreadRows,
} from "../src/thread-storage-candidates.js";

describe("thread storage candidates", () => {
  it("lists only directories named like a thread id", () => {
    expect(
      listThreadStorageIds([
        { name: "thr_ui46euyqgn", kind: "directory" },
        { name: "thr_ui46euyqgn2", kind: "directory" },
        { name: "thr_mqfh3vi2e6", kind: "file" },
        { name: "workflows", kind: "directory" },
        { name: "thr_ABCDEFGHIJ", kind: "directory" },
        { name: "thr_mqfh3vi2e6", kind: "directory" },
      ]),
    ).toEqual(["thr_ui46euyqgn", "thr_mqfh3vi2e6"]);
  });

  it("keeps the ids that have no row, whatever the state of the row", () => {
    expect(
      withoutThreadRows(
        ["thr_aaaaaaaaaa", "thr_bbbbbbbbbb", "thr_cccccccccc"],
        new Set(["thr_bbbbbbbbbb"]),
      ),
    ).toEqual(["thr_aaaaaaaaaa", "thr_cccccccccc"]);
  });

  it.each([
    ["thr_ui46euyqgn-1", "thr_ui46euyqgn"],
    ["thr_ui46euyqgn", "thr_ui46euyqgn"],
    ["thr_ui46euyqgn-12", "thr_ui46euyqgn"],
    ["card142-account-pooler", null],
    ["thr_ui46euyqgn-x", null],
    ["thr_ui46euyqgn-1-extra", null],
    ["xthr_ui46euyqgn-1", null],
  ])("reads the thread id of the worktree folder %s as %s", (name, id) => {
    expect(threadIdOfWorktreeFolder(name)).toBe(id);
  });
});
