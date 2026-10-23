import {
  getSessionById,
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
import { joinHostPathSegments } from "../lib/host-path.js";

export function assertPathAvoidsProtectedWorkspaces(
  deps: Pick<WorkSessionDeps, "db" | "hub">,
  args: { hostId: string; path: string; action: "remove" | "move" },
): void {
  if (!isAbsoluteHostPath(args.path)) {
    throw new ApiError(
      400,
      "invalid_request",
      `Refusing to ${args.action} ${args.path}: the path must be absolute`,
    );
  }
  const target = canonicalizeHostPath(args.path);
  const sessionId = deps.hub.getDaemonSessionIdForHost(args.hostId);
  const dataDir =
    sessionId === null ? null : (getSessionById(deps.db, sessionId)?.dataDir ?? null);
  if (dataDir !== null) {
    const pluginData = canonicalizeHostPath(
      joinHostPathSegments(dataDir, "plugins"),
    );
    if (
      isHostPathWithin({ rootPath: target, candidatePath: pluginData }) ||
      isHostPathWithin({ rootPath: pluginData, candidatePath: target })
    ) {
      throw new ApiError(
        409,
        "workspace_busy",
        `Refusing to ${args.action} ${args.path}: it is or is inside bb's plugin data on this machine, which holds worktrees and any folder bb kept for later. bb removes those only through their own cleanup.`,
      );
    }
  }
  const environments = listEnvironments(deps.db, { hostId: args.hostId });
  for (const environment of environments) {
    const recorded = environment.path ?? environment.claimPath;
    if (recorded === null || environment.teardownStatus === "removed") continue;
    const workspace = canonicalizeHostPath(recorded);
    const overlaps =
      isHostPathWithin({ rootPath: target, candidatePath: workspace }) ||
      isHostPathWithin({ rootPath: workspace, candidatePath: target });
    if (!overlaps) continue;
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
      `Refusing to ${args.action} ${args.path}: it is, contains or is inside the workspace ${workspace}${ids.length === 0 ? " that no thread references any more" : ` of ${ids.length === 1 ? "thread" : "threads"} ${ids.join(", ")}`}. bb removes or moves a workspace only through its owner's release.`,
    );
  }
}

export function refuseUnprovenMutation(args: {
  action: "remove" | "move";
  path: string;
  reason: string;
}): never {
  throw new ApiError(
    409,
    "workspace_busy",
    `Refusing to ${args.action} ${args.path}: ${args.reason}. bb cannot prove, at the moment of the change, that it avoids a workspace, a retained folder or plugin data, so it is not done.`,
  );
}
