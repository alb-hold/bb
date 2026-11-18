import fs from "node:fs/promises";
import path from "node:path";
import { pluginProcessDataDir } from "@bb/process-utils";
import {
  WORKTREE_TRASH_DIR_NAME,
  worktreeTrashEntryTrashedAt,
} from "bb-environment-provider-host/worktree-trash";
import type { HostDaemonLogger } from "./logger.js";

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
  for (const entry of entries) {
    if (entry.ageMs >= WORKTREE_TRASH_RETENTION_MS) {
      await removeEntry(deps, entry, null);
    }
  }
  for (const entry of entries) {
    if (
      entry.ageMs < WORKTREE_TRASH_EARLY_MIN_AGE_MS ||
      entry.ageMs >= WORKTREE_TRASH_RETENTION_MS
    ) {
      continue;
    }
    const reason = await earlyDeleteReason(deps);
    if (reason === null) return;
    await removeEntry(deps, entry, reason);
  }
}

async function earlyDeleteReason(
  deps: WorktreeTrashSweepDeps,
): Promise<string | null> {
  const free = await deps.freeBytes(deps.trashRoot);
  if (free !== null && free < WORKTREE_TRASH_FREE_DISK_FLOOR_BYTES) {
    return `free disk is ${free} bytes, under the ${WORKTREE_TRASH_FREE_DISK_FLOOR_BYTES}-byte floor`;
  }
  const size = await deps.treeBytes(deps.trashRoot);
  if (size > WORKTREE_TRASH_BUDGET_BYTES) {
    return `the trash holds ${size} bytes, over the ${WORKTREE_TRASH_BUDGET_BYTES}-byte budget`;
  }
  return null;
}

async function removeEntry(
  deps: WorktreeTrashSweepDeps,
  entry: TrashEntry,
  earlyReason: string | null,
): Promise<void> {
  try {
    await deps.remove(entry.entry);
  } catch (error) {
    if (deps.keptLogged.has(entry.name)) return;
    deps.keptLogged.add(entry.name);
    deps.logger.warn(
      {
        entry: entry.entry,
        ageMs: entry.ageMs,
        reason: error instanceof Error ? error.message : String(error),
      },
      "Kept worktree trash entry",
    );
    return;
  }
  deps.keptLogged.delete(entry.name);
  if (earlyReason === null) {
    deps.logger.info(
      { entry: entry.entry, ageMs: entry.ageMs },
      "Deleted worktree trash entry",
    );
    return;
  }
  deps.logger.info(
    { entry: entry.entry, ageMs: entry.ageMs, reason: earlyReason },
    "Deleted worktree trash entry early",
  );
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
  return (
    error instanceof Error && "code" in error && error.code === "ENOENT"
  );
}

export interface WorktreeTrashSweep {
  stop(): void;
  idle(): Promise<void>;
}

export function startWorktreeTrashSweep(args: {
  deps: Omit<WorktreeTrashSweepDeps, "keptLogged">;
  setIntervalFn: (
    callback: () => void,
    intervalMs: number,
  ) => { clear(): void; unref(): void };
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
