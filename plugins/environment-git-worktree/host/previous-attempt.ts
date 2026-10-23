import { spawn } from "node:child_process";
import { runGit, WorkspaceError } from "bb-environment-provider-host/git";
import { parseWorktreeListPorcelain } from "./worktree-list.js";

export interface PreviousAttemptRequest {
  threadId: string;
  attempt: number;
}

export interface PinnedPreviousAttempt {
  branch: string;
  sha: string;
  worktreePath: string | null;
  workingState: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function branchBelongsToAttempt(
  branch: string,
  threadId: string,
  attempt: number,
): boolean {
  if (attempt >= 2) return branch.endsWith(`r${attempt}-${threadId}`);
  return (
    branch.endsWith(threadId) &&
    !new RegExp(`r\\d+-${escapeRegExp(threadId)}$`, "u").test(branch)
  );
}

async function describeWorkingState(
  worktreePath: string | null,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (worktreePath === null) return "no workspace of it is registered any more";
  const status = await runGit(
    [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=traditional",
    ],
    {
      cwd: worktreePath,
      allowFailure: true,
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  if (status.exitCode !== 0) return "its uncommitted state could not be inspected";
  const entries = status.stdout.split("\0").filter((entry) => entry !== "");
  return entries.length === 0
    ? "had no uncommitted, staged, untracked or ignored files when checked"
    : `has ${entries.length} uncommitted, staged, untracked or ignored entries that were not copied`;
}

export async function pinPreviousAttempt(args: {
  sourcePath: string;
  request: PreviousAttemptRequest;
  signal: AbortSignal | undefined;
}): Promise<PinnedPreviousAttempt> {
  const options = {
    cwd: args.sourcePath,
    allowFailure: true,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  };
  const refs = await runGit(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    options,
  );
  if (refs.exitCode !== 0) {
    throw new WorkspaceError(
      "previous_attempt_unresolved",
      "Cannot continue from the earlier attempt because its branches could not be listed; nothing was created.",
    );
  }
  const candidates = refs.stdout
    .split("\n")
    .filter((branch) => branch !== "")
    .filter((branch) =>
      branchBelongsToAttempt(
        branch,
        args.request.threadId,
        args.request.attempt - 1,
      ),
    );
  if (candidates.length !== 1) {
    throw new WorkspaceError(
      "previous_attempt_unresolved",
      `Cannot continue from the earlier attempt: ${candidates.length === 0 ? "its branch was not found" : `${candidates.length} branches could belong to it`}. Nothing was created, and the earlier work was left alone.`,
    );
  }
  const branch = candidates[0]!;
  const resolved = await runGit(
    ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
    options,
  );
  const sha = resolved.stdout.trim();
  if (resolved.exitCode !== 0 || sha === "") {
    throw new WorkspaceError(
      "previous_attempt_unresolved",
      `Cannot continue from the earlier attempt: the tip of ${branch} could not be read. Nothing was created.`,
    );
  }
  const listing = await runGit(
    ["worktree", "list", "--porcelain", "-z"],
    options,
  );
  const holder =
    listing.exitCode === 0
      ? parseWorktreeListPorcelain(listing.stdout).find(
          (entry) => entry.branch === branch,
        )
      : undefined;
  const worktreePath = holder?.path ?? null;
  return {
    branch,
    sha,
    worktreePath,
    workingState: await describeWorkingState(worktreePath, args.signal),
  };
}

function runRefTransaction(
  cwd: string,
  input: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["update-ref", "--stdin"], {
      cwd,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => resolve({ code: null, stderr: error.message }));
    child.once("close", (code) => resolve({ code, stderr }));
    child.stdin.end(input);
  });
}

export async function createBranchAtPinnedTip(args: {
  sourcePath: string;
  pinned: PinnedPreviousAttempt;
  newBranch: string;
}): Promise<void> {
  const result = await runRefTransaction(
    args.sourcePath,
    [
      "start",
      `verify refs/heads/${args.pinned.branch} ${args.pinned.sha}`,
      `create refs/heads/${args.newBranch} ${args.pinned.sha}`,
      "commit",
      "",
    ].join("\n"),
  );
  if (result.code !== 0) {
    throw new WorkspaceError(
      "previous_attempt_changed",
      `Cannot continue from ${args.pinned.branch}: it moved while the new branch was being prepared, or ${args.newBranch} already exists. Nothing was created, and the earlier work was left alone. ${result.stderr.trim().split("\n")[0] ?? ""}`.trim(),
    );
  }
}

export async function deleteCreatedBranch(args: {
  sourcePath: string;
  newBranch: string;
  sha: string;
}): Promise<void> {
  await runGit(
    ["update-ref", "-d", `refs/heads/${args.newBranch}`, args.sha],
    { cwd: args.sourcePath, allowFailure: true },
  );
}

export async function describeContinuity(args: {
  sourcePath: string;
  pinned: PinnedPreviousAttempt;
  newBranch: string;
}): Promise<string> {
  const current = await runGit(
    ["rev-parse", "--verify", `refs/heads/${args.pinned.branch}^{commit}`],
    { cwd: args.sourcePath, allowFailure: true },
  );
  const tip = current.stdout.trim();
  const moved =
    current.exitCode !== 0 || tip !== args.pinned.sha
      ? ` The earlier branch is no longer at that commit${tip === "" ? "" : ` (it is at ${tip.slice(0, 12)})`}; this attempt keeps the commit it pinned, which is not necessarily the latest work.`
      : "";
  return `Continuing on ${args.newBranch} from ${args.pinned.branch} at ${args.pinned.sha.slice(0, 12)}. The earlier workspace${args.pinned.worktreePath === null ? "" : ` at ${args.pinned.worktreePath}`} was kept and ${args.pinned.workingState}.${moved}`;
}
