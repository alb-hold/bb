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
      if (
        (await removeDirectoryTree(quarantine, { startedAt: checkedAt })) !==
        "removed"
      ) {
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
