import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensurePluginProcessDataDir } from "@bb/process-utils";
import {
  FILE_TIMESTAMP_LAG_MS,
  treeFingerprint,
} from "bb-environment-provider-host/remove-directory-tree";
import {
  WORKTREE_TRASH_DIR_NAME,
  worktreeTrashEntryName,
} from "bb-environment-provider-host/worktree-trash";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveWorktreeTrashRoot,
  startWorktreeTrashSweep,
  sweepWorktreeTrash,
  worktreeTrashSweepDeps,
  type WorktreeTrashSweepDeps,
} from "./worktree-trash-sweep.js";

const HOUR_MS = 60 * 60_000;
const NOW = Date.now() + 48 * HOUR_MS;
const PLENTY = 500_000_000_000;
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

interface LogLine {
  level: "info" | "warn";
  fields: Record<string, unknown>;
  message: string;
}

const SETTLED_SECONDS = 1_600_000_000;

async function trashDataDir(): Promise<{ dataDir: string; trashRoot: string }> {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bb-trash-sweep-")),
  );
  roots.push(dataDir);
  const trashRoot = resolveWorktreeTrashRoot(dataDir);
  await fs.mkdir(trashRoot, { recursive: true });
  return { dataDir, trashRoot };
}

async function buildWorktree(dataDir: string, label: string): Promise<string> {
  const worktree = path.join(dataDir, "worktrees", label);
  await fs.mkdir(path.join(worktree, "src", "deep"), { recursive: true });
  await fs.writeFile(path.join(worktree, "src", "index.txt"), label);
  const deep = path.join(worktree, "src", "deep", "file.txt");
  await fs.writeFile(deep, "settled\n");
  await fs.utimes(deep, SETTLED_SECONDS, SETTLED_SECONDS);
  return worktree;
}

async function trashWorktree(
  worktree: string,
  trashRoot: string,
  trashedAt: number,
): Promise<string> {
  const fingerprint = await treeFingerprint(worktree);
  expect(fingerprint).toMatch(/^[0-9a-f]{16}$/u);
  const entry = path.join(
    trashRoot,
    worktreeTrashEntryName(
      path.basename(worktree),
      new Date(trashedAt),
      fingerprint!,
    ),
  );
  await fs.rename(worktree, entry);
  expect(await treeFingerprint(entry)).toBe(fingerprint);
  return entry;
}

async function moveIntoTrash(
  dataDir: string,
  trashRoot: string,
  label: string,
  trashedAt: number,
): Promise<string> {
  return trashWorktree(
    await buildWorktree(dataDir, label),
    trashRoot,
    trashedAt,
  );
}

async function trashWith(ages: Record<string, number>): Promise<{
  dataDir: string;
  trashRoot: string;
  entries: Record<string, string>;
}> {
  const { dataDir, trashRoot } = await trashDataDir();
  const entries: Record<string, string> = {};
  for (const [label, ageMs] of Object.entries(ages)) {
    entries[label] = await moveIntoTrash(
      dataDir,
      trashRoot,
      label,
      NOW - ageMs,
    );
  }
  await delay(FILE_TIMESTAMP_LAG_MS + 50);
  return { dataDir, trashRoot, entries };
}

async function treeFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const pending = [""];
  while (pending.length > 0) {
    const relative = pending.pop()!;
    const entry = path.join(root, relative);
    if ((await fs.lstat(entry)).isDirectory()) {
      for (const name of await fs.readdir(entry)) {
        pending.push(path.join(relative, name));
      }
    } else {
      files[relative] = await fs.readFile(entry, "utf8");
    }
  }
  return files;
}

function recordingLogger(): {
  logger: WorktreeTrashSweepDeps["logger"];
  logs: LogLine[];
} {
  const logs: LogLine[] = [];
  const log =
    (level: LogLine["level"]) =>
    (fields: Record<string, unknown>, message: string) => {
      logs.push({ level, fields, message });
    };
  return { logs, logger: { info: log("info"), warn: log("warn") } as never };
}

