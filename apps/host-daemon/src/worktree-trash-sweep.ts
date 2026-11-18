import fs from "node:fs/promises";
import path from "node:path";
import {
  pluginProcessDataDir,
  type WorktreeHolderScan,
} from "@bb/process-utils";
import {
  WORKTREE_TRASH_DIR_NAME,
  worktreeTrashEntryTrashedAt,
} from "bb-environment-provider-host/worktree-trash";
import { removeDirectoryAfterHolderRecheck } from "./command-handlers/remove-held-directory.js";
import type { HostDaemonLogger } from "./logger.js";
import { readDiskFreeBytes } from "./server-move/host-probes.js";

export const WORKTREE_PLUGIN_ID = "environment-git-worktree";
export const WORKTREE_TRASH_SWEEP_INTERVAL_MS = 60 * 60_000;
export const WORKTREE_TRASH_RETENTION_MS = 24 * 60 * 60_000;
export const WORKTREE_TRASH_EARLY_MIN_AGE_MS = 60 * 60_000;
export const WORKTREE_TRASH_FREE_DISK_FLOOR_BYTES = 20_000_000_000;
export const WORKTREE_TRASH_BUDGET_BYTES = 20_000_000_000;

export interface WorktreeTrashSweepDeps {
  trashRoot: string;
  logger: Pick<HostDaemonLogger, "info" | "warn">;
  now: () => number;
  freeBytes: (directory: string) => Promise<number | null>;
  treeBytes: (directory: string) => Promise<number>;
  remove: (entry: string) => Promise<void>;
  keptLogged: Set<string>;
}

interface TrashEntry {
  name: string;
  entry: string;
  ageMs: number;
}

export function resolveWorktreeTrashRoot(daemonDataDir: string): string {
  return path.join(
    pluginProcessDataDir({
      daemonDataDir,
      pluginId: WORKTREE_PLUGIN_ID,
      kind: "host-data",
    }),
    WORKTREE_TRASH_DIR_NAME,
  );
}

export function worktreeTrashSweepDeps(args: {
  daemonDataDir: string;
  logger: Pick<HostDaemonLogger, "info" | "warn">;
  testWorktreeHolderScan?: WorktreeHolderScan | undefined;
}): Omit<WorktreeTrashSweepDeps, "keptLogged"> {
  const scan = args.testWorktreeHolderScan;
  return {
    trashRoot: resolveWorktreeTrashRoot(args.daemonDataDir),
    logger: args.logger,
    now: Date.now,
    freeBytes: readDiskFreeBytes,
    treeBytes: directoryTreeBytes,
    remove: (entry) =>
      removeDirectoryAfterHolderRecheck({
        directory: entry,
        action: "delete worktree trash entry",
        recursive: true,
        ...(scan === undefined ? {} : { testWorktreeHolderScan: scan }),
      }),
  };
}

export async function sweepWorktreeTrash(
  deps: WorktreeTrashSweepDeps,
): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(deps.trashRoot);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  for (const name of deps.keptLogged) {
    if (!names.includes(name)) deps.keptLogged.delete(name);
  }
  const now = deps.now();
  const entries = names
    .flatMap((name): TrashEntry[] => {
      const trashedAt = worktreeTrashEntryTrashedAt(name);
      return trashedAt === null
        ? []
        : [
            {
              name,
              entry: path.join(deps.trashRoot, name),
              ageMs: now - trashedAt,
            },
          ];
    })
    .sort((left, right) => right.ageMs - left.ageMs);
  const remaining = new Set(entries);
  const sizes = new Map<TrashEntry, number>();
  for (const entry of entries) {
    if (entry.ageMs < WORKTREE_TRASH_RETENTION_MS) continue;
    if (await removeEntry(deps, entry, null)) remaining.delete(entry);
  }
  for (const entry of entries) {
    if (
      entry.ageMs < WORKTREE_TRASH_EARLY_MIN_AGE_MS ||
      entry.ageMs >= WORKTREE_TRASH_RETENTION_MS
    ) {
      continue;
    }
    const reason = await earlyDeleteReason(deps, remaining, sizes);
    if (reason === null) return;
    if (await removeEntry(deps, entry, reason)) remaining.delete(entry);
  }
}

