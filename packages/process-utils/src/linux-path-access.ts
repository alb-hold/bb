export function parseLinuxSupplementaryGroups(
  status: string,
): number[] | null {
  const line = /^Groups:[ \t]*(.*)$/mu.exec(status);
  if (line === null) return null;
  const value = line[1]?.trim() ?? "";
  if (value === "") return [];
  const groups = value.split(/\s+/u).map(Number);
  return groups.every(Number.isSafeInteger) ? groups : null;
}

export interface LinuxDirectoryAccess {
  processUid: number;
  processFilesystemGid: number | null;
  processSupplementaryGroups: readonly number[] | null;
  directoryUid: number;
  directoryGid: number;
  mode: number;
}

export function linuxDirectoryModeAllowsTraversal(
  args: LinuxDirectoryAccess,
): boolean {
  const permissions = args.mode & 0o777;
  if (args.directoryUid === args.processUid && (permissions & 0o100) !== 0)
    return true;
  if ((permissions & 0o001) !== 0) return true;
  if ((permissions & 0o010) === 0) return false;
  if (args.processFilesystemGid === null) return true;
  if (args.processFilesystemGid === args.directoryGid) return true;
  return (
    args.processSupplementaryGroups === null ||
    args.processSupplementaryGroups.includes(args.directoryGid)
  );
}

export function linuxDirectoryIsTraversable(
  args: LinuxDirectoryAccess & { hasExtendedAcl: boolean | null },
): boolean {
  return (
    args.hasExtendedAcl !== false || linuxDirectoryModeAllowsTraversal(args)
  );
}

export async function linuxPathHasExtendedAcl(
  target: string,
): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync(
      "python3",
      [
        "-c",
        "import errno,os,sys\ntry:\n os.getxattr(sys.argv[1], 'system.posix_acl_access')\n print('1')\nexcept OSError as e:\n print('0') if e.errno in (errno.ENODATA, errno.ENOTSUP, errno.EOPNOTSUPP) else sys.exit(1)",
        target,
      ],
      {
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const value = stdout.trim();
    if (value === "1") return true;
    if (value === "0") return false;
    return null;
  } catch {
    return null;
  }
}
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