function sweepDeps(
  dataDir: string,
  overrides: Partial<WorktreeTrashSweepDeps> = {},
): { deps: WorktreeTrashSweepDeps; logs: LogLine[] } {
  const { logger, logs } = recordingLogger();
  return {
    logs,
    deps: {
      ...worktreeTrashSweepDeps({
        daemonDataDir: dataDir,
        logger,
        testWorktreeHolderScan: { status: "clear" },
      }),
      now: () => NOW,
      freeBytes: async () => PLENTY,
      treeBytes: async () => 0,
      keptLogged: new Set(),
      ...overrides,
    },
  };
}

async function present(entry: string): Promise<boolean> {
  return fs.lstat(entry).then(
    () => true,
    () => false,
  );
}

describe("sweeping the worktree trash", () => {
  it("keeps entries under 24 hours and deletes an unheld one over 24 hours", async () => {
    const { dataDir, entries } = await trashWith({
      fresh: 30 * 60_000,
      recent: 2 * HOUR_MS,
      almost: 23 * HOUR_MS + 59 * 60_000,
      old: 25 * HOUR_MS,
    });
    const { deps, logs } = sweepDeps(dataDir);

    await sweepWorktreeTrash(deps);

    expect(await present(entries.old!)).toBe(false);
    expect(await present(entries.almost!)).toBe(true);
    expect(await present(entries.recent!)).toBe(true);
    expect(await present(entries.fresh!)).toBe(true);
    expect(logs).toEqual([
      {
        level: "info",
        fields: { entry: entries.old, ageMs: 25 * HOUR_MS },
        message: "Deleted worktree trash entry",
      },
    ]);
  });

  it("keeps an entry over 24 hours that a live process still uses, and logs it once", async () => {
    const { dataDir, entries } = await trashWith({ old: 30 * HOUR_MS });
    const holder = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd: path.join(entries.old!, "src"), stdio: "ignore" },
    );
    children.push(holder);
    await delay(200);
    expect(holder.exitCode).toBeNull();
    const { logger, logs } = recordingLogger();
    const deps: WorktreeTrashSweepDeps = {
      ...worktreeTrashSweepDeps({ daemonDataDir: dataDir, logger }),
      now: () => NOW,
      freeBytes: async () => PLENTY,
      treeBytes: async () => 0,
      keptLogged: new Set(),
    };

    await sweepWorktreeTrash(deps);
    await sweepWorktreeTrash(deps);

    expect(await present(entries.old!)).toBe(true);
    expect(
      await fs.readFile(path.join(entries.old!, "src", "index.txt"), "utf8"),
    ).toBe("old");
    expect(logs.map((line) => [line.level, line.message])).toEqual([
      ["warn", "Kept worktree trash entry"],
    ]);
    expect(logs[0]!.fields.entry).toBe(entries.old);
    const reason = String(logs[0]!.fields.reason);
    expect(reason, reason).toContain(`pid ${holder.pid} through`);
  }, 60_000);

  it("deletes nothing under 24 hours while free disk and the trash are within limits", async () => {
    const { dataDir, entries } = await trashWith({
      recent: 2 * HOUR_MS,
      older: 20 * HOUR_MS,
    });
    const { deps, logs } = sweepDeps(dataDir, {
      freeBytes: async () => 20_000_000_000,
      treeBytes: async () => 10_000_000_000,
    });

    await sweepWorktreeTrash(deps);

    expect(await present(entries.recent!)).toBe(true);
    expect(await present(entries.older!)).toBe(true);
    expect(logs).toEqual([]);
  });

  it("deletes entries over an hour early, oldest first, while free disk is under the floor, and never one under an hour", async () => {
    const { dataDir, entries } = await trashWith({
      fresh: 59 * 60_000,
      recent: 2 * HOUR_MS,
      older: 5 * HOUR_MS,
    });
    const { deps, logs } = sweepDeps(dataDir, {
      freeBytes: async () => 12_000_000_000,
    });

    await sweepWorktreeTrash(deps);

    expect(await present(entries.older!)).toBe(false);
    expect(await present(entries.recent!)).toBe(false);
    expect(await present(entries.fresh!)).toBe(true);
    expect(logs.map((line) => line.fields)).toEqual([
      {
        entry: entries.older,
        ageMs: 5 * HOUR_MS,
        reason:
          "free disk is 12000000000 bytes, under the 20000000000-byte floor",
      },
      {
        entry: entries.recent,
        ageMs: 2 * HOUR_MS,
        reason:
          "free disk is 12000000000 bytes, under the 20000000000-byte floor",
      },
    ]);
    expect(
      logs.every(
        (line) => line.message === "Deleted worktree trash entry early",
      ),
    ).toBe(true);
  });

  it("keeps data written into an entry after its final inspection through an early delete, still deletes an unchanged entry early, and deletes the kept entry after 24 hours", async () => {
    const { dataDir, trashRoot } = await trashDataDir();
    const built = {
      unchanged: await buildWorktree(dataDir, "unchanged"),
      late: await buildWorktree(dataDir, "late"),
    };
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    const inspectedAt = Date.now();
    const unchanged = await trashWorktree(
      built.unchanged,
      trashRoot,
      inspectedAt - 1,
    );
    const late = await trashWorktree(built.late, trashRoot, inspectedAt);
    await fs.writeFile(
      path.join(late, "src", "late.txt"),
      "written after the final inspection\n",
    );
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    let now = inspectedAt + 2 * HOUR_MS;
    const { deps, logs } = sweepDeps(dataDir, {
      now: () => now,
      freeBytes: async () => 12_000_000_000,
    });

    await sweepWorktreeTrash(deps);

    expect(await present(unchanged)).toBe(false);
    expect(await fs.readFile(path.join(late, "src", "late.txt"), "utf8")).toBe(
      "written after the final inspection\n",
    );
    expect(
      logs.map((line) => [line.level, line.message, line.fields.entry]),
    ).toEqual([
      ["info", "Deleted worktree trash entry early", unchanged],
      ["warn", "Kept worktree trash entry", late],
    ]);
    expect(String(logs[1]!.fields.reason)).toContain(
      "its contents changed since it was moved to the trash",
    );

    await sweepWorktreeTrash(deps);

    expect(logs).toHaveLength(2);
    expect(await fs.readdir(trashRoot)).toEqual([path.basename(late)]);

    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    now = inspectedAt + 25 * HOUR_MS;
    await sweepWorktreeTrash(deps);

    expect(await present(late)).toBe(false);
    expect(logs.slice(2)).toEqual([
      {
        level: "info",
        fields: { entry: late, ageMs: 25 * HOUR_MS },
        message: "Deleted worktree trash entry",
      },
    ]);
  });

  it("keeps an entry that gained a file through an early delete when the clock was ahead at the move and went back before the write", async () => {
    const { dataDir, trashRoot } = await trashDataDir();
    const stampedAt = Date.now() + HOUR_MS;
    const unchanged = await moveIntoTrash(
      dataDir,
      trashRoot,
      "unchanged",
      stampedAt - 1,
    );
    const late = await moveIntoTrash(dataDir, trashRoot, "late", stampedAt);
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    await fs.writeFile(path.join(late, "src", "late.txt"), "after rollback\n");
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    let now = stampedAt + 2 * HOUR_MS;
    const { deps, logs } = sweepDeps(dataDir, {
      now: () => now,
      freeBytes: async () => 12_000_000_000,
    });

    await sweepWorktreeTrash(deps);
    await sweepWorktreeTrash(deps);

    expect(await present(unchanged)).toBe(false);
    expect(await fs.readdir(trashRoot)).toEqual([path.basename(late)]);
    expect(await treeFiles(late)).toEqual({
      "src/index.txt": "late",
      "src/deep/file.txt": "settled\n",
      "src/late.txt": "after rollback\n",
    });
    expect(
      logs.map((line) => [line.level, line.message, line.fields.entry]),
    ).toEqual([
      ["info", "Deleted worktree trash entry early", unchanged],
      ["warn", "Kept worktree trash entry", late],
    ]);
    expect(String(logs[1]!.fields.reason)).toContain(
      "its contents changed since it was moved to the trash",
    );

    now = stampedAt + 25 * HOUR_MS;
    await sweepWorktreeTrash(deps);

    expect(await present(late)).toBe(false);
    expect(logs.slice(2).map((line) => line.message)).toEqual([
      "Deleted worktree trash entry",
    ]);
  });

  it("keeps an entry through an early delete when a nested file was rewritten in place with its size and modification time put back", async () => {
    const { dataDir, trashRoot } = await trashDataDir();
    const stampedAt = Date.now() + HOUR_MS;
    const entry = await moveIntoTrash(
      dataDir,
      trashRoot,
      "rewritten",
      stampedAt,
    );
    const deep = path.join(entry, "src", "deep", "file.txt");
    const before = await fs.lstat(deep, { bigint: true });
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    await fs.writeFile(deep, "changed\n");
    await fs.utimes(deep, SETTLED_SECONDS, SETTLED_SECONDS);
    const after = await fs.lstat(deep, { bigint: true });
    expect([after.ino, after.size, after.mtimeNs]).toEqual([
      before.ino,
      before.size,
      before.mtimeNs,
    ]);
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    const { deps, logs } = sweepDeps(dataDir, {
      now: () => stampedAt + 2 * HOUR_MS,
      freeBytes: async () => 12_000_000_000,
    });

    await sweepWorktreeTrash(deps);

    expect(await fs.readFile(deep, "utf8")).toBe("changed\n");
    expect(await fs.readdir(trashRoot)).toEqual([path.basename(entry)]);
    expect(logs.map((line) => [line.level, line.message])).toEqual([
      ["warn", "Kept worktree trash entry"],
    ]);
  });

  it("keeps an entry through an early delete when a file in it is newer than its trash time, even when its name's fingerprint matches its contents", async () => {
    const { dataDir, trashRoot } = await trashDataDir();
    const built = await buildWorktree(dataDir, "rehashed");
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    const trashedAt = Date.now();
    await fs.writeFile(path.join(built, "src", "late.txt"), "after the move\n");
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    const entry = await trashWorktree(built, trashRoot, trashedAt);
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    const { deps, logs } = sweepDeps(dataDir, {
      now: () => trashedAt + 2 * HOUR_MS,
      freeBytes: async () => 12_000_000_000,
    });

    await sweepWorktreeTrash(deps);

    expect(await fs.readdir(trashRoot)).toEqual([path.basename(entry)]);
    expect(await treeFiles(entry)).toEqual({
      "src/index.txt": "rehashed",
      "src/deep/file.txt": "settled\n",
      "src/late.txt": "after the move\n",
    });
    expect(logs.map((line) => [line.level, line.message])).toEqual([
      ["warn", "Kept worktree trash entry"],
    ]);
  });

  it("never deletes an entry without a fingerprint in its name early, and deletes it after 24 hours", async () => {
    const { dataDir, trashRoot } = await trashDataDir();
    const fingerprinted = await moveIntoTrash(
      dataDir,
      trashRoot,
      "named",
      NOW - 2 * HOUR_MS,
    );
    const unnamed = fingerprinted.slice(0, -17);
    await fs.rename(fingerprinted, unnamed);
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    let now = NOW;
    const { deps, logs } = sweepDeps(dataDir, {
      now: () => now,
      freeBytes: async () => 12_000_000_000,
    });

    await sweepWorktreeTrash(deps);

    expect(await fs.readdir(trashRoot)).toEqual([path.basename(unnamed)]);
    expect(logs).toEqual([]);

    now = NOW + 23 * HOUR_MS;
    await sweepWorktreeTrash(deps);

    expect(await present(unnamed)).toBe(false);
    expect(logs).toEqual([
      {
        level: "info",
        fields: { entry: unnamed, ageMs: 25 * HOUR_MS },
        message: "Deleted worktree trash entry",
      },
    ]);
  });

  it("deletes oldest entries early only until the trash is back within its budget", async () => {
    const { dataDir, entries } = await trashWith({
      fresh: 10 * 60_000,
      recent: 2 * HOUR_MS,
      middle: 3 * HOUR_MS,
      older: 4 * HOUR_MS,
    });
    const { deps, logs } = sweepDeps(dataDir, {
      treeBytes: async () => 9_000_000_000,
    });

    await sweepWorktreeTrash(deps);

    expect(await present(entries.older!)).toBe(false);
    expect(await present(entries.middle!)).toBe(false);
    expect(await present(entries.recent!)).toBe(true);
    expect(await present(entries.fresh!)).toBe(true);
    expect(logs.map((line) => [line.fields.entry, line.fields.reason])).toEqual(
      [
        [
          entries.older,
          "the trash holds 36000000000 bytes, over the 20000000000-byte budget",
        ],
        [
          entries.middle,
          "the trash holds 27000000000 bytes, over the 20000000000-byte budget",
        ],
      ],
    );
  });

  it("leaves leftover removal folders out of the trash budget", async () => {
    const { dataDir, trashRoot, entries } = await trashWith({
      recent: 2 * HOUR_MS,
      older: 3 * HOUR_MS,
    });
    const leftover = path.join(
      trashRoot,
      `.${path.basename(entries.older!)}.removing-left`,
    );
    await fs.mkdir(leftover);
    const measured: string[] = [];
    const { deps, logs } = sweepDeps(dataDir, {
      treeBytes: async (directory) => {
        measured.push(directory);
        return directory === trashRoot || directory === leftover
          ? 30_000_000_000
          : 9_000_000_000;
      },
    });

    await sweepWorktreeTrash(deps);

    expect(await present(entries.older!)).toBe(true);
    expect(await present(entries.recent!)).toBe(true);
    expect(await present(leftover)).toBe(true);
    expect([...new Set(measured)].sort()).toEqual(
      [entries.older!, entries.recent!].sort(),
    );
    expect(logs).toEqual([]);
  });

  it("does nothing when the trash folder does not exist", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-trash-sweep-"));
    roots.push(dataDir);
    const { deps, logs } = sweepDeps(dataDir);

    await sweepWorktreeTrash(deps);

    expect(await present(resolveWorktreeTrashRoot(dataDir))).toBe(false);
    expect(logs).toEqual([]);
  });

  it("looks for the trash inside the worktree plugin's own data folder", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-trash-sweep-"));
    roots.push(dataDir);

    const pluginDataDir = await ensurePluginProcessDataDir({
      daemonDataDir: dataDir,
      pluginId: "environment-git-worktree",
      kind: "host-data",
    });

    expect(resolveWorktreeTrashRoot(dataDir)).toBe(
      path.join(pluginDataDir, WORKTREE_TRASH_DIR_NAME),
    );
  });
});

