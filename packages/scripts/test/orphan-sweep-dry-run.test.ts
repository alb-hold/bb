import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cwdScanIoDescendantsOnly,
  hostHoldScanIo,
  useHoldScanIoForTests,
} from "@bb/process-utils";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  parseOrphanSweepDryRunArgs,
  readThreadIds,
  runOrphanSweepDryRun,
  selectCandidates,
} from "../src/commands/orphan-sweep-dry-run.js";

const ROWLESS = "thr_aaaaaaaaaa";
const WITH_ROW = "thr_bbbbbbbbbb";
const ANOTHER_ROWLESS = "thr_cccccccccc";
const tempDirs: string[] = [];
const children: { kill(signal: NodeJS.Signals): boolean }[] = [];

beforeAll(() => {
  useHoldScanIoForTests(cwdScanIoDescendantsOnly(hostHoldScanIo, process.pid));
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { force: true, recursive: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "bb-dryrun-")));
  tempDirs.push(root);
  const dataDir = path.join(root, "data");
  const worktrees = path.join(
    dataDir,
    "plugins",
    "environment-git-worktree",
    "host-data",
    "worktrees",
  );
  for (const id of [ROWLESS, WITH_ROW, ANOTHER_ROWLESS])
    mkdirSync(path.join(dataDir, "thread-storage", id), { recursive: true });
  mkdirSync(path.join(dataDir, "thread-storage", "workflows"));
  writeFileSync(path.join(dataDir, "thread-storage", "thr_dddddddddd"), "x");
  mkdirSync(path.join(worktrees, `${ROWLESS}-1`, "repo"), { recursive: true });
  mkdirSync(path.join(worktrees, `${WITH_ROW}-1`, "repo"), { recursive: true });
  mkdirSync(path.join(worktrees, "card142-account-pooler", "repo"), {
    recursive: true,
  });
  const idsFile = path.join(root, "ids.txt");
  writeFileSync(idsFile, `${WITH_ROW}\n`);
  return {
    root,
    dataDir,
    worktrees,
    idsFile,
    output: path.join(root, "out.jsonl"),
  };
}

