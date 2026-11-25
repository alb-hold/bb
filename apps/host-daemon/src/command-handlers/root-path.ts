import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { CommandDispatchError } from "../command-dispatch-support.js";

interface ResolveNonSymlinkDirectoryPathArgs {
  description: string;
  path: string;
  lstat?: (target: string) => Promise<Stats>;
  realpath?: (target: string) => Promise<string>;
}

export async function resolveNonSymlinkDirectoryPath(
  args: ResolveNonSymlinkDirectoryPathArgs,
): Promise<string> {
  const rootStat = await (args.lstat ?? fs.lstat)(args.path);
  if (rootStat.isSymbolicLink()) {
    throw new CommandDispatchError(
      "invalid_path",
      `${args.description} "${args.path}" must not be a symlink`,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new CommandDispatchError(
      "invalid_path",
      `${args.description} "${args.path}" is not a directory`,
    );
  }

  return (args.realpath ?? fs.realpath)(args.path);
}
