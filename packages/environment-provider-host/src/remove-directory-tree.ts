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
  beforeEntryRename?: (entry: string) => Promise<void>;
  afterEntryCheck?: (entry: string) => Promise<void>;
  afterEntryQuarantined?: (entry: string, quarantined: string) => Promise<void>;
  afterParentVerified?: (entry: string, quarantined: string) => Promise<void>;
  afterRestoreNameCheck?: (
    source: string,
    destination: string,
    isDirectory: boolean,
  ) => Promise<void>;
  afterGitMarkerLinked?: (source: string, destination: string) => Promise<void>;
  readDirectoryNames?: (directory: string) => Promise<string[]>;
  onRetainedPath?: (retainedPath: string) => void;
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

function matchesQuarantinedNames(
  actual: readonly string[],
  expected: ReadonlySet<string>,
  originalName: string,
  quarantinedName: string,
): boolean {
  if (!expected.has(originalName)) return false;
  const afterRename = new Set(expected);
  afterRename.delete(originalName);
  afterRename.add(quarantinedName);
  return (
    actual.length === afterRename.size &&
    actual.every((name) => afterRename.has(name))
  );
}

export async function removeDirectoryTree(
  root: string,
  hooks: RemoveDirectoryTreeHooks = {},
): Promise<RemoveDirectoryTreeResult> {
  const startedAt = hooks.startedAt ?? Date.now();
  const readDirectoryNames = hooks.readDirectoryNames ?? readdir;
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
      const listed = await readDirectoryNames(openedPath);
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
      const afterHook = await readDirectoryNames(openedPath);
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
    expectedSiblingNames?: ReadonlySet<string>,
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
    let beforeRemovalHookCalled = false;
    if (info.isDirectory() && expectedSiblingNames !== undefined) {
      await hooks.beforeEntryRemoval?.(entry);
      beforeRemovalHookCalled = true;
      let siblings: string[];
      try {
        siblings = await readDirectoryNames(parentDirectory);
      } catch {
        return "retained";
      }
      if (siblings.some((sibling) => !expectedSiblingNames.has(sibling)))
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
      if (expectedSiblingNames !== undefined) {
        let siblings: string[];
        try {
          siblings = await readDirectoryNames(parentDirectory);
        } catch {
          return "retained";
        }
        if (siblings.some((sibling) => !expectedSiblingNames.has(sibling)))
          return "retained";
      }
      let checkedPreciseInfo;
      try {
        checkedPreciseInfo = await lstat(anchoredEntry, { bigint: true });
      } catch {
        return "retained";
      }
      if (
        Number(checkedPreciseInfo.dev) !== info.dev ||
        Number(checkedPreciseInfo.ino) !== info.ino ||
        changedSince(
          {
            ctimeMs: Number(checkedPreciseInfo.ctimeNs) / 1_000_000,
            mtimeMs: Number(checkedPreciseInfo.mtimeNs) / 1_000_000,
          },
          startedAt,
        )
      ) {
        return "retained";
      }
      await hooks.afterEntryCheck?.(entry);
      let beforeChmodInfo;
      try {
        beforeChmodInfo = await lstat(anchoredEntry, { bigint: true });
      } catch {
        return "retained";
      }
      if (
        beforeChmodInfo.dev !== checkedPreciseInfo.dev ||
        beforeChmodInfo.ino !== checkedPreciseInfo.ino ||
        beforeChmodInfo.ctimeNs !== checkedPreciseInfo.ctimeNs ||
        beforeChmodInfo.mtimeNs !== checkedPreciseInfo.mtimeNs ||
        beforeChmodInfo.size !== checkedPreciseInfo.size ||
        beforeChmodInfo.mode !== checkedPreciseInfo.mode
      ) {
        return "retained";
      }
      const originalMode = checkedPreciseInfo.mode & 0o7777n;
      const strippedMode = checkedPreciseInfo.isFile()
        ? originalMode & ~0o222n
        : originalMode;
      let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
      let modeChanged = false;
      const quarantined = path.join(
        parentDirectory,
        `.bb-removing-${randomUUID()}`,
      );
      const restoreQuarantine = async (): Promise<boolean> => {
        if (modeChanged && fileHandle !== null) {
          try {
            await fileHandle.chmod(Number(originalMode));
          } catch {
            hooks.onRetainedPath?.(
              path.join(path.dirname(entry), path.basename(quarantined)),
            );
            return false;
          }
        }
        try {
          await lstat(anchoredEntry);
          hooks.onRetainedPath?.(
            path.join(path.dirname(entry), path.basename(quarantined)),
          );
          return false;
        } catch (error) {
          if (errorCode(error) !== "ENOENT") {
            hooks.onRetainedPath?.(
              path.join(path.dirname(entry), path.basename(quarantined)),
            );
            return false;
          }
        }
        try {
          await hooks.afterRestoreNameCheck?.(
            quarantined,
            anchoredEntry,
            false,
          );
          await link(quarantined, anchoredEntry);
          hooks.onRetainedPath?.(
            path.join(path.dirname(entry), path.basename(quarantined)),
          );
          return true;
        } catch {
          hooks.onRetainedPath?.(
            path.join(path.dirname(entry), path.basename(quarantined)),
          );
          return false;
        }
      };
      try {
        if (checkedPreciseInfo.isFile()) {
          fileHandle = await open(
            anchoredEntry,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
          );
          const openedInfo = await fileHandle.stat({ bigint: true });
          if (
            openedInfo.dev !== checkedPreciseInfo.dev ||
            openedInfo.ino !== checkedPreciseInfo.ino ||
            openedInfo.size !== checkedPreciseInfo.size ||
            openedInfo.mtimeNs !== checkedPreciseInfo.mtimeNs ||
            openedInfo.ctimeNs !== checkedPreciseInfo.ctimeNs ||
            openedInfo.mode !== checkedPreciseInfo.mode
          ) {
            await fileHandle.close();
            fileHandle = null;
            return "retained";
          }
          await fileHandle.chmod(Number(strippedMode));
          modeChanged = strippedMode !== originalMode;
        } else if (!checkedPreciseInfo.isSymbolicLink()) {
          return "retained";
        }
        const afterChmodInfo = await lstat(anchoredEntry, { bigint: true });
        if (
          afterChmodInfo.dev !== checkedPreciseInfo.dev ||
          afterChmodInfo.ino !== checkedPreciseInfo.ino ||
          afterChmodInfo.size !== checkedPreciseInfo.size ||
          afterChmodInfo.mtimeNs !== checkedPreciseInfo.mtimeNs ||
          (afterChmodInfo.mode & 0o7777n) !== strippedMode ||
          afterChmodInfo.ctimeNs < checkedPreciseInfo.ctimeNs
        ) {
          await restoreQuarantine();
          return "retained";
        }
        await hooks.beforeEntryRename?.(entry);
        let beforeRenameInfo;
        try {
          beforeRenameInfo = await lstat(anchoredEntry, { bigint: true });
        } catch {
          await restoreQuarantine();
          return "retained";
        }
        if (
          beforeRenameInfo.dev !== afterChmodInfo.dev ||
          beforeRenameInfo.ino !== afterChmodInfo.ino ||
          beforeRenameInfo.size !== afterChmodInfo.size ||
          beforeRenameInfo.mtimeNs !== afterChmodInfo.mtimeNs ||
          beforeRenameInfo.ctimeNs !== afterChmodInfo.ctimeNs ||
          (beforeRenameInfo.mode & 0o7777n) !== strippedMode
        ) {
          await restoreQuarantine();
          return "retained";
        }
        await rename(anchoredEntry, quarantined);
        const verifyMovedEntry = async (): Promise<boolean> => {
          if (expectedSiblingNames !== undefined) {
            let siblingNames: string[];
            try {
              siblingNames = await readDirectoryNames(parentDirectory);
            } catch {
              return false;
            }
            if (
              !matchesQuarantinedNames(
                siblingNames,
                expectedSiblingNames,
                path.basename(anchoredEntry),
                path.basename(quarantined),
              )
            )
              return false;
          }
          let movedInfo;
          try {
            movedInfo = await lstat(quarantined, { bigint: true });
          } catch {
            return false;
          }
          return (
            movedInfo.dev === checkedPreciseInfo.dev &&
            movedInfo.ino === checkedPreciseInfo.ino &&
            movedInfo.size === checkedPreciseInfo.size &&
            movedInfo.mtimeNs === checkedPreciseInfo.mtimeNs &&
            (movedInfo.mode & 0o7777n) === strippedMode
          );
        };
        if (!(await verifyMovedEntry())) {
          await restoreQuarantine();
          return "retained";
        }
        await hooks.afterEntryQuarantined?.(entry, quarantined);
        if (!(await verifyMovedEntry())) {
          await restoreQuarantine();
          return "retained";
        }
        await hooks.afterParentVerified?.(entry, quarantined);
        await unlink(quarantined);
        return "removed";
      } catch {
        await restoreQuarantine();
        return "retained";
      } finally {
        await fileHandle?.close();
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
        listed = await readDirectoryNames(directoryPath);
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
        afterHook = await readDirectoryNames(directoryPath);
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
      const remainingNames = new Set(listed);
      for (const childName of removalOrder) {
        let currentNames: string[];
        try {
          currentNames = await readDirectoryNames(directoryPath);
        } catch {
          return "retained";
        }
        if (currentNames.some((current) => !remainingNames.has(current)))
          return "retained";
        const childResult = await removeEntry(
          directoryPath,
          childName,
          path.join(entry, childName),
          false,
          remainingNames,
        );
        if (childResult === "retained") {
          return "retained";
        }
        remainingNames.delete(childName);
      }
      let after: string[];
      try {
        after = await readDirectoryNames(directoryPath);
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
      if (!beforeRemovalHookCalled) await hooks.beforeEntryRemoval?.(entry);
      if (expectedSiblingNames !== undefined) {
        let siblings: string[];
        try {
          siblings = await readDirectoryNames(parentDirectory);
        } catch {
          return "retained";
        }
        if (siblings.some((sibling) => !expectedSiblingNames.has(sibling)))
          return "retained";
      }
      let checkedDirectoryInfo;
      try {
        checkedDirectoryInfo = await lstat(anchoredEntry);
      } catch {
        return "retained";
      }
      if (!sameDirectory(openedInfo, checkedDirectoryInfo)) return "retained";
      await hooks.afterEntryCheck?.(entry);
      let checkedDirectoryPreciseInfo;
      try {
        checkedDirectoryPreciseInfo = await lstat(anchoredEntry, {
          bigint: true,
        });
      } catch {
        return "retained";
      }
      if (
        checkedDirectoryPreciseInfo.dev !== BigInt(openedInfo.dev) ||
        checkedDirectoryPreciseInfo.ino !== BigInt(openedInfo.ino)
      )
        return "retained";
      const originalDirectoryMode = checkedDirectoryPreciseInfo.mode & 0o7777n;
      const strippedDirectoryMode = rootEntry
        ? originalDirectoryMode
        : originalDirectoryMode & ~0o222n;
      let directoryModeChanged = false;
      try {
        await directory.chmod(Number(strippedDirectoryMode));
        directoryModeChanged = strippedDirectoryMode !== originalDirectoryMode;
      } catch {
        return "retained";
      }
      let afterChmodDirectoryInfo;
      try {
        afterChmodDirectoryInfo = await lstat(anchoredEntry, {
          bigint: true,
        });
      } catch {
        if (directoryModeChanged)
          await directory.chmod(Number(originalDirectoryMode));
        return "retained";
      }
      if (
        afterChmodDirectoryInfo.dev !== checkedDirectoryPreciseInfo.dev ||
        afterChmodDirectoryInfo.ino !== checkedDirectoryPreciseInfo.ino ||
        afterChmodDirectoryInfo.size !== checkedDirectoryPreciseInfo.size ||
        afterChmodDirectoryInfo.mtimeNs !==
          checkedDirectoryPreciseInfo.mtimeNs ||
        (afterChmodDirectoryInfo.mode & 0o7777n) !== strippedDirectoryMode ||
        afterChmodDirectoryInfo.ctimeNs < checkedDirectoryPreciseInfo.ctimeNs
      ) {
        if (directoryModeChanged)
          await directory.chmod(Number(originalDirectoryMode));
        return "retained";
      }
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
        if (directoryModeChanged)
          await directory.chmod(Number(originalDirectoryMode));
        try {
          await lstat(anchoredEntry);
          hooks.onRetainedPath?.(
            path.join(path.dirname(entry), path.basename(quarantined)),
          );
          return false;
        } catch (error) {
          if (errorCode(error) !== "ENOENT") {
            hooks.onRetainedPath?.(
              path.join(path.dirname(entry), path.basename(quarantined)),
            );
            return false;
          }
        }
        try {
          await hooks.afterRestoreNameCheck?.(
            quarantined,
            anchoredEntry,
            true,
          );
          await rename(quarantined, anchoredEntry);
          rootQuarantined = false;
          return true;
        } catch {
          hooks.onRetainedPath?.(
            path.join(path.dirname(entry), path.basename(quarantined)),
          );
          return false;
        }
      };
      const restoreGitMarker = async (rootPath: string): Promise<boolean> => {
        if (!gitMarkerHeld || heldGitMarker === null) return true;
        const destination = path.join(rootPath, ".git");
        try {
          await link(heldGitMarker, destination);
          hooks.onRetainedPath?.(
            path.join(path.dirname(entry), path.basename(heldGitMarker)),
          );
          await hooks.afterGitMarkerLinked?.(heldGitMarker, destination);
          return true;
        } catch {
          hooks.onRetainedPath?.(
            path.join(path.dirname(entry), path.basename(heldGitMarker)),
          );
          return false;
        }
      };
      const retain = async (): Promise<RemoveDirectoryTreeResult> => {
        await restoreGitMarker(rootQuarantined ? quarantined : anchoredEntry);
        if (rootQuarantined) await restoreQuarantine();
        if (directoryModeChanged)
          await directory.chmod(Number(originalDirectoryMode));
        return "retained";
      };
      try {
        await hooks.beforeEntryRename?.(entry);
        let beforeRenameDirectoryInfo;
        try {
          beforeRenameDirectoryInfo = await lstat(anchoredEntry, {
            bigint: true,
          });
        } catch {
          return await retain();
        }
        if (
          beforeRenameDirectoryInfo.dev !== afterChmodDirectoryInfo.dev ||
          beforeRenameDirectoryInfo.ino !== afterChmodDirectoryInfo.ino ||
          beforeRenameDirectoryInfo.size !== afterChmodDirectoryInfo.size ||
          beforeRenameDirectoryInfo.mtimeNs !==
            afterChmodDirectoryInfo.mtimeNs ||
          beforeRenameDirectoryInfo.ctimeNs !==
            afterChmodDirectoryInfo.ctimeNs ||
          (beforeRenameDirectoryInfo.mode & 0o7777n) !== strippedDirectoryMode
        )
          return await retain();
        await rename(anchoredEntry, quarantined);
        rootQuarantined = true;
        await hooks.afterEntryQuarantined?.(entry, quarantined);
        if (expectedSiblingNames !== undefined) {
          let siblingNames: string[];
          try {
            siblingNames = await readDirectoryNames(parentDirectory);
          } catch {
            return await retain();
          }
          if (
            !matchesQuarantinedNames(
              siblingNames,
              expectedSiblingNames,
              path.basename(anchoredEntry),
              path.basename(quarantined),
            )
          )
            return await retain();
        }
        const movedInfo = await lstat(quarantined, { bigint: true });
        let movedEntries: string[];
        try {
          movedEntries = await readDirectoryNames(directoryPath);
        } catch {
          return await retain();
        }
        if (
          movedInfo.dev !== checkedDirectoryPreciseInfo.dev ||
          movedInfo.ino !== checkedDirectoryPreciseInfo.ino ||
          movedInfo.size !== checkedDirectoryPreciseInfo.size ||
          movedInfo.mtimeNs !== checkedDirectoryPreciseInfo.mtimeNs ||
          (movedInfo.mode & 0o7777n) !== strippedDirectoryMode ||
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
        const finalEntries = await readDirectoryNames(directoryPath);
        const finalDirectoryInfo = await lstat(quarantined);
        if (
          finalEntries.length > 0 ||
          !sameDirectory(openedInfo, finalDirectoryInfo) ||
          (heldMarkerInfo !== null &&
            (finalDirectoryInfo.ctimeMs !== heldMarkerInfo.ctimeMs ||
              finalDirectoryInfo.mtimeMs !== heldMarkerInfo.mtimeMs))
        ) {
          return await retain();
        }
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
