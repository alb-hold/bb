import { scanProcessesWithCwdUnder } from "@bb/process-utils";

export type InternalDoNotUseCwdHolderScan = Awaited<
  ReturnType<typeof scanProcessesWithCwdUnder>
>;

/**
 * First-party plugins only. Looks, without signalling anything, for processes
 * whose working directory is at or under any of `directories`, so a plugin can
 * refuse to delete a tree something still uses. The answer is `clear`, `held`
 * (with the processes) or `unknown` (with why), and only `clear` permits a
 * delete: Windows, a symlinked target, a process list that cannot be read, and
 * an `lsof` failure or warning are `unknown`. `clear` vouches for the current
 * user's readable processes only; other users' processes are excluded and
 * counted, each recorded with pid, uid and errno in `skippedOtherUsers`, and
 * a same-user process whose working directory cannot be read is
 * `unknown` unless its exact `comm` is a known session helper (systemd,
 * (sd-pam), ssh-agent, sshd, sshd-session, gpg-agent, dbus-daemon), which is
 * reported by name and pid. `comm` is settable by the process itself.
 * Processes are classified by effective uid. On macOS the same-user processes
 * come from `ps` and the working directories from `lsof`: a same-user process
 * that `lsof` does not list, that is not a known session helper and that is
 * still alive 200 ms later is `unknown`, naming its pid and command. A process
 * that exits during the scan is ignored. It checks working directories only,
 * not open files. See docs/api_to_audit.md.
 */
export function internal_DO_NOT_USE_scanProcessesWithCwdUnder(args: {
  directories: readonly string[];
}): Promise<InternalDoNotUseCwdHolderScan> {
  return scanProcessesWithCwdUnder({ directories: args.directories });
}
