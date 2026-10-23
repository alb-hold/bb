import { listProcessesWithCwdUnder } from "@bb/process-utils";

export interface InternalProcessHolder {
  pid: number;
  cwd: string;
}

/**
 * First-party plugins only. Lists, without signalling anything, the processes
 * whose working directory is at or under any of `directories`, so a plugin can
 * refuse to delete a tree something is still using. It checks working
 * directories only, not open files, and returns an empty list on Windows.
 * See docs/api_to_audit.md.
 */
export function internal_DO_NOT_USE_listProcessesWithCwdUnder(args: {
  directories: readonly string[];
}): Promise<InternalProcessHolder[]> {
  return listProcessesWithCwdUnder({ directories: args.directories });
}