function records(output: string): Record<string, unknown>[] {
  return readFileSync(output, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

describe("orphan sweep dry run", () => {
  it("selects the thread-storage and worktree folders that have no thread row, and counts the worktree folders it cannot classify", () => {
    const { dataDir, worktrees } = fixture();
    const { candidates, unclassifiedWorktreeFolders } = selectCandidates(
      dataDir,
      new Set([WITH_ROW]),
    );
    expect(
      candidates.map((candidate) => [candidate.population, candidate.name]),
    ).toEqual([
      ["thread-storage", ROWLESS],
      ["thread-storage", ANOTHER_ROWLESS],
      ["worktree", `${ROWLESS}-1/repo`],
    ]);
    expect(candidates[2]?.directory).toBe(
      path.join(worktrees, `${ROWLESS}-1`, "repo"),
    );
    expect(unclassifiedWorktreeFolders).toBe(1);
  });

  it("writes a header, a verdict per folder and a summary, and nothing else", async () => {
    const { dataDir, idsFile, output, root } = fixture();
    await runOrphanSweepDryRun({
      dataDir,
      head: "abc123",
      limit: 0,
      output,
      threadIdsFile: idsFile,
    });
    const lines = records(output);
    expect(lines.map((line) => line.kind)).toEqual([
      "header",
      "folder",
      "folder",
      "folder",
      "summary",
    ]);
    expect(lines[0]).toMatchObject({
      head: "abc123",
      threadIdsCount: 1,
      candidates: 3,
      scanned: 3,
      unclassifiedWorktreeFolders: 1,
      totals: {
        storageFolders: 4,
        threadNamedStorageFolders: 3,
        worktreeFolders: 3,
        threadNamedWorktreeFolders: 2,
      },
    });
    expect(lines[4]).toMatchObject({
      candidates: 3,
      byPopulation: { "thread-storage": 2, worktree: 1 },
      verdicts: { clear: 3 },
      exit: 0,
    });
    expect(existsSync(path.join(dataDir, "thread-storage", ROWLESS))).toBe(
      true,
    );
    expect(existsSync(path.join(root, "ids.txt"))).toBe(true);
  });

  it("counts a clear folder as old enough only when its last change is a week old or more", async () => {
    const { dataDir, idsFile, output } = fixture();
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(path.join(dataDir, "thread-storage", ROWLESS), old, old);
    await runOrphanSweepDryRun({
      dataDir,
      head: null,
      limit: 0,
      output,
      threadIdsFile: idsFile,
    });
    const lines = records(output);
    expect(lines.at(-1)).toMatchObject({ clearAndOldEnough: 1 });
    expect(lines.find((line) => line.name === ROWLESS)).toMatchObject({
      oldEnough: true,
    });
    expect(lines.find((line) => line.name === ANOTHER_ROWLESS)).toMatchObject({
      oldEnough: false,
    });
  });

  it("reports a folder a running process works in as held, with the process, and counts it separately from clear folders", async () => {
    const { dataDir, idsFile, output } = fixture();
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        cwd: path.join(dataDir, "thread-storage", ROWLESS),
        stdio: "ignore",
      },
    );
    children.push(child);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await runOrphanSweepDryRun({
      dataDir,
      head: null,
      limit: 0,
      output,
      threadIdsFile: idsFile,
    });
    const folders = records(output).filter((line) => line.kind === "folder");
    const held = folders.find((line) => line.name === ROWLESS);
    expect(held).toMatchObject({ verdict: "held" });
    expect(held?.holders).toMatchObject([
      { pid: child.pid, through: "working-directory" },
    ]);
    expect(folders.filter((line) => line.verdict === "clear")).toHaveLength(2);
  });

  it("names the blocking process of a foreign namespace in the verdict and the summary", async () => {
    const { dataDir, idsFile, output } = fixture();
    const owner = process.geteuid?.() ?? 0;
    useHoldScanIoForTests({
      ...hostHoldScanIo,
      selfPid: 1,
      listProcessIds: async () => ["4242"],
      listTasks: async () => ["4242"],
      readTaskNamespace: async () => "mnt:[999]",
      readOwnMountNamespace: async () => "mnt:[1]",
      effectiveUid: async () => owner,
    });
    try {
      await runOrphanSweepDryRun({
        dataDir,
        head: null,
        limit: 0,
        output,
        threadIdsFile: idsFile,
      });
    } finally {
      useHoldScanIoForTests(
        cwdScanIoDescendantsOnly(hostHoldScanIo, process.pid),
      );
    }
    const lines = records(output);
    expect(lines.find((line) => line.name === ROWLESS)).toMatchObject({
      verdict: "unknown",
      code: "foreign-namespace",
      blocker: { pid: 4242, uid: owner, namespace: "mnt:[999]", comm: null },
    });
    expect(lines.at(-1)).toMatchObject({
      verdicts: { "unknown:foreign-namespace": 3 },
      blockers: {
        [`unknown:foreign-namespace pid=4242 uid=${owner} comm=null namespace=mnt:[999]`]: 3,
      },
    });
  });

  it("reports a symlinked candidate as unknown with its code, and samples evenly when limited", async () => {
    const { dataDir, idsFile, output, root } = fixture();
    const target = path.join(root, "elsewhere");
    mkdirSync(target);
    symlinkSync(target, path.join(dataDir, "thread-storage", "thr_eeeeeeeeee"));
    const full = path.join(root, "full.jsonl");
    await runOrphanSweepDryRun({
      dataDir,
      head: null,
      limit: 0,
      output: full,
      threadIdsFile: idsFile,
    });
    expect(records(full).filter((line) => line.kind === "folder")).toHaveLength(
      3,
    );
    await runOrphanSweepDryRun({
      dataDir,
      head: null,
      limit: 2,
      output,
      threadIdsFile: idsFile,
    });
    expect(records(output)[0]).toMatchObject({ candidates: 3, scanned: 2 });
  });

  it("refuses to overwrite an output file, and rejects a thread id file with a line that is not a thread id", async () => {
    const { dataDir, idsFile, output } = fixture();
    writeFileSync(output, "keep");
    await expect(
      runOrphanSweepDryRun({
        dataDir,
        head: null,
        limit: 0,
        output,
        threadIdsFile: idsFile,
      }),
    ).rejects.toThrow();
    expect(readFileSync(output, "utf8")).toBe("keep");
    expect(() => readThreadIds(`${WITH_ROW}\nnot-an-id\n`)).toThrow("line 2");
    expect(readThreadIds(`${WITH_ROW}\n\n${WITH_ROW}\n`)).toEqual(
      new Set([WITH_ROW]),
    );
  });

  it("requires the data directory, the thread id file and the output file", () => {
    expect(() => parseOrphanSweepDryRunArgs(["--data-dir", "/x"])).toThrow(
      "--output",
    );
    expect(
      parseOrphanSweepDryRunArgs([
        "--data-dir",
        "/x",
        "--thread-ids",
        "/ids",
        "--output",
        "/out",
        "--limit",
        "5",
        "--head",
        "abc",
      ]),
    ).toEqual({
      dataDir: "/x",
      head: "abc",
      limit: 5,
      output: "/out",
      threadIdsFile: "/ids",
    });
    expect(() =>
      parseOrphanSweepDryRunArgs([
        "--limit",
        "-1",
        "--data-dir",
        "/x",
        "--thread-ids",
        "/i",
        "--output",
        "/o",
      ]),
    ).toThrow("--limit");
  });
});
