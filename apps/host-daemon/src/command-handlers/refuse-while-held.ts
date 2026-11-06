import { scanWorktreeHolders } from "@bb/process-utils";
import { CommandDispatchError } from "../command-dispatch-support.js";

export async function refuseWhileHeld(args: {
  directory: string;
  action: string;
}): Promise<void> {
  const scan = await scanWorktreeHolders(args.directory);
  if (scan.status === "clear") return;
  if (scan.status === "unknown" || scan.status === "uncertain") {
    throw new CommandDispatchError(
      "path_in_use",
      `Refusing to ${args.action} ${args.directory}: whether a process is still using it could not be established (${scan.reason}). Nothing was stopped and nothing was removed.`,
    );
  }
  throw new CommandDispatchError(
    "path_in_use",
    `Refusing to ${args.action} ${args.directory}: ${scan.holders.length === 1 ? "a process is" : `${scan.holders.length} processes are`} still using it (${scan.holders
      .slice(0, 5)
      .map((holder) => `pid ${holder.pid} through ${holder.through}`)
      .join("; ")}). Nothing was stopped and nothing was removed.`,
  );
}
