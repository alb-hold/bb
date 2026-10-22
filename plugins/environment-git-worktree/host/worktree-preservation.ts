import fs from "node:fs/promises";
import path from "node:path";
import { runGit, WorkspaceError } from "bb-environment-provider-host/git";
import { describeHolderScan, scanWorktreeHolders } from "./holders.js";
import { parseWorktreeListPorcelain } from "./worktree-list.js";

export const KEEP_WORKTREE_MARKER = ".keep-worktree";
export const WORKTREE_PRESERVED_CODE = "worktree_preserved";

const IN_PROGRESS_OPERATION_PATHS = [
  "MERGE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
];

export interface WorktreeIdentity {
  path: string;
  gitDir: string;
  commonDir: string;
  locked: boolean;
}

export type WorktreeIdentityResult =
  | { status: "missing" }
  | { status: "identified"; identity: WorktreeIdentity }
  | { status: "preserve"; reasons: string[] };

export function worktreePreservedError(
  worktreePath: string,
  reasons: readonly string[],
): WorkspaceError {
  return new WorkspaceError(
    WORKTREE_PRESERVED_CODE,
    `Kept ${worktreePath}: ${reasons.join("; ")}. Commit and push the work, or remove the worktree yourself; bb retries the removal automatically.`,
  );
}

export function isWorktreePreservedError(
  error: unknown,
): error is WorkspaceError {
  return (
    error instanceof WorkspaceError && error.code === WORKTREE_PRESERVED_CODE
  );
}

function errorCode(error: unknown): string | null {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function signalOptions(signal: AbortSignal | undefined): {
  signal?: AbortSignal;
} {
  return signal !== undefined ? { signal } : {};
}

function isStrictlyInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export async function entryExists(target: string): Promise<boolean | null> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT" ? false : null;
  }
}

export function gitEnvironment(worktreePath: string): NodeJS.ProcessEnv {
  return { GIT_CEILING_DIRECTORIES: path.dirname(worktreePath) };
}

export async function identifyWorktree(args: {
  path: string;
  rootPath: string;
  signal?: AbortSignal | undefined;
}): Promise<WorktreeIdentityResult> {
  const target = path.resolve(args.path);
  let info;
  try {
    info = await fs.lstat(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { status: "missing" };
    }
    return {
      status: "preserve",
      reasons: [`could not be inspected (${describeError(error)})`],
    };
  }
  if (info.isSymbolicLink()) {
    return { status: "preserve", reasons: ["is a symbolic link"] };
  }
  if (!info.isDirectory()) {
    return { status: "preserve", reasons: ["is not a directory"] };
  }

  let real: string;
  let rootReal: string;
  try {
    real = await fs.realpath(target);
    rootReal = await fs.realpath(args.rootPath);
  } catch (error) {
    return {
      status: "preserve",
      reasons: [`could not be resolved (${describeError(error)})`],
    };
  }
  if (!isStrictlyInside(rootReal, real)) {
    return {
      status: "preserve",
      reasons: [`is outside the managed worktree directory ${rootReal}`],
    };
  }

  const revParse = await runGit(
    [
      "--no-optional-locks",
      "rev-parse",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
    ],
    {
      cwd: real,
      env: gitEnvironment(real),
      allowFailure: true,
      ...signalOptions(args.signal),
    },
  );
  const [toplevel, gitDir, commonDir, ...extra] = revParse.stdout
    .trimEnd()
    .split("\n");
  if (
    revParse.exitCode !== 0 ||
    !toplevel ||
    !gitDir ||
    !commonDir ||
    extra.length > 0
  ) {
    return {
      status: "preserve",
      reasons: [
        `is not a Git worktree root${revParse.stderr.trim() ? ` (${revParse.stderr.trim()})` : ""}`,
      ],
    };
  }

  let toplevelReal: string;
  let gitDirReal: string;
  let commonDirReal: string;
  try {
    toplevelReal = await fs.realpath(path.resolve(real, toplevel));
    gitDirReal = await fs.realpath(path.resolve(real, gitDir));
    commonDirReal = await fs.realpath(path.resolve(real, commonDir));
  } catch (error) {
    return {
      status: "preserve",
      reasons: [`has unresolvable Git metadata (${describeError(error)})`],
    };
  }
  if (toplevelReal !== real) {
    return {
      status: "preserve",
      reasons: [`is not the root of its Git checkout (${toplevelReal})`],
    };
  }
  if (gitDirReal === commonDirReal) {
    return {
      status: "preserve",
      reasons: ["is a main checkout, not a linked worktree"],
    };
  }

  const list = await runGit(
    ["--git-dir", commonDirReal, "worktree", "list", "--porcelain", "-z"],
    {
      cwd: real,
      env: gitEnvironment(real),
      allowFailure: true,
      ...signalOptions(args.signal),
    },
  );
  if (list.exitCode !== 0) {
    return {
      status: "preserve",
      reasons: [
        `could not be matched to its repository's worktree list${list.stderr.trim() ? ` (${list.stderr.trim()})` : ""}`,
      ],
    };
  }
  for (const entry of parseWorktreeListPorcelain(list.stdout)) {
    let entryReal: string;
    try {
      entryReal = await fs.realpath(entry.path);
    } catch {
      continue;
    }
    if (entryReal !== real) continue;
    if (entry.isMain || entry.isBare) {
      return {
        status: "preserve",
        reasons: ["is the repository's main checkout"],
      };
    }
    return {
      status: "identified",
      identity: {
        path: real,
        gitDir: gitDirReal,
        commonDir: commonDirReal,
        locked: entry.locked,
      },
    };
  }
  return {
    status: "preserve",
    reasons: [`is not registered in the worktree list of ${commonDirReal}`],
  };
}

