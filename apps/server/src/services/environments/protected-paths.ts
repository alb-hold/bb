import {
  getThread,
  listEnvironmentReferencingThreadIds,
  listEnvironments,
} from "@bb/db";
import {
  canonicalizeHostPath,
  isAbsoluteHostPath,
  isHostPathWithin,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { WorkSessionDeps } from "../../types.js";

export function assertPathAvoidsProtectedWorkspaces(
  deps: Pick<WorkSessionDeps, "db">,
  args: { hostId: string; path: string; action: "remove" | "move" },
): void {
  if (!isAbsoluteHostPath(args.path)) return;
  const target = canonicalizeHostPath(args.path);
  const environments = listEnvironments(deps.db, { hostId: args.hostId });
  for (const environment of environments) {
    if (environment.path === null || environment.teardownStatus === "removed")
      continue;
    const workspace = canonicalizeHostPath(environment.path);
    if (!isHostPathWithin({ rootPath: target, candidatePath: workspace }))
      continue;
    const threadIds = new Set(
      listEnvironmentReferencingThreadIds(deps.db, environment.id),
    );
    if (environment.ownerThreadId !== null) {
      const owner = getThread(deps.db, environment.ownerThreadId);
      if (owner !== null && owner.deletedAt === null) threadIds.add(owner.id);
    }
    const ids = [...threadIds];
    throw new ApiError(
      409,
      "workspace_busy",
      `Refusing to ${args.action} ${args.path}: it is or contains the workspace ${workspace}${ids.length === 0 ? " that no thread references any more" : ` of ${ids.length === 1 ? "thread" : "threads"} ${ids.join(", ")}`}. bb removes a workspace only through its owner's release.`,
    );
  }
}
