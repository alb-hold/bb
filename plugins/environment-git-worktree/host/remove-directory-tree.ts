import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

export interface RemoveDirectoryTreeHooks {
  startedAt?: number;
  afterStart?: (startedAt: number) => Promise<void>;
  afterDirectoryListed?: (
    directory: string,
    entries: readonly string[],
  ) => Promise<void>;
}

export type RemoveDirectoryTreeResult = "removed" | "retained";

export async function directoryTreeChangedSince(
  root: string,
  startedAt: number,
): Promise<boolean> {
  const inspect = async (entry: string): Promise<boolean> => {
    let info;
    try {
      info = await lstat(entry);
    } catch {
      return true;
    }
    if (changedSince(info, startedAt)) return true;
    if (!info.isDirectory()) return false;
    let listed: string[];
    try {
      listed = await readdir(entry);
    } catch {
      return true;
    }
    for (const name of listed) {
      if (await inspect(path.join(entry, name))) return true;
    }
    let after: string[];
    try {
      after = await readdir(entry);
    } catch {
      return true;
    }
    return (
      after.length !== listed.length ||
      after.some((name) => !listed.includes(name))
    );
  };
  return inspect(root);
}

function changedSince(
  info: { ctimeMs: number; mtimeMs: number },
  startedAt: number,
): boolean {
  return info.ctimeMs >= startedAt || info.mtimeMs >= startedAt;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

export async function removeDirectoryTree(
  root: string,
  hooks: RemoveDirectoryTreeHooks = {},
): Promise<RemoveDirectoryTreeResult> {
  const startedAt = hooks.startedAt ?? Date.now();
  await hooks.afterStart?.(startedAt);
  const removeEntry = async (
    entry: string,
    rootEntry = false,
  ): Promise<RemoveDirectoryTreeResult> => {
    let info;
    try {
      info = await lstat(entry);
    } catch (error) {
      return errorCode(error) === "ENOENT" ? "removed" : "retained";
    }
    if (!rootEntry && changedSince(info, startedAt)) return "retained";
    if (!info.isDirectory()) {
      try {
        await unlink(entry);
        return "removed";
      } catch (error) {
        return errorCode(error) === "ENOENT" ? "removed" : "retained";
      }
    }
    let listed: string[];
    try {
      listed = await readdir(entry);
    } catch (error) {
      return errorCode(error) === "ENOENT" ? "removed" : "retained";
    }
    await hooks.afterDirectoryListed?.(entry, listed);
    for (const name of listed) {
      if ((await removeEntry(path.join(entry, name))) === "retained")
        return "retained";
    }
    let after: string[];
    try {
      after = await readdir(entry);
    } catch (error) {
      return errorCode(error) === "ENOENT" ? "removed" : "retained";
    }
    if (after.some((name) => !listed.includes(name))) return "retained";
    try {
      await rmdir(entry);
      return "removed";
    } catch (error) {
      const code = errorCode(error);
      return code === "ENOENT" ? "removed" : "retained";
    }
  };
  return removeEntry(root, true);
}
