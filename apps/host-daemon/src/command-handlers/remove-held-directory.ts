import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorktreeHolderScan } from "@bb/process-utils";
import {
  FILE_TIMESTAMP_LAG_MS,
  keptForChangedData,
  removeDirectoryTree,
  keptTreeReasons,
  treeSnapshot,
  type RemoveDirectoryTreeResult,
} from "bb-environment-provider-host/remove-directory-tree";
import {
  directoryIdentity,
  forgetHolderRefusal,
  holderRefusalKey,
  recordHolderRefusal,
  unchangedHolderRefusal,
} from "./holder-refusal-backoff.js";
import { refuseWhileHeld } from "./refuse-while-held.js";
import {
  CommandDispatchError,
  KeyedRefusalError,
} from "../command-dispatch-support.js";

export async function removeDirectoryAfterHolderRecheck(args: {
  directory: string;
  action: string;
  force?: boolean;
  recursive?: boolean;
  afterHolderScan?: (quarantine: string) => Promise<void>;
  afterFingerprint?: (quarantine: string) => Promise<void>;
  now?: () => number;
  afterBaseline?: (directory: string) => Promise<void>;
  earlyDeleteGuard?: { changesSince: number; fingerprint: string };
  testWorktreeHolderScan?: WorktreeHolderScan;
}): Promise<void> {
  const previousQuarantine = await findPreviousQuarantine(args.directory);
  if (previousQuarantine !== null) {
    throw await priorRemovalRefusal(args, previousQuarantine);
  }
  const identity = await directoryIdentity(args.directory);
  const unchanged =
    identity === null
      ? null
      : await unchangedHolderRefusal(args.directory, identity);
  if (identity !== null && unchanged !== null) {
    throw new KeyedRefusalError(
      "path_in_use",
      `Refusing to ${args.action} ${args.directory}: whether a process is still using it could not be established (${unchanged.reason}). Nothing was stopped and nothing was removed. The same processes have blocked it since ${new Date(unchanged.firstRefusedAt).toISOString()}; it is checked again after ${new Date(unchanged.nextScanAt).toISOString()} or as soon as one of them exits.`,
      holderRefusalKey(identity, unchanged.blockers),
    );
  }
  let doubted = false;
  const quarantine = path.join(
    path.dirname(args.directory),
    `.${path.basename(args.directory)}.removing-${randomUUID()}`,
  );
  const startedAt = Math.min(
    (args.now ?? Date.now)() - FILE_TIMESTAMP_LAG_MS,
    args.earlyDeleteGuard?.changesSince ?? Number.POSITIVE_INFINITY,
  );
  await args.afterBaseline?.(args.directory);
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
      throw await priorRemovalRefusal(args, leftover);
    }
    throw error;
  }
  try {
    const rootInfo = await fs.lstat(quarantine);
    await refuseWhileHeld({
      directory: quarantine,
      action: args.action,
      final: true,
      onDoubt: async (scan) => {
        doubted = true;
        if (identity === null) return null;
        const refusal = await recordHolderRefusal(
          args.directory,
          identity,
          scan,
        );
        return refusal === null
          ? null
          : holderRefusalKey(identity, refusal.blockers);
      },
      ...(args.testWorktreeHolderScan === undefined
        ? {}
        : { testWorktreeHolderScan: args.testWorktreeHolderScan }),
    });
    await args.afterHolderScan?.(quarantine);
    let expectedEntries: ReadonlyMap<string, string> | undefined;
    if (args.earlyDeleteGuard !== undefined) {
      const snapshot = await treeSnapshot(quarantine);
      if (
        snapshot === null ||
        snapshot.fingerprint !== args.earlyDeleteGuard.fingerprint
      ) {
        throw new CommandDispatchError(
          "path_in_use",
          `Refusing to ${args.action} ${args.directory}: ${snapshot === null ? "its contents could not be read in full" : "its contents changed"} since it was moved to the trash. Nothing was stopped.`,
        );
      }
      expectedEntries = snapshot.entries;
      await args.afterFingerprint?.(quarantine);
    }
    if (args.recursive === true) {
      const removal = await removeDirectoryTree(quarantine, {
        startedAt,
        rootMetadataBaseline: {
          ctimeMs: rootInfo.ctimeMs,
          mtimeMs: rootInfo.mtimeMs,
        },
        ...(expectedEntries === undefined ? {} : { expectedEntries }),
      });
      if (removal.status !== "removed") {
        const shown = (entry: string) =>
          path.join(args.directory, path.relative(quarantine, entry));
        const reasons = keptTreeReasons(
          removal,
          shown,
          "new or changed data was found during removal",
        );
        const preservedPaths = removal.retainedPaths.map(shown);
        const message = `Refusing to ${args.action} ${args.directory}: ${reasons.join("; ")}.${preservedPaths.length > 0 ? ` Preserved entries: ${preservedPaths.join(", ")}.` : ""} Nothing was stopped.`;
        throw identity === null
          ? new CommandDispatchError("path_in_use", message)
          : new KeyedRefusalError(
              "path_in_use",
              message,
              `${identity}|${keptTreeRefusalClass(removal)}`,
            );
      }
    } else {
      await fs.rmdir(quarantine);
    }
    forgetHolderRefusal(args.directory);
  } catch (error) {
    if (!doubted) forgetHolderRefusal(args.directory);
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

function keptTreeRefusalClass(removal: RemoveDirectoryTreeResult): string {
  return [
    ...(removal.unanchoredPaths.length > 0 ? ["unanchored"] : []),
    ...(removal.mountedPaths.length > 0 ? ["mounted"] : []),
    ...(keptForChangedData(removal) ? ["changed-data"] : []),
  ].join("+");
}

async function priorRemovalRefusal(
  args: { action: string; directory: string },
  leftover: string,
): Promise<CommandDispatchError> {
  const message = `Refusing to ${args.action} ${args.directory}: a prior removal attempt left recoverable data at ${leftover}.`;
  const identity =
    (await directoryIdentity(args.directory)) ??
    (await directoryIdentity(leftover));
  return identity === null
    ? new CommandDispatchError("path_in_use", message)
    : new KeyedRefusalError(
        "path_in_use",
        message,
        `${identity}|prior-removal`,
      );
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
