import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface RemoveDirectoryTreeHooks {
  startedAt?: number;
  rootMetadataBaseline?: { ctimeMs: number; mtimeMs: number };
  afterStart?: (startedAt: number) => Promise<void>;
  afterDirectoryListed?: (
    directory: string,
    entries: readonly string[],
  ) => Promise<void>;
  beforeEntryRemoval?: (entry: string) => Promise<void>;
  afterEntryCheck?: (entry: string) => Promise<void>;
  afterEntryQuarantined?: (entry: string, quarantined: string) => Promise<void>;
  afterRootMarkerDetached?: (root: string) => Promise<void>;
  allowQuarantinedRoot?: true;
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
  if (
    path.basename(root).startsWith(".bb-removing-") &&
    hooks.allowQuarantinedRoot !== true
  )
    return "retained";
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
  const inspectBeforeRemoval = async (
    directory: string,
    rootEntry = false,
  ): Promise<boolean> => {
    let info;
    try {
      info = await lstat(directory);
    } catch {
      return false;
    }
    const rootChangedSinceBaseline =
      rootEntry &&
      hooks.rootMetadataBaseline !== undefined &&
      (info.ctimeMs > hooks.rootMetadataBaseline.ctimeMs ||
        info.mtimeMs > hooks.rootMetadataBaseline.mtimeMs);
    if (
      rootEntry
        ? hooks.rootMetadataBaseline === undefined
          ? changedSince(info, startedAt)
          : rootChangedSinceBaseline
        : changedSince(info, startedAt)
    )
      return false;
    if (!info.isDirectory()) return true;
    const handle = await openDirectory(directory);
    if (handle === null) return false;
    try {
      const openedInfo = await handle.stat();
      if (!sameDirectory(info, openedInfo)) return false;
      const openedPath = await descriptorPath(handle);
      if (openedPath === null) return false;
      const listed = await readdir(openedPath);
      if (listed.some((name) => name.startsWith(".bb-removing-"))) return false;
      await hooks.afterDirectoryListed?.(directory, listed);
      const currentInfo = await lstat(directory);
      if (!sameDirectory(openedInfo, currentInfo)) return false;
      const currentRootChangedSinceBaseline =
        rootEntry &&
        hooks.rootMetadataBaseline !== undefined &&
        (currentInfo.ctimeMs > hooks.rootMetadataBaseline.ctimeMs ||
          currentInfo.mtimeMs > hooks.rootMetadataBaseline.mtimeMs);
      if (
        rootEntry
          ? hooks.rootMetadataBaseline === undefined
            ? changedSince(currentInfo, startedAt)
            : currentRootChangedSinceBaseline
          : changedSince(currentInfo, startedAt)
      )
        return false;
      const afterHook = await readdir(openedPath);
      if (
        afterHook.length !== listed.length ||
        afterHook.some((name) => !listed.includes(name))
      )
        return false;
      for (const name of listed) {
        if (!(await inspectBeforeRemoval(path.join(directory, name))))
          return false;
      }
      return true;
    } catch {
      return false;
    } finally {
      await handle.close();
    }
  };
  if (!(await inspectBeforeRemoval(root, true))) {
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
    const rootChangedSinceBaseline =
      rootEntry &&
      hooks.rootMetadataBaseline !== undefined &&
      (info.ctimeMs > hooks.rootMetadataBaseline.ctimeMs ||
        info.mtimeMs > hooks.rootMetadataBaseline.mtimeMs);
    if (
      rootEntry
        ? (hooks.rootMetadataBaseline === undefined &&
            changedSince(info, startedAt)) ||
          rootChangedSinceBaseline
        : changedSince(info, startedAt)
    ) {
      return "retained";
    }
    if (!info.isDirectory()) {
      let beforeRemovalInfo;
      try {
        beforeRemovalInfo = await lstat(anchoredEntry);
      } catch {
        return "retained";
      }
      if (
        beforeRemovalInfo.dev !== info.dev ||
        beforeRemovalInfo.ino !== info.ino ||
        changedSince(beforeRemovalInfo, startedAt)
      ) {
        return "retained";
      }
      await hooks.beforeEntryRemoval?.(entry);
      let checkedInfo;
      try {
        checkedInfo = await lstat(anchoredEntry);
      } catch {
        return "retained";
      }
      if (
        checkedInfo.dev !== info.dev ||
        checkedInfo.ino !== info.ino ||
        changedSince(checkedInfo, startedAt)
      ) {
        return "retained";
      }
      await hooks.afterEntryCheck?.(entry);
      const quarantined = path.join(
        parentDirectory,
        `.bb-removing-${randomUUID()}`,
      );
      const restoreQuarantine = async (): Promise<boolean> => {
        try {
          await link(quarantined, anchoredEntry);
          await unlink(quarantined);
          return true;
        } catch {
          return false;
        }
      };
      try {
        await rename(anchoredEntry, quarantined);
        const movedInfo = await lstat(quarantined);
        if (
          movedInfo.dev !== checkedInfo.dev ||
          movedInfo.ino !== checkedInfo.ino ||
          movedInfo.ctimeMs !== checkedInfo.ctimeMs ||
          movedInfo.mtimeMs !== checkedInfo.mtimeMs ||
          movedInfo.size !== checkedInfo.size
        ) {
          await restoreQuarantine();
          return "retained";
        }
        const movedPreciseInfo = await lstat(quarantined, { bigint: true });
        await hooks.afterEntryQuarantined?.(entry, quarantined);
        const finalInfo = await lstat(quarantined);
        const finalPreciseInfo = await lstat(quarantined, { bigint: true });
        if (
          finalInfo.dev !== movedInfo.dev ||
          finalInfo.ino !== movedInfo.ino ||
          finalInfo.ctimeMs !== movedInfo.ctimeMs ||
          finalInfo.mtimeMs !== movedInfo.mtimeMs ||
          finalPreciseInfo.ctimeNs !== movedPreciseInfo.ctimeNs
        ) {
          await restoreQuarantine();
          return "retained";
        }
        await unlink(quarantined);
        return "removed";
      } catch (error) {
        await restoreQuarantine();
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
      const openedRootChangedSinceBaseline =
        rootEntry &&
        hooks.rootMetadataBaseline !== undefined &&
        (openedInfo.ctimeMs > hooks.rootMetadataBaseline.ctimeMs ||
          openedInfo.mtimeMs > hooks.rootMetadataBaseline.mtimeMs);
      if (
        rootEntry
          ? (hooks.rootMetadataBaseline === undefined &&
              changedSince(openedInfo, startedAt)) ||
            openedRootChangedSinceBaseline
          : changedSince(openedInfo, startedAt)
      )
        return "retained";
      let listed: string[];
      try {
        listed = await readdir(directoryPath);
      } catch (error) {
        return errorCode(error) === "ENOENT" ? "removed" : "retained";
      }
      if (listed.some((childName) => childName.startsWith(".bb-removing-")))
        return "retained";
      try {
        currentInfo = await lstat(anchoredEntry);
      } catch {
        return "retained";
      }
      if (!sameDirectory(openedInfo, currentInfo)) return "retained";
      const changedDuringListing =
        rootEntry && hooks.rootMetadataBaseline !== undefined
          ? currentInfo.ctimeMs > hooks.rootMetadataBaseline.ctimeMs ||
            currentInfo.mtimeMs > hooks.rootMetadataBaseline.mtimeMs
          : changedSince(currentInfo, startedAt);
      if (changedDuringListing) {
        return "retained";
      }
      let afterHook: string[];
      try {
        afterHook = await readdir(directoryPath);
      } catch {
        return "retained";
      }
      if (
        afterHook.length !== listed.length ||
        afterHook.some((childName) => !listed.includes(childName))
      )
        return "retained";
      const directories: string[] = [];
      const files: string[] = [];
      for (const childName of listed) {
        if (childName === ".git") continue;
        let childInfo;
        try {
          childInfo = await lstat(path.join(directoryPath, childName));
        } catch {
          return "retained";
        }
        (childInfo.isDirectory() ? directories : files).push(childName);
      }
      const removalOrder = [
        ...directories,
        ...files,
        ...(listed.includes(".git") && !rootEntry ? [".git"] : []),
      ];
      for (const childName of removalOrder) {
        const childResult = await removeEntry(
          directoryPath,
          childName,
          path.join(entry, childName),
        );
        if (childResult === "retained") {
          return "retained";
        }
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
      await hooks.beforeEntryRemoval?.(entry);
      let checkedDirectoryInfo;
      try {
        checkedDirectoryInfo = await lstat(anchoredEntry);
      } catch {
        return "retained";
      }
      if (!sameDirectory(openedInfo, checkedDirectoryInfo)) return "retained";
      await hooks.afterEntryCheck?.(entry);
      const quarantined = path.join(
        parentDirectory,
        `.bb-removing-${randomUUID()}`,
      );
      const rootGitMarker =
        rootEntry && listed.includes(".git")
          ? path.join(quarantined, ".git")
          : null;
      const heldGitMarker =
        rootGitMarker === null
          ? null
          : path.join(parentDirectory, `.bb-gitfile-${randomUUID()}`);
      let gitMarkerHeld = false;
      let rootQuarantined = false;
      const restoreQuarantine = async (): Promise<boolean> => {
        try {
          await rename(quarantined, anchoredEntry);
          rootQuarantined = false;
          return true;
        } catch {
          return false;
        }
      };
      const restoreGitMarker = async (rootPath: string): Promise<boolean> => {
        if (!gitMarkerHeld || heldGitMarker === null) return true;
        try {
          await link(heldGitMarker, path.join(rootPath, ".git"));
          await unlink(heldGitMarker);
          gitMarkerHeld = false;
          return true;
        } catch {
          return false;
        }
      };
      const retain = async (): Promise<RemoveDirectoryTreeResult> => {
        await restoreGitMarker(rootQuarantined ? quarantined : anchoredEntry);
        if (rootQuarantined) await restoreQuarantine();
        return "retained";
      };
      try {
        await rename(anchoredEntry, quarantined);
        rootQuarantined = true;
        const movedInfo = await lstat(quarantined);
        let movedEntries: string[];
        try {
          movedEntries = await readdir(directoryPath);
        } catch {
          return await retain();
        }
        if (
          !sameDirectory(openedInfo, movedInfo) ||
          movedInfo.mtimeMs !== checkedDirectoryInfo.mtimeMs ||
          movedEntries.some((name) => name !== ".git") ||
          (rootGitMarker === null && movedEntries.length > 0) ||
          (rootGitMarker !== null &&
            !movedEntries.includes(path.basename(rootGitMarker)))
        ) {
          return await retain();
        }
        let heldMarkerInfo: Awaited<ReturnType<typeof lstat>> | null = null;
        if (rootGitMarker !== null && heldGitMarker !== null) {
          await rename(rootGitMarker, heldGitMarker);
          gitMarkerHeld = true;
          heldMarkerInfo = await lstat(quarantined);
          await hooks.afterRootMarkerDetached?.(quarantined);
        }
        const finalEntries = await readdir(directoryPath);
        const finalDirectoryInfo = await lstat(quarantined);
        if (
          finalEntries.length > 0 ||
          !sameDirectory(openedInfo, finalDirectoryInfo) ||
          (heldMarkerInfo !== null &&
            (finalDirectoryInfo.ctimeMs !== heldMarkerInfo.ctimeMs ||
              finalDirectoryInfo.mtimeMs !== heldMarkerInfo.mtimeMs))
        )
          return await retain();
        await rmdir(quarantined);
        rootQuarantined = false;
        if (heldGitMarker !== null && gitMarkerHeld) {
          await unlink(heldGitMarker);
          gitMarkerHeld = false;
        }
        return "removed";
      } catch (error) {
        await retain();
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
