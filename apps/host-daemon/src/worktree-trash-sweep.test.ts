import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FILE_TIMESTAMP_LAG_MS } from "bb-environment-provider-host/remove-directory-tree";
import { worktreeTrashEntryName } from "bb-environment-provider-host/worktree-trash";
import { afterEach, describe, expect, it } from "vitest";
import { removeDirectoryAfterHolderRecheck } from "./command-handlers/remove-held-directory.js";
import {
  sweepWorktreeTrash,
  type WorktreeTrashSweepDeps,
} from "./worktree-trash-sweep.js";

const HOUR_MS = 60 * 60_000;
const NOW = Date.parse("2026-11-18T12:00:00.000Z");
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

async function trashWith(
  ages: Record<string, number>,
): Promise<{ trashRoot: string; entries: Record<string, string> }> {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bb-trash-sweep-")),
  );
  roots.push(base);
  const trashRoot = path.join(base, ".trash");
  await fs.mkdir(trashRoot);
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
  return { trashRoot, entries };
}

function sweepDeps(
  trashRoot: string,
  overrides: Partial<WorktreeTrashSweepDeps> = {},
): { deps: WorktreeTrashSweepDeps; logs: LogLine[] } {
  const logs: LogLine[] = [];
  const log =
    (level: LogLine["level"]) =>
    (fields: Record<string, unknown>, message: string) => {
      logs.push({ level, fields, message });
    };
  return {
    logs,
    deps: {
      trashRoot,
      logger: { info: log("info"), warn: log("warn") } as never,
      now: () => NOW,
      freeBytes: async () => PLENTY,
      treeBytes: async () => 0,
      remove: (entry) =>
        removeDirectoryAfterHolderRecheck({
          directory: entry,
          action: "delete worktree trash entry",
          recursive: true,
        }),
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
    const { trashRoot, entries } = await trashWith({
      fresh: 30 * 60_000,
      recent: 2 * HOUR_MS,
      almost: 23 * HOUR_MS + 59 * 60_000,
      old: 25 * HOUR_MS,
    });
    const { deps, logs } = sweepDeps(trashRoot);

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
    const { trashRoot, entries } = await trashWith({ old: 30 * HOUR_MS });
    const holder = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd: path.join(entries.old!, "src"), stdio: "ignore" },
    );
    children.push(holder);
    await delay(200);
    expect(holder.exitCode).toBeNull();
    const { deps, logs } = sweepDeps(trashRoot);

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
  });

  it("deletes nothing under 24 hours while free disk and the trash are within limits", async () => {
    const { trashRoot, entries } = await trashWith({
      recent: 2 * HOUR_MS,
      older: 20 * HOUR_MS,
    });
    const { deps, logs } = sweepDeps(trashRoot, {
      freeBytes: async () => 20_000_000_000,
      treeBytes: async () => 20_000_000_000,
    });

    await sweepWorktreeTrash(deps);

    expect(await present(entries.recent!)).toBe(true);
    expect(await present(entries.older!)).toBe(true);
    expect(logs).toEqual([]);
  });

  it("deletes entries over an hour early, oldest first, while free disk is under the floor, and never one under an hour", async () => {
    const { trashRoot, entries } = await trashWith({
      fresh: 59 * 60_000,
      recent: 2 * HOUR_MS,
      older: 5 * HOUR_MS,
    });
    const { deps, logs } = sweepDeps(trashRoot, {
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
    expect(logs.every((line) => line.message === "Deleted worktree trash entry early")).toBe(true);
  });

  it("deletes oldest entries early only until the trash is back within its budget", async () => {
    const { trashRoot, entries } = await trashWith({
      fresh: 10 * 60_000,
      recent: 2 * HOUR_MS,
      middle: 3 * HOUR_MS,
      older: 4 * HOUR_MS,
    });
    const perEntry = 9_000_000_000;
    const { deps, logs } = sweepDeps(trashRoot, {
      treeBytes: async (directory) =>
        (await fs.readdir(directory)).length * perEntry,
    });

    await sweepWorktreeTrash(deps);

    expect(await present(entries.older!)).toBe(false);
    expect(await present(entries.middle!)).toBe(false);
    expect(await present(entries.recent!)).toBe(true);
    expect(await present(entries.fresh!)).toBe(true);
    expect(logs.map((line) => [line.fields.entry, line.fields.reason])).toEqual([
      [
        entries.older,
        "the trash holds 36000000000 bytes, over the 20000000000-byte budget",
      ],
      [
        entries.middle,
        "the trash holds 27000000000 bytes, over the 20000000000-byte budget",
      ],
    ]);
  });

  it("does nothing when the trash folder does not exist", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "bb-trash-sweep-"));
    roots.push(base);
    const { deps, logs } = sweepDeps(path.join(base, ".trash"));

    await sweepWorktreeTrash(deps);

    expect(await present(path.join(base, ".trash"))).toBe(false);
    expect(logs).toEqual([]);
  });
});
