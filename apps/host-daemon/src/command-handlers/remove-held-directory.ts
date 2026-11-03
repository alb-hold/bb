import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { refuseWhileHeld } from "./refuse-while-held.js";
import { CommandDispatchError } from "../command-dispatch-support.js";

function errorCode(error: unknown): string | null {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

async function removeCheckedTree(
  directory: string,
  checkedAt: number,
  rootEntry = false,
): Promise<boolean> {
  let info;
  try {
    info = await fs.lstat(directory);
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
  if (!rootEntry && (info.ctimeMs >= checkedAt || info.mtimeMs >= checkedAt))
    return false;
  if (!info.isDirectory()) {
    try {
      await fs.unlink(directory);
      return true;
    } catch (error) {
      return errorCode(error) === "ENOENT";
    }
  }
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
  for (const entry of entries) {
    if (!(await removeCheckedTree(path.join(directory, entry), checkedAt)))
      return false;
  }
  let remaining: string[];
  try {
    remaining = await fs.readdir(directory);
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
  if (remaining.some((entry) => !entries.includes(entry))) return false;
  try {
    await fs.rmdir(directory);
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

export async function removeDirectoryAfterHolderRecheck(args: {
  directory: string;
  action: string;
  force?: boolean;
  recursive?: boolean;
}): Promise<void> {
  const quarantine = path.join(
    path.dirname(args.directory),
    `.${path.basename(args.directory)}.removing-${randomUUID()}`,
  );
  try {
    await fs.rename(args.directory, quarantine);
  } catch (error) {
    if (
      args.force === true &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return;
    throw error;
  }
  const checkedAt = Date.now();
  try {
    await refuseWhileHeld({ directory: quarantine, action: args.action });
    if (args.recursive === true) {
      if (!(await removeCheckedTree(quarantine, checkedAt, true))) {
        throw new CommandDispatchError(
          "path_in_use",
          `Refusing to ${args.action} ${args.directory}: new or changed data was found during removal. Nothing was stopped.`,
        );
      }
    } else {
      await fs.rmdir(quarantine);
    }
  } catch (error) {
    try {
      await fs.rename(quarantine, args.directory);
    } catch (restoreError) {
      throw new CommandDispatchError(
        "path_in_use",
        `Refusing to ${args.action} ${args.directory}: removal stopped after ${error instanceof Error ? error.message : String(error)}, and its original path could not be restored (${restoreError instanceof Error ? restoreError.message : String(restoreError)}). Nothing was stopped.`,
      );
    }
    throw error;
  }
}