export async function findStructuralReasons(
  identity: WorktreeIdentity,
): Promise<string[]> {
  const reasons: string[] = [];
  if (identity.locked) {
    reasons.push("is locked (git worktree lock)");
  }

  const marker = await entryExists(
    path.join(identity.path, KEEP_WORKTREE_MARKER),
  );
  if (marker === true) {
    reasons.push(`contains ${KEEP_WORKTREE_MARKER}`);
  } else if (marker === null) {
    reasons.push(`could not check for ${KEEP_WORKTREE_MARKER}`);
  }

  for (const name of IN_PROGRESS_OPERATION_PATHS) {
    const present = await entryExists(path.join(identity.gitDir, name));
    if (present === true) {
      reasons.push(`has a Git operation in progress (${name})`);
    } else if (present === null) {
      reasons.push(`could not check for a Git operation in progress (${name})`);
    }
  }
  return reasons;
}

export async function findPreservationReasons(
  identity: WorktreeIdentity,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const reasons = await findStructuralReasons(identity);
  const gitOptions = {
    cwd: identity.path,
    env: gitEnvironment(identity.path),
    allowFailure: true,
    ...signalOptions(signal),
  };

  const status = await runGit(
    [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ],
    gitOptions,
  );
  if (status.exitCode !== 0) {
    reasons.push(
      `could not read its Git status${status.stderr.trim() ? ` (${status.stderr.trim()})` : ""}`,
    );
  } else if (status.stdout !== "") {
    reasons.push("has uncommitted changes or untracked files");
  }

  const unpublished = await runGit(
    [
      "--no-optional-locks",
      "rev-list",
      "--max-count=1",
      "HEAD",
      "--not",
      "--remotes",
    ],
    gitOptions,
  );
  if (unpublished.exitCode !== 0) {
    reasons.push(
      `could not verify its commits are published${unpublished.stderr.trim() ? ` (${unpublished.stderr.trim()})` : ""}`,
    );
  } else if (unpublished.stdout.trim() !== "") {
    reasons.push(
      "has commits that are not reachable from any remote-tracking branch",
    );
  }
  reasons.push(
    "needs its owner's release before bb removes it, and bb cannot verify a release yet",
  );
  const holderReason = describeHolderScan(
    await scanWorktreeHolders(identity.path),
  );
  if (holderReason !== null) reasons.push(holderReason);
  return reasons;
}