async function earlyDeleteReason(
  deps: WorktreeTrashSweepDeps,
  remaining: ReadonlySet<TrashEntry>,
  sizes: Map<TrashEntry, number>,
): Promise<string | null> {
  const free = await deps.freeBytes(deps.trashRoot);
  if (free !== null && free < WORKTREE_TRASH_FREE_DISK_FLOOR_BYTES) {
    return `free disk is ${free} bytes, under the ${WORKTREE_TRASH_FREE_DISK_FLOOR_BYTES}-byte floor`;
  }
  let size = 0;
  for (const entry of remaining) size += await entryBytes(deps, sizes, entry);
  if (size > WORKTREE_TRASH_BUDGET_BYTES) {
    return `the trash holds ${size} bytes, over the ${WORKTREE_TRASH_BUDGET_BYTES}-byte budget`;
  }
  return null;
}

async function entryBytes(
  deps: WorktreeTrashSweepDeps,
  sizes: Map<TrashEntry, number>,
  entry: TrashEntry,
): Promise<number> {
  const known = sizes.get(entry);
  if (known !== undefined) return known;
  const bytes = await deps.treeBytes(entry.entry);
  sizes.set(entry, bytes);
  return bytes;
}

async function removeEntry(
  deps: WorktreeTrashSweepDeps,
  entry: TrashEntry,
  earlyReason: string | null,
): Promise<boolean> {
  try {
    await deps.remove(entry.entry);
  } catch (error) {
    if (deps.keptLogged.has(entry.name)) return false;
    deps.keptLogged.add(entry.name);
    deps.logger.warn(
      {
        entry: entry.entry,
        ageMs: entry.ageMs,
        reason: error instanceof Error ? error.message : String(error),
      },
      "Kept worktree trash entry",
    );
    return false;
  }
  deps.keptLogged.delete(entry.name);
  if (earlyReason === null) {
    deps.logger.info(
      { entry: entry.entry, ageMs: entry.ageMs },
      "Deleted worktree trash entry",
    );
  } else {
    deps.logger.info(
      { entry: entry.entry, ageMs: entry.ageMs, reason: earlyReason },
      "Deleted worktree trash entry early",
    );
  }
  return true;
}

export async function directoryTreeBytes(directory: string): Promise<number> {
  let total = 0;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let info;
    try {
      info = await fs.lstat(current);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    total += info.blocks * 512;
    if (!info.isDirectory()) continue;
    let children: string[];
    try {
      children = await fs.readdir(current);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    for (const child of children) pending.push(path.join(current, child));
  }
  return total;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export type WorktreeTrashSweepTimer = (
  callback: () => void,
  intervalMs: number,
) => { clear(): void; unref(): void };

export const nodeIntervalTimer: WorktreeTrashSweepTimer = (
  callback,
  intervalMs,
) => {
  const timer = setInterval(callback, intervalMs);
  return {
    clear() {
      clearInterval(timer);
    },
    unref() {
      timer.unref();
    },
  };
};

export interface WorktreeTrashSweep {
  stop(): void;
  idle(): Promise<void>;
}

export function startWorktreeTrashSweep(args: {
  deps: Omit<WorktreeTrashSweepDeps, "keptLogged">;
  setIntervalFn: WorktreeTrashSweepTimer;
}): WorktreeTrashSweep {
  const deps: WorktreeTrashSweepDeps = { ...args.deps, keptLogged: new Set() };
  let running: Promise<void> | null = null;
  const run = () => {
    if (running !== null) return;
    running = sweepWorktreeTrash(deps)
      .catch((error) => {
        deps.logger.warn(
          {
            trashRoot: deps.trashRoot,
            reason: error instanceof Error ? error.message : String(error),
          },
          "Worktree trash sweep failed",
        );
      })
      .finally(() => {
        running = null;
      });
  };
  const timer = args.setIntervalFn(run, WORKTREE_TRASH_SWEEP_INTERVAL_MS);
  timer.unref();
  run();
  return {
    stop() {
      timer.clear();
    },
    idle() {
      return running ?? Promise.resolve();
    },
  };
}