describe("scheduling the worktree trash sweep", () => {
  it("sweeps at start, then hourly on an unref'd timer, one sweep at a time, until stopped", async () => {
    const { dataDir, entries } = await trashWith({ old: 25 * HOUR_MS });
    const { logger, logs } = recordingLogger();
    const production = worktreeTrashSweepDeps({
      daemonDataDir: dataDir,
      logger,
      testWorktreeHolderScan: { status: "clear" },
    });
    let removals = 0;
    let releaseRemoval: () => void = () => {};
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    let removalStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      removalStarted = resolve;
    });
    const timer = {
      callback: null as (() => void) | null,
      intervalMs: 0,
      unrefs: 0,
      clears: 0,
    };

    const sweep = startWorktreeTrashSweep({
      deps: {
        ...production,
        now: () => NOW,
        remove: async (entry, earlyDeleteGuard) => {
          removals += 1;
          removalStarted();
          await removalGate;
          await production.remove(entry, earlyDeleteGuard);
        },
      },
      setIntervalFn: (callback, intervalMs) => {
        timer.callback = callback;
        timer.intervalMs = intervalMs;
        return {
          clear() {
            timer.clears += 1;
          },
          unref() {
            timer.unrefs += 1;
          },
        };
      },
    });

    expect(timer.intervalMs).toBe(3_600_000);
    expect(timer.unrefs).toBe(1);
    await started;
    expect(removals).toBe(1);
    timer.callback!();
    await delay(50);
    expect(removals).toBe(1);
    releaseRemoval();
    await sweep.idle();
    expect(await present(entries.old!)).toBe(false);
    expect(logs.map((line) => line.message)).toEqual([
      "Deleted worktree trash entry",
    ]);
    expect(timer.clears).toBe(0);
    sweep.stop();
    expect(timer.clears).toBe(1);
  });
});
