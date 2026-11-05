import { getEnvironment, type DbConnection, type DbTransaction } from "@bb/db";
import type {
  HostDaemonCommand,
  HostDaemonSettledCommandType,
} from "@bb/host-daemon-contract";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import type { CommandResultSideEffectsDeps } from "../../internal/command-result-side-effects.js";
import { callHostOnlineRpcForWork } from "../hosts/online-rpc.js";

export const WORKSPACE_PATH_NOT_FOUND_CODE = "path_not_found";

const MISSING_WORKSPACE_PATH_PREFIX =
  "Unmanaged workspace path does not exist: ";

const PROVIDER_SPAWN_ENOENT_PATTERN =
  /^Provider ".+" failed to start: spawn .+ ENOENT$/u;

const PROVIDER_START_COMMAND_TYPES: ReadonlySet<HostDaemonSettledCommandType> =
  new Set(["thread.start", "turn.submit"]);

interface DescribeMissingWorkspaceArgs {
  environmentId: string | null;
  errorCode: string;
  errorMessage: string;
}

interface ResolveMissingWorkspaceFailureArgs {
  command: HostDaemonCommand;
  error: Error;
  hostId: string;
}

function parseMissingWorkspacePath(errorMessage: string): string | null {
  if (!errorMessage.startsWith(MISSING_WORKSPACE_PATH_PREFIX)) {
    return null;
  }
  const path = errorMessage.slice(MISSING_WORKSPACE_PATH_PREFIX.length);
  return path.length > 0 ? path : null;
}

export function describeMissingWorkspace(
  db: DbConnection | DbTransaction,
  args: DescribeMissingWorkspaceArgs,
): string | null {
  if (args.errorCode !== WORKSPACE_PATH_NOT_FOUND_CODE) {
    return null;
  }
  const path = parseMissingWorkspacePath(args.errorMessage);
  if (path === null) {
    return null;
  }
  const branch =
    args.environmentId === null
      ? null
      : (getEnvironment(db, args.environmentId)?.branchName ?? null);
  return branch === null
    ? `This thread's workspace folder no longer exists: ${path}. Restore it, or archive the thread.`
    : `This thread's workspace folder no longer exists: ${path}. Restore it from branch ${branch}, or archive the thread.`;
}

export async function resolveMissingWorkspaceFailure(
  deps: CommandResultSideEffectsDeps,
  args: ResolveMissingWorkspaceFailureArgs,
): Promise<Error> {
  const { command, error } = args;
  if (
    !PROVIDER_START_COMMAND_TYPES.has(command.type) ||
    !("environmentId" in command) ||
    !PROVIDER_SPAWN_ENOENT_PATTERN.test(error.message)
  ) {
    return error;
  }
  const path = getEnvironment(deps.db, command.environmentId)?.path ?? null;
  if (path === null) {
    return error;
  }
  try {
    const { existence } = await callHostOnlineRpcForWork(deps, {
      command: { type: "host.paths_exist", paths: [path] },
      hostId: args.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (existence[path] !== false) {
      return error;
    }
  } catch {
    return error;
  }
  return new ApiError(
    502,
    WORKSPACE_PATH_NOT_FOUND_CODE,
    `${MISSING_WORKSPACE_PATH_PREFIX}${path}`,
    false,
  );
}
