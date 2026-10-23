import fs from "node:fs/promises";
import path from "node:path";
import { runGit } from "bb-environment-provider-host/git";
import { branchBelongsToThread } from "../attempt-branch.js";
import { parseWorktreeListPorcelain } from "./worktree-list.js";

export type RetentionProof =
  | { absent: true; proof: string }
  | { absent: false; reason: string };

function isUnderOrEqual(candidate: string, directory: string): boolean {
  return (
    candidate === directory || candidate.startsWith(`${directory}${path.sep}`)
  );
}

async function realOrSelf(target: string): Promise<string> {
  return fs.realpath(target).catch(() => path.resolve(target));
}

export async function proveRetentionAbsent(args: {
  path: string;
  sourcePath: string | null;
  threadId: string | null;
  signal: AbortSignal | undefined;
}): Promise<RetentionProof> {
  try {
    await fs.lstat(args.path);
    return { absent: false, reason: `${args.path} still exists on this machine` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      return {
        absent: false,
        reason: `${args.path} could not be checked (${code ?? "error"})`,
      };
    }
  }
  if (args.sourcePath === null) {
    return {
      absent: false,
      reason:
        "the project's checkout on this machine is unknown, so the registered workspaces could not be checked",
    };
  }
  const listing = await runGit(["worktree", "list", "--porcelain", "-z"], {
    cwd: args.sourcePath,
    allowFailure: true,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  });
  if (listing.exitCode !== 0) {
    return {
      absent: false,
      reason: "the registered workspaces of the repository could not be listed",
    };
  }
  const target = path.resolve(args.path);
  const entries = parseWorktreeListPorcelain(listing.stdout);
  for (const entry of entries) {
    const entryPath = await realOrSelf(entry.path);
    if (
      isUnderOrEqual(entryPath, target) ||
      isUnderOrEqual(target, entryPath) ||
      isUnderOrEqual(path.resolve(entry.path), target) ||
      isUnderOrEqual(target, path.resolve(entry.path))
    ) {
      return {
        absent: false,
        reason: `a workspace at ${entry.path} is still registered at or around ${args.path}`,
      };
    }
    if (
      args.threadId !== null &&
      entry.branch !== null &&
      branchBelongsToThread(entry.branch, args.threadId)
    ) {
      return {
        absent: false,
        reason: `the workspace at ${entry.path} still holds branch ${entry.branch} of this thread`,
      };
    }
  }
  return {
    absent: true,
    proof: `lstat ENOENT on ${args.path}; no registered workspace at or around it; no workspace holds a branch of ${args.threadId ?? "this thread"}`,
  };
}
