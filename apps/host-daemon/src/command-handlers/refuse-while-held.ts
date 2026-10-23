import { listProcessesWithCwdUnder } from "@bb/process-utils";
import { CommandDispatchError } from "../command-dispatch-support.js";

export async function refuseWhileHeld(args: {
  directory: string;
  action: string;
}): Promise<void> {
  const holders = await listProcessesWithCwdUnder({
    directories: [args.directory],
  });
  if (holders.length === 0) return;
  throw new CommandDispatchError(
    "path_in_use",
    `Refusing to ${args.action} ${args.directory}: ${holders.length === 1 ? "a process is" : `${holders.length} processes are`} still working inside it (${holders
      .slice(0, 5)
      .map((holder) => `pid ${holder.pid} in ${holder.cwd}`)
      .join("; ")}). Nothing was stopped and nothing was removed.`,
  );
}
