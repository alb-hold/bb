import {
  scanWorktreeHolders,
  type WorktreeHolderScan,
} from "@bb/process-utils";
import {
  CommandDispatchError,
  KeyedRefusalError,
} from "../command-dispatch-support.js";

export async function refuseWhileHeld(args: {
  directory: string;
  displayDirectory?: string;
  action: string;
  ignoreProcessDoubts?: boolean;
  testWorktreeHolderScan?: WorktreeHolderScan;
  final?: boolean;
  onDoubt?: (
    scan: Extract<WorktreeHolderScan, { status: "uncertain" | "unknown" }>,
  ) => Promise<string | null>;
}): Promise<void> {
  const scan =
    args.testWorktreeHolderScan ??
    (await scanWorktreeHolders(args.directory, { final: args.final === true }));
  if (scan.status === "clear") return;
  const shown = args.displayDirectory ?? args.directory;
  if (scan.status === "unknown" || scan.status === "uncertain") {
    if (
      args.ignoreProcessDoubts === true &&
      scan.blockingProcesses !== undefined &&
      scan.blockingProcesses.length > 0
    )
      return;
    const refusalKey = (await args.onDoubt?.(scan)) ?? null;
    const message = `Refusing to ${args.action} ${shown}: whether a process is still using it could not be established (${scan.reason}). Nothing was stopped and nothing was removed.`;
    throw refusalKey === null
      ? new CommandDispatchError("path_in_use", message)
      : new KeyedRefusalError("path_in_use", message, refusalKey);
  }
  throw new CommandDispatchError(
    "path_in_use",
    `Refusing to ${args.action} ${shown}: ${scan.holders.length === 1 ? "a process is" : `${scan.holders.length} processes are`} still using it (${scan.holders
      .slice(0, 5)
      .map((holder) => `pid ${holder.pid} through ${holder.through}`)
      .join("; ")}). Nothing was stopped and nothing was removed.`,
  );
}
