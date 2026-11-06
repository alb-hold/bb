import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { removeDirectoryTree } from "bb-environment-provider-host/remove-directory-tree";
import { refuseWhileHeld } from "./refuse-while-held.js";
import { CommandDispatchError } from "../command-dispatch-support.js";

export async function removeDirectoryAfterHolderRecheck(args: {
  directory: string;
  action: string;
  force?: boolean;
  recursive?: boolean;
  afterHolderScan?: (quarantine: string) => Promise<void>;
}): Promise<void> {
  const previousQuarantine = await findPreviousQuarantine(args.directory);
  if (previousQuarantine !== null) {
    throw new CommandDispatchError(
      "path_in_use",
      `Refusing to ${args.action} ${args.directory}: a prior removal attempt left recoverable data at ${previousQuarantine}.`,
    );
  }
  const quarantine = path.join(
    path.dirname(args.directory),
    `.${path.basename(args.directory)}.removing-${randomUUID()}`,
  );
  const startedAt = Date.now();
  try {
    await fs.rename(args.directory, quarantine);
  } catch (error) {
    if (
      args.force === true &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      const leftover = await findPreviousQuarantine(args.directory);
      if (leftover === null) return;
      throw new CommandDispatchError(
        "path_in_use",
        `Refusing to ${args.action} ${args.directory}: a prior removal attempt left recoverable data at ${leftover}.`,
      );
    }
    throw error;
  }
  try {
    const rootInfo = await fs.lstat(quarantine);
    await refuseWhileHeld({ directory: quarantine, action: args.action });
    await args.afterHolderScan?.(quarantine);
    if (args.recursive === true) {
      const removal = await removeDirectoryTree(quarantine, {
        startedAt,
        rootMetadataBaseline: {
          ctimeMs: rootInfo.ctimeMs,
          mtimeMs: rootInfo.mtimeMs,
        },
      });
      if (removal.status !== "removed") {
        const preservedPaths = removal.retainedPaths.map((retainedPath) =>
          path.join(args.directory, path.relative(quarantine, retainedPath)),
        );
        throw new CommandDispatchError(
          "path_in_use",
          `Refusing to ${args.action} ${args.directory}: new or changed data was found during removal; the directory may be partially removed.${preservedPaths.length > 0 ? ` Preserved entries: ${preservedPaths.join(", ")}.` : ""} Nothing was stopped.`,
        );
      }
    } else {
      await fs.rmdir(quarantine);
    }
  } catch (error) {
    try {
      await fs.mkdir(args.directory);
      await fs.rename(quarantine, args.directory);
    } catch (restoreError) {
      throw new CommandDispatchError(
        "path_in_use",
        `Refusing to ${args.action} ${args.directory}: removal stopped after ${error instanceof Error ? error.message : String(error)}. Recoverable data remains at ${quarantine}; the original path ${args.directory} was not replaced (${restoreError instanceof Error ? restoreError.message : String(restoreError)}). Nothing was stopped.`,
      );
    }
    throw error;
  }
}

async function findPreviousQuarantine(
  directory: string,
): Promise<string | null> {
  const parent = path.dirname(directory);
  const prefix = `.${path.basename(directory)}.removing-`;
  try {
    const entries = await fs.readdir(parent);
    const match = entries.find((entry) => entry.startsWith(prefix));
    return match === undefined ? null : path.join(parent, match);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}
