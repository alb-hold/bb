import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { readdir } from "node:fs/promises";
import { createHostProgress } from "bb-environment-provider-host/progress";
import { worktreeHostContract, worktreeHostSignals } from "./contract.js";
import { readDefaultBranchRefs } from "bb-environment-provider-host/git";
import {
  resolveDefaultWorktreeBaseBranch,
  resolveWorktreeBaseBranch,
} from "./host/base-branch.js";
import {
  resolveWorktreeChildPath,
  resolveWorktreesRoot,
  resolveWorktreeAttemptRoot,
  resolveWorktreeTargetPath,
} from "./host/paths.js";
import {
  createWorktree,
  listAdoptableWorktrees,
  removeWorktree,
  resolveAdoptableWorktree,
} from "./host/worktree.js";
import { isWorktreePreservedError } from "./host/worktree-preservation.js";

function completionPathForWorktree(worktreePath: string): string {
  return `${worktreePath}.completed`;
}

async function worktreePathsForPathKey(args: {
  dataDir: string;
  pathKey: string;
}): Promise<string[]> {
  const root = resolveWorktreeAttemptRoot(args);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        resolveWorktreeChildPath({
          dataDir: args.dataDir,
          pathKey: args.pathKey,
          childName: entry.name,
        }),
      );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function createWorktreeHostEntry() {
  return experimental_defineHostEntry({
    contract: worktreeHostContract,
    experimental_signals: worktreeHostSignals,
    handlers: {
      async defaultBaseBranch(input) {
        const refs = await readDefaultBranchRefs(input.sourcePath);
        return {
          branch: resolveDefaultWorktreeBaseBranch({
            defaultBranch: refs.defaultBranch ?? null,
            originDefaultBranch: refs.originDefaultBranch ?? null,
            defaultBranchRelation: refs.defaultBranchRelation ?? null,
          }),
        };
      },
      async listWorktrees(input, context) {
        const worktrees = await listAdoptableWorktrees({
          sourcePath: input.sourcePath,
          managedRoot: resolveWorktreesRoot(context.experimental_paths.dataDir),
        });
        return {
          worktrees: worktrees.map((entry) => ({
            path: entry.path,
            branch: entry.branch,
            locked: entry.locked,
            prunable: entry.prunable,
          })),
        };
      },
      async resolveExistingWorktree(input, context) {
        return resolveAdoptableWorktree({
          sourcePath: input.sourcePath,
          path: input.path,
          managedRoot: resolveWorktreesRoot(context.experimental_paths.dataDir),
        });
      },
      async create(input, context) {
        const targetPath = resolveWorktreeTargetPath({
          dataDir: context.experimental_paths.dataDir,
          pathKey: input.pathKey,
          sourcePath: input.sourcePath,
        });
        try {
          const baseBranch = await resolveWorktreeBaseBranch(
            input.sourcePath,
            input.baseBranch,
          );
          const created = await createWorktree({
            sourcePath: input.sourcePath,
            targetPath,
            completionPath: completionPathForWorktree(targetPath),
            ownWorktreesRoot: resolveWorktreesRoot(
              context.experimental_paths.dataDir,
            ),
            branchName: input.branchName,
            baseBranch,
            branchMode: input.branchMode,
            onProgress: createHostProgress({
              operationId: input.operationId,
              emit: (payload) =>
                context.experimental_emitSignal("progress", payload),
            }),
            signal: context.signal,
          });
          return { status: "created", path: created.path, baseBranch } as const;
        } catch (error) {
          if (context.signal.aborted) throw error;
          return {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          } as const;
        }
      },

      async remove(input, context) {
        try {
          const attemptRoot = resolveWorktreeAttemptRoot({
            dataDir: context.experimental_paths.dataDir,
            pathKey: input.pathKey,
          });
          const paths =
            input.path === null
              ? await worktreePathsForPathKey({
                  dataDir: context.experimental_paths.dataDir,
                  pathKey: input.pathKey,
                })
              : [input.path];
          const refusals: string[] = [];
          for (const path of paths) {
            try {
              await removeWorktree({
                path,
                rootPath: attemptRoot,
                completionPath: completionPathForWorktree(path),
                onProgress: createHostProgress({
                  operationId: input.operationId,
                  emit: (payload) =>
                    context.experimental_emitSignal("progress", payload),
                }),
                signal: context.signal,
              });
            } catch (error) {
              if (!isWorktreePreservedError(error)) throw error;
              refusals.push(error.message);
            }
          }
          if (refusals.length > 0) {
            return { status: "failed", message: refusals.join("\n") } as const;
          }
          return { status: "removed" } as const;
        } catch (error) {
          if (context.signal.aborted) throw error;
          return {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          } as const;
        }
      },
    },
  });
}

export default createWorktreeHostEntry();
