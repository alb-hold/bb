import {
  ensureGitRepo,
  readDefaultBranchRefs,
  resolveBranchRef,
  type ResolvedBranchRef,
} from "bb-environment-provider-host/git";
import type { WorktreeBaseBranch } from "../contract.js";
type DefaultBranchRelation = NonNullable<
  Awaited<ReturnType<typeof readDefaultBranchRefs>>["defaultBranchRelation"]
>;

interface ResolveDefaultWorktreeBaseBranchArgs {
  defaultBranch: string | null;
  defaultBranchRelation: DefaultBranchRelation | null;
  originDefaultBranch: string | null;
}

export function resolveDefaultWorktreeBaseBranch(
  args: ResolveDefaultWorktreeBaseBranchArgs,
): string | null {
  if (!args.originDefaultBranch) return args.defaultBranch;
  if (!args.defaultBranch) return args.originDefaultBranch;
  if (
    args.defaultBranchRelation === "equal" ||
    args.defaultBranchRelation === "local-behind"
  ) return args.originDefaultBranch;
  return args.defaultBranch;
}

export interface ResolvedWorktreeBaseBranch {
  ref: string;
  fetchFailureFallback: boolean;
}

function worktreeBaseBranch(
  resolved: ResolvedBranchRef | undefined,
): ResolvedWorktreeBaseBranch | null {
  if (resolved === undefined) return null;
  return {
    ref: resolved.ref,
    fetchFailureFallback: resolved.source === "origin",
  };
}

export async function resolveWorktreeBaseBranch(
  sourcePath: string,
  requested: WorktreeBaseBranch,
): Promise<ResolvedWorktreeBaseBranch | null> {
  const repo = await ensureGitRepo(sourcePath);
  if (requested.kind === "named") {
    return worktreeBaseBranch(
      await resolveBranchRef(repo.path, requested.name),
    );
  }
  const refs = await readDefaultBranchRefs(repo);
  const originDefaultBranch = refs.originDefaultBranch ?? null;
  const ref = resolveDefaultWorktreeBaseBranch({
    defaultBranch: refs.defaultBranch ?? null,
    originDefaultBranch,
    defaultBranchRelation: refs.defaultBranchRelation ?? null,
  });
  return ref === null
    ? null
    : { ref, fetchFailureFallback: ref === originDefaultBranch };
}
