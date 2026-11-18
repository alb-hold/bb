import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensurePluginProcessDataDir } from "@bb/process-utils";
import { FILE_TIMESTAMP_LAG_MS } from "bb-environment-provider-host/remove-directory-tree";
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

async function trashWith(ages: Record<string, number>): Promise<{
  dataDir: string;
  trashRoot: string;
  entries: Record<string, string>;
}> {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bb-trash-sweep-")),
  );
  roots.push(dataDir);
  const trashRoot = resolveWorktreeTrashRoot(dataDir);
  await fs.mkdir(trashRoot, { recursive: true });
  const entries: Record<string, string> = {};
  for (const [label, ageMs] of Object.entries(ages)) {
    const entry = path.join(
      trashRoot,
      worktreeTrashEntryName(label, new Date(NOW - ageMs)),
    );
    await fs.mkdir(path.join(entry, "src"), { recursive: true });
    await fs.writeFile(path.join(entry, "src", "index.txt"), label);
    entries[label] = entry;
  }
  await delay(FILE_TIMESTAMP_LAG_MS + 50);
  return { dataDir, trashRoot, entries };
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
  });

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
    const dataDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "bb-trash-sweep-")),
    );
    roots.push(dataDir);
    const trashRoot = resolveWorktreeTrashRoot(dataDir);
    const staged: Record<string, string> = {};
    for (const label of ["unchanged", "late"]) {
      staged[label] = path.join(trashRoot, `.staging-${label}`);
      await fs.mkdir(path.join(staged[label]!, "src"), { recursive: true });
      await fs.writeFile(path.join(staged[label]!, "src", "index.txt"), label);
    }
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    const inspectedAt = Date.now();
    const unchanged = path.join(
      trashRoot,
      worktreeTrashEntryName("unchanged", new Date(inspectedAt - 1)),
    );
    const late = path.join(
      trashRoot,
      worktreeTrashEntryName("late", new Date(inspectedAt)),
    );
    await fs.rename(staged.unchanged!, unchanged);
    await fs.rename(staged.late!, late);
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
    expect(
      await fs.readFile(path.join(late, "src", "late.txt"), "utf8"),
    ).toBe("written after the final inspection\n");
    expect(logs.map((line) => [line.level, line.message, line.fields.entry])).toEqual([
      ["info", "Deleted worktree trash entry early", unchanged],
      ["warn", "Kept worktree trash entry", late],
    ]);
    expect(String(logs[1]!.fields.reason)).toContain("new or changed data");

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
        remove: async (entry, keepChangesSince) => {
          removals += 1;
          removalStarted();
          await removalGate;
          await production.remove(entry, keepChangesSince);
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
