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

export function linuxDirectoryIsTraversable(args: {
  processUid: number;
  processFilesystemGid: number | null;
  processSupplementaryGroups: readonly number[] | null;
  directoryUid: number;
  directoryGid: number;
  mode: number;
  hasExtendedAcl: boolean | null;
}): boolean {
  if (args.hasExtendedAcl !== false) return true;
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

export async function linuxPathHasExtendedAcl(
  target: string,
): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync("getfacl", ["-cp", "--", target], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.split("\n").some((line) =>
      /^(?:user|group):[^:]([^:]*):/.test(line) || /^mask::/.test(line),
    );
  } catch {
    return null;
  }
}
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
