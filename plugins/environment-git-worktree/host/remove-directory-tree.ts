import { constants } from "node:fs";
import { lstat, open, readdir, rmdir, stat, unlink } from "node:fs/promises";
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

function descriptorRoot(): string | null {
  if (process.platform === "linux") return "/proc/self/fd";
  if (process.platform === "darwin") return "/dev/fd";
  return null;
}

async function descriptorPath(directory: {
  fd: number;
  stat: () => Promise<{ dev: number; ino: number; isDirectory(): boolean }>;
}): Promise<string | null> {
  const root = descriptorRoot();
  if (root === null) return null;
  const descriptor = path.join(root, String(directory.fd));
  try {
    const [openedInfo, descriptorInfo] = await Promise.all([
      directory.stat(),
      stat(descriptor),
    ]);
    return sameDirectory(openedInfo, descriptorInfo) ? descriptor : null;
  } catch {
    return null;
  }
}

async function openDirectory(directory: string) {
  if (
    descriptorRoot() === null ||
    constants.O_DIRECTORY === undefined ||
    constants.O_NOFOLLOW === undefined
  )
    return null;
  try {
    return await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    return null;
  }
}

function sameDirectory(
  left: { dev: number; ino: number; isDirectory(): boolean },
  right: { dev: number; ino: number; isDirectory(): boolean },
): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

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
  const rootName = path.basename(root);
  const parent = await openDirectory(path.dirname(root));
  if (parent === null || rootName === "") {
    await parent?.close();
    return "retained";
  }
  const parentPath = await descriptorPath(parent);
  if (parentPath === null) {
    await parent.close();
    return "retained";
  }
  const removeEntry = async (
    parentDirectory: string,
    name: string,
    entry: string,
    rootEntry = false,
  ): Promise<RemoveDirectoryTreeResult> => {
    const anchoredEntry = path.join(parentDirectory, name);
    let info;
    try {
      info = await lstat(anchoredEntry);
    } catch (error) {
      return errorCode(error) === "ENOENT" ? "removed" : "retained";
    }
    if (!rootEntry && changedSince(info, startedAt)) return "retained";
    if (!info.isDirectory()) {
      try {
        await unlink(anchoredEntry);
        return "removed";
      } catch (error) {
        return errorCode(error) === "ENOENT" ? "removed" : "retained";
      }
    }
    const directory = await openDirectory(anchoredEntry);
    if (directory === null) return "retained";
    try {
      const openedInfo = await directory.stat();
      if (!sameDirectory(info, openedInfo)) return "retained";
      const directoryPath = await descriptorPath(directory);
      if (directoryPath === null) return "retained";
      let currentInfo;
      try {
        currentInfo = await lstat(anchoredEntry);
      } catch {
        return "retained";
      }
      if (!sameDirectory(openedInfo, currentInfo)) return "retained";
      if (!rootEntry && changedSince(openedInfo, startedAt)) return "retained";
      let listed: string[];
      try {
        listed = await readdir(directoryPath);
      } catch (error) {
        return errorCode(error) === "ENOENT" ? "removed" : "retained";
      }
      await hooks.afterDirectoryListed?.(entry, listed);
      try {
        currentInfo = await lstat(anchoredEntry);
      } catch {
        return "retained";
      }
      if (!sameDirectory(openedInfo, currentInfo)) return "retained";
      for (const childName of listed) {
        if (
          (await removeEntry(
            directoryPath,
            childName,
            path.join(entry, childName),
          )) === "retained"
        )
          return "retained";
      }
      let after: string[];
      try {
        after = await readdir(directoryPath);
      } catch (error) {
        return errorCode(error) === "ENOENT" ? "removed" : "retained";
      }
      if (after.some((childName) => !listed.includes(childName)))
        return "retained";
      try {
        currentInfo = await lstat(anchoredEntry);
      } catch {
        return "retained";
      }
      if (!sameDirectory(openedInfo, currentInfo)) return "retained";
      try {
        await rmdir(anchoredEntry);
        return "removed";
      } catch (error) {
        const code = errorCode(error);
        return code === "ENOENT" ? "removed" : "retained";
      }
    } finally {
      await directory.close();
    }
  };
  try {
    return await removeEntry(parentPath, rootName, root, true);
  } finally {
    await parent.close();
  }
}
