import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  link,
  lstat,
  open,
  readdir,
  readlink,
  rename,
  rmdir,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

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
  beforeQuarantineRestoreLink?: (
    source: string,
    destination: string,
  ) => Promise<void>;
  beforeGitMarkerRestoreLink?: (
    source: string,
    destination: string,
  ) => Promise<void>;
  afterGitMarkerLinked?: (source: string, destination: string) => Promise<void>;
  beforeQuarantinePinLink?: (source: string, pin: string) => Promise<void>;
  recoveryLink?: (pin: string, destination: string) => Promise<void>;
  recoveryWrite?: (
    destination: FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ bytesWritten: number }>;
  beforePinCleanup?: (pin: string, restoredPath: string) => Promise<void>;
  createPinSuffix?: () => string;
  createRecoverySuffix?: () => string;
  readDirectoryNames?: (directory: string) => Promise<string[]>;
  onRetainedPath?: (retainedPath: string) => void;
  afterRootMarkerDetached?: (root: string) => Promise<void>;
  allowQuarantinedRoot?: true;
}

export interface RemoveDirectoryTreeResult {
  status: "removed" | "retained";
  retainedPaths: string[];
}

type RemoveEntryResult = RemoveDirectoryTreeResult["status"];

export class RetainedRecoveryError extends Error {
  readonly retainedPaths: string[];

  constructor(message: string, retainedPaths: string[]) {
    super(message);
    this.name = "RetainedRecoveryError";
    this.retainedPaths = retainedPaths;
  }
}

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

async function createRecoveredEntry(
  parentDirectory: string,
  create: (candidate: string) => Promise<void>,
  hooks: RemoveDirectoryTreeHooks,
): Promise<string> {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const suffix =
      hooks.createRecoverySuffix?.() ??
      randomUUID().replaceAll("-", "").slice(0, 8);
    if (!/^[0-9a-f]{8}$/iu.test(suffix))
      throw new Error(
        "Recovery suffix must contain eight hexadecimal characters",
      );
    const candidate = path.join(parentDirectory, `.bb-recovered-${suffix}`);
    try {
      await create(candidate);
      return candidate;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not allocate a unique recovered entry name");
}

async function recoverFileFromHandle(
  parentDirectory: string,
  source: FileHandle,
  mode: bigint,
  hooks: RemoveDirectoryTreeHooks,
): Promise<string> {
  return createRecoveredEntry(
    parentDirectory,
    async (candidate) => {
      const destination = await open(candidate, "wx+", Number(mode));
      await copyRecoveredFile(destination, source, mode, candidate, hooks);
    },
    hooks,
  );
}

async function copyRecoveredFile(
  destination: FileHandle,
  source: FileHandle,
  mode: bigint,
  candidate: string,
  hooks: RemoveDirectoryTreeHooks,
): Promise<void> {
  const destinationInfo = await destination.stat({ bigint: true });
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await (hooks.recoveryWrite?.(
          destination,
          buffer,
          written,
          bytesRead - written,
          position + written,
        ) ??
          destination.write(
            buffer,
            written,
            bytesRead - written,
            position + written,
          ));
        if (result.bytesWritten === 0)
          throw new Error("Could not write recovered file contents");
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await destination.chmod(Number(mode));
    await verifyFileContents(destination, source);
  } catch (error) {
    await destination.close().catch(() => undefined);
    await removePathIfSame(candidate, destinationInfo).catch(() => false);
    throw error;
  } finally {
    await destination.close().catch(() => undefined);
  }
}

async function hashFileHandle(
  handle: FileHandle,
  size: bigint,
): Promise<string> {
  if (size > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("File is too large to verify recovered contents");
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  const expectedSize = Number(size);
  while (position < expectedSize) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, expectedSize - position),
      position,
    );
    if (bytesRead === 0) throw new Error("File changed while hashing contents");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

async function verifyFileContents(
  recovered: FileHandle,
  original: FileHandle,
): Promise<void> {
  const [recoveredInfo, originalInfo] = await Promise.all([
    recovered.stat({ bigint: true }),
    original.stat({ bigint: true }),
  ]);
  if (
    recoveredInfo.size !== originalInfo.size ||
    (await hashFileHandle(recovered, recoveredInfo.size)) !==
      (await hashFileHandle(original, originalInfo.size))
  )
    throw new Error("Recovered file contents do not match the held original");
}

async function verifyPathContents(
  candidate: string,
  original: FileHandle,
): Promise<void> {
  const info = await lstat(candidate, { bigint: true });
  if (!info.isFile())
    throw new Error(`Recovered path is not a file: ${candidate}`);
  const recovered = await open(
    candidate,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    await verifyFileContents(recovered, original);
  } finally {
    await recovered.close();
  }
}

async function removePathIfSame(
  pathname: string,
  expected: {
    dev: bigint;
    ino: bigint;
  },
): Promise<boolean> {
  try {
    const current = await lstat(pathname, { bigint: true });
    if (current.dev !== expected.dev || current.ino !== expected.ino)
      return false;
    await unlink(pathname);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
}

async function createPinFromPath(
  parentDirectory: string,
  sourcePath: string,
  expected: { dev: bigint; ino: bigint },
  heldHandle: FileHandle | null,
  hooks: RemoveDirectoryTreeHooks,
): Promise<{ pin: string | null; mismatchPath?: string }> {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const suffix =
      hooks.createPinSuffix?.() ?? randomUUID().replaceAll("-", "").slice(0, 8);
    if (!/^[0-9a-f]{8}$/u.test(suffix))
      throw new Error(
        "Recovery pin suffix must contain eight hexadecimal characters",
      );
    const pin = path.join(parentDirectory, `.bb-pin-${suffix}`);
    try {
      await hooks.beforeQuarantinePinLink?.(sourcePath, pin);
      await link(sourcePath, pin);
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      if (["EXDEV", "EPERM", "EMLINK"].includes(errorCode(error) ?? ""))
        return { pin: null };
      throw error;
    }
    const pinInfo = await lstat(pin, { bigint: true });
    const heldInfo =
      heldHandle === null ? expected : await heldHandle.stat({ bigint: true });
    if (pinInfo.dev === heldInfo.dev && pinInfo.ino === heldInfo.ino)
      return { pin };
    if (!(await removePathIfSame(pin, pinInfo)))
      return { pin: null, mismatchPath: pin };
    return { pin: null };
  }
  throw new Error("Could not allocate a unique worktree recovery pin");
}

async function recoverFileFromPin(
  parentDirectory: string,
  pin: string,
  source: FileHandle,
  mode: bigint,
  hooks: RemoveDirectoryTreeHooks,
): Promise<string> {
  return createRecoveredEntry(
    parentDirectory,
    async (candidate) => {
      try {
        await (hooks.recoveryLink?.(pin, candidate) ?? link(pin, candidate));
      } catch (error) {
        if (!["EXDEV", "EPERM", "EMLINK"].includes(errorCode(error) ?? ""))
          throw error;
        const destination = await open(candidate, "wx+", Number(mode));
        await copyRecoveredFile(destination, source, mode, candidate, hooks);
        return;
      }
      const [pinInfo, candidateInfo, heldInfo] = await Promise.all([
        lstat(pin, { bigint: true }),
        lstat(candidate, { bigint: true }),
        source.stat({ bigint: true }),
      ]);
      if (
        pinInfo.dev !== heldInfo.dev ||
        pinInfo.ino !== heldInfo.ino ||
        candidateInfo.dev !== heldInfo.dev ||
        candidateInfo.ino !== heldInfo.ino
      )
        throw new Error(`Recovery pin identity changed at ${pin}`);
      const recovered = await open(
        candidate,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        await verifyFileContents(recovered, source);
      } finally {
        await recovered.close();
      }
    },
    hooks,
  );
}

async function recoverSymlink(
  parentDirectory: string,
  target: string,
  hooks: RemoveDirectoryTreeHooks,
): Promise<string> {
  return createRecoveredEntry(
    parentDirectory,
    async (candidate) => {
      await symlink(target, candidate);
    },
    hooks,
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
  additionalNames: readonly string[] = [],
): boolean {
  if (!expected.has(originalName)) return false;
  const afterRename = new Set(expected);
  for (const name of additionalNames) afterRename.add(name);
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
  const retainedPaths = new Set<string>();
  const activePins = new Set<string>();
  const displayPathMappings = new Map<string, string>();
  const displayPath = (candidate: string): string => {
    const mapping = [...displayPathMappings]
      .filter(
        ([source]) =>
          candidate === source || candidate.startsWith(`${source}${path.sep}`),
      )
      .sort(([left], [right]) => right.length - left.length)[0];
    return mapping === undefined
      ? candidate
      : path.join(mapping[1], path.relative(mapping[0], candidate));
  };
  const reportRetainedPath = (retainedPath: string) => {
    const displayed = displayPath(retainedPath);
    retainedPaths.add(displayed);
    hooks.onRetainedPath?.(displayed);
  };
  const result = (status: RemoveEntryResult): RemoveDirectoryTreeResult => {
    if (status === "retained" && retainedPaths.size === 0)
      reportRetainedPath(root);
    return { status, retainedPaths: [...retainedPaths] };
  };
  await hooks.afterStart?.(startedAt);
  if (
    path.basename(root).startsWith(".bb-removing-") &&
    hooks.allowQuarantinedRoot !== true
  )
    return result("retained");
  const rootName = path.basename(root);
  const parent = await openDirectory(path.dirname(root));
  if (parent === null || rootName === "") {
    await parent?.close();
    return result("retained");
  }
  const parentPath = await descriptorPath(parent);
  if (parentPath === null) {
    await parent.close();
    return result("retained");
  }
  displayPathMappings.set(parentPath, path.dirname(path.resolve(root)));
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
      displayPathMappings.set(openedPath, path.resolve(directory));
      const listed = await readDirectoryNames(openedPath);
      if (listed.some((name) => name.startsWith(".bb-removing-"))) return false;
      const stalePin = listed.find(
        (name) =>
          name.startsWith(".bb-pin-") &&
          !activePins.has(path.join(directory, name)),
      );
      if (stalePin !== undefined) {
        reportRetainedPath(path.join(directory, stalePin));
        return false;
      }
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
    return result("retained");
  }
  const removeEntry = async (
    parentDirectory: string,
    name: string,
    entry: string,
    rootEntry = false,
    expectedSiblingNames?: ReadonlySet<string>,
  ): Promise<RemoveEntryResult> => {
    const retainedEntry = (): RemoveEntryResult => {
      reportRetainedPath(entry);
      return "retained";
    };
    const anchoredEntry = path.join(parentDirectory, name);
    let info;
    try {
      info = await lstat(anchoredEntry);
    } catch (error) {
      return errorCode(error) === "ENOENT" ? "removed" : retainedEntry();
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
      return retainedEntry();
    }
    let beforeRemovalHookCalled = false;
    if (info.isDirectory() && expectedSiblingNames !== undefined) {
      await hooks.beforeEntryRemoval?.(entry);
      beforeRemovalHookCalled = true;
      let siblings: string[];
      try {
        siblings = await readDirectoryNames(parentDirectory);
      } catch {
        return retainedEntry();
      }
      if (siblings.some((sibling) => !expectedSiblingNames.has(sibling)))
        return retainedEntry();
    }
    if (!info.isDirectory()) {
      let beforeRemovalInfo;
      try {
        beforeRemovalInfo = await lstat(anchoredEntry);
      } catch {
        return retainedEntry();
      }
      if (
        beforeRemovalInfo.dev !== info.dev ||
        beforeRemovalInfo.ino !== info.ino ||
        changedSince(beforeRemovalInfo, startedAt)
      ) {
        return retainedEntry();
      }
      await hooks.beforeEntryRemoval?.(entry);
      if (expectedSiblingNames !== undefined) {
        let siblings: string[];
        try {
          siblings = await readDirectoryNames(parentDirectory);
        } catch {
          return retainedEntry();
        }
        if (siblings.some((sibling) => !expectedSiblingNames.has(sibling)))
          return retainedEntry();
      }
      let checkedPreciseInfo;
      try {
        checkedPreciseInfo = await lstat(anchoredEntry, { bigint: true });
      } catch {
        return retainedEntry();
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
        return retainedEntry();
      }
      await hooks.afterEntryCheck?.(entry);
      let beforeChmodInfo;
      try {
        beforeChmodInfo = await lstat(anchoredEntry, { bigint: true });
      } catch {
        return retainedEntry();
      }
      if (
        beforeChmodInfo.dev !== checkedPreciseInfo.dev ||
        beforeChmodInfo.ino !== checkedPreciseInfo.ino ||
        beforeChmodInfo.ctimeNs !== checkedPreciseInfo.ctimeNs ||
        beforeChmodInfo.mtimeNs !== checkedPreciseInfo.mtimeNs ||
        beforeChmodInfo.size !== checkedPreciseInfo.size ||
        beforeChmodInfo.mode !== checkedPreciseInfo.mode
      ) {
        return retainedEntry();
      }
      const originalMode = checkedPreciseInfo.mode & 0o7777n;
      const strippedMode = checkedPreciseInfo.isFile()
        ? originalMode & ~0o222n
        : originalMode;
      let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
      let modeChanged = false;
      let symbolicLinkTarget: string | null = null;
      let recoveryPin: string | null = null;
      if (checkedPreciseInfo.isSymbolicLink()) {
        try {
          symbolicLinkTarget = await readlink(anchoredEntry);
        } catch {
          return retainedEntry();
        }
      }
      const quarantined = path.join(
        parentDirectory,
        `.bb-removing-${randomUUID()}`,
      );
      const pinFailure = async (
        reason: string,
        extraPaths: string[] = [],
      ): Promise<RetainedRecoveryError> => {
        const expected =
          fileHandle === null
            ? checkedPreciseInfo
            : await fileHandle.stat({ bigint: true });
        const candidates: Array<string | null> = [
          anchoredEntry,
          quarantined,
          recoveryPin,
          ...extraPaths,
        ];
        const retained: string[] = [];
        for (const candidate of candidates) {
          if (candidate === null || retained.includes(candidate)) continue;
          try {
            const current = await lstat(candidate, { bigint: true });
            if (current.dev === expected.dev && current.ino === expected.ino)
              retained.push(displayPath(candidate));
          } catch {}
        }
        if (retained.length === 0 && recoveryPin !== null)
          retained.push(displayPath(recoveryPin));
        if (retained.length === 0) retained.push(displayPath(quarantined));
        for (const candidate of retained) reportRetainedPath(candidate);
        return new RetainedRecoveryError(
          `${reason}; original retained at ${retained.join(", ")}`,
          retained,
        );
      };
      const cleanupPin = async (restoredPath: string): Promise<void> => {
        if (recoveryPin === null) return;
        await hooks.beforePinCleanup?.(recoveryPin, restoredPath);
        const expected =
          fileHandle === null
            ? checkedPreciseInfo
            : await fileHandle.stat({ bigint: true });
        const pinInfo = await lstat(recoveryPin, { bigint: true });
        if (pinInfo.dev !== expected.dev || pinInfo.ino !== expected.ino)
          throw await pinFailure(
            "Recovery pin identity changed before cleanup",
          );
        await unlink(recoveryPin);
        activePins.delete(recoveryPin);
        recoveryPin = null;
      };
      const recoverFromPin = async (): Promise<boolean> => {
        if (recoveryPin === null)
          throw await pinFailure("No verified recovery pin is available");
        try {
          let recoveredPath: string;
          if (fileHandle === null) {
            recoveredPath = await recoverSymlink(
              parentDirectory,
              symbolicLinkTarget ?? "",
              hooks,
            );
            if ((await readlink(recoveredPath)) !== symbolicLinkTarget)
              throw new Error("Recovered symbolic link target did not match");
          } else {
            recoveredPath = await recoverFileFromPin(
              parentDirectory,
              recoveryPin,
              fileHandle,
              originalMode,
              hooks,
            );
          }
          reportRetainedPath(recoveredPath);
          await cleanupPin(recoveredPath);
          reportRetainedPath(entry);
          reportRetainedPath(quarantined);
          return false;
        } catch (error) {
          if (error instanceof RetainedRecoveryError) throw error;
          throw await pinFailure(
            `Recovery failed for ${entry}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };
      const restoreQuarantine = async (): Promise<boolean> => {
        if (modeChanged && fileHandle !== null) {
          try {
            await fileHandle.chmod(Number(originalMode));
            modeChanged = false;
          } catch {
            throw await pinFailure("Could not restore the original file mode");
          }
        }
        try {
          await lstat(anchoredEntry);
          return await recoverFromPin();
        } catch (error) {
          if (error instanceof RetainedRecoveryError) throw error;
          if (errorCode(error) !== "ENOENT")
            throw await pinFailure("Could not inspect the restore name");
        }
        try {
          await hooks.afterRestoreNameCheck?.(
            quarantined,
            anchoredEntry,
            false,
          );
          await hooks.beforeQuarantineRestoreLink?.(
            recoveryPin ?? quarantined,
            anchoredEntry,
          );
          if (recoveryPin === null)
            throw await pinFailure("No verified recovery pin is available");
          await link(recoveryPin, anchoredEntry);
          const linkedInfo = await lstat(anchoredEntry, { bigint: true });
          const heldInfo =
            fileHandle === null
              ? checkedPreciseInfo
              : await fileHandle.stat({ bigint: true });
          if (
            linkedInfo.dev !== heldInfo.dev ||
            linkedInfo.ino !== heldInfo.ino
          )
            return await recoverFromPin();
          if (fileHandle !== null)
            await verifyPathContents(anchoredEntry, fileHandle);
          else if ((await readlink(anchoredEntry)) !== symbolicLinkTarget)
            return await recoverFromPin();
          reportRetainedPath(anchoredEntry);
          reportRetainedPath(quarantined);
          await cleanupPin(anchoredEntry);
          return true;
        } catch (error) {
          if (error instanceof RetainedRecoveryError) throw error;
          return await recoverFromPin();
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
            return retainedEntry();
          }
          await fileHandle.chmod(Number(strippedMode));
          modeChanged = strippedMode !== originalMode;
        } else if (!checkedPreciseInfo.isSymbolicLink()) {
          return retainedEntry();
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
          return retainedEntry();
        }
        await hooks.beforeEntryRename?.(entry);
        let beforeRenameInfo;
        try {
          beforeRenameInfo = await lstat(anchoredEntry, { bigint: true });
        } catch {
          await restoreQuarantine();
          return retainedEntry();
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
          return retainedEntry();
        }
        await rename(anchoredEntry, quarantined);
        const pinResult = await createPinFromPath(
          parentDirectory,
          quarantined,
          {
            dev: checkedPreciseInfo.dev,
            ino: checkedPreciseInfo.ino,
          },
          fileHandle,
          hooks,
        );
        if (pinResult.pin === null) {
          let recoveredPath: string;
          try {
            recoveredPath =
              fileHandle === null
                ? await recoverSymlink(
                    parentDirectory,
                    symbolicLinkTarget ?? "",
                    hooks,
                  )
                : await recoverFileFromHandle(
                    parentDirectory,
                    fileHandle,
                    originalMode,
                    hooks,
                  );
          } catch (error) {
            const displayedQuarantine = displayPath(quarantined);
            throw new RetainedRecoveryError(
              `Could not pin the original entry or copy it from the held handle: ${error instanceof Error ? error.message : String(error)}; source remains at ${displayedQuarantine}`,
              [displayedQuarantine],
            );
          }
          if (
            fileHandle === null &&
            (await readlink(recoveredPath)) !== symbolicLinkTarget
          )
            throw new Error("Recovered symbolic link target did not match");
          reportRetainedPath(recoveredPath);
          reportRetainedPath(quarantined);
          if (pinResult.mismatchPath !== undefined)
            reportRetainedPath(pinResult.mismatchPath);
          throw new RetainedRecoveryError(
            `Could not pin the original entry; verified recovery remains at ${displayPath(recoveredPath)}`,
            [displayPath(recoveredPath), displayPath(quarantined)],
          );
        }
        recoveryPin = pinResult.pin;
        activePins.add(recoveryPin);
        let quarantinedCtimeNs: bigint | null = null;
        const verifyMovedEntry = async (
          expectedCtimeNs: bigint | null = null,
        ): Promise<boolean> => {
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
                [...activePins]
                  .filter((pin) => path.dirname(pin) === parentDirectory)
                  .map((pin) => path.basename(pin)),
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
          if (expectedCtimeNs === null) quarantinedCtimeNs = movedInfo.ctimeNs;
          else if (movedInfo.ctimeNs !== expectedCtimeNs) return false;
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
          return retainedEntry();
        }
        await hooks.afterEntryQuarantined?.(entry, quarantined);
        if (!(await verifyMovedEntry(quarantinedCtimeNs))) {
          await restoreQuarantine();
          return retainedEntry();
        }
        await hooks.afterParentVerified?.(entry, quarantined);
        await unlink(quarantined);
        await cleanupPin(quarantined);
        return "removed";
      } catch (error) {
        if (error instanceof RetainedRecoveryError) throw error;
        await restoreQuarantine();
        return retainedEntry();
      } finally {
        await fileHandle?.close();
      }
    }
    const directory = await openDirectory(anchoredEntry);
    if (directory === null) return retainedEntry();
    let heldGitMarkerHandle: FileHandle | null = null;
    try {
      const openedInfo = await directory.stat();
      if (!sameDirectory(info, openedInfo)) return retainedEntry();
      const directoryPath = await descriptorPath(directory);
      if (directoryPath === null) return retainedEntry();
      displayPathMappings.set(directoryPath, path.resolve(entry));
      let currentInfo;
      try {
        currentInfo = await lstat(anchoredEntry);
      } catch {
        return retainedEntry();
      }
      if (!sameDirectory(openedInfo, currentInfo)) return retainedEntry();
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
        return retainedEntry();
      let listed: string[];
      try {
        listed = await readDirectoryNames(directoryPath);
      } catch (error) {
        return errorCode(error) === "ENOENT" ? "removed" : retainedEntry();
      }
      if (listed.some((childName) => childName.startsWith(".bb-removing-")))
        return retainedEntry();
      try {
        currentInfo = await lstat(anchoredEntry);
      } catch {
        return retainedEntry();
      }
      if (!sameDirectory(openedInfo, currentInfo)) return retainedEntry();
      const changedDuringListing =
        rootEntry && hooks.rootMetadataBaseline !== undefined
          ? currentInfo.ctimeMs > hooks.rootMetadataBaseline.ctimeMs ||
            currentInfo.mtimeMs > hooks.rootMetadataBaseline.mtimeMs
          : changedSince(currentInfo, startedAt);
      if (changedDuringListing) {
        return retainedEntry();
      }
      let afterHook: string[];
      try {
        afterHook = await readDirectoryNames(directoryPath);
      } catch {
        return retainedEntry();
      }
      if (
        afterHook.length !== listed.length ||
        afterHook.some((childName) => !listed.includes(childName))
      )
        return retainedEntry();
      const directories: string[] = [];
      const files: string[] = [];
      for (const childName of listed) {
        if (childName === ".git") continue;
        let childInfo;
        try {
          childInfo = await lstat(path.join(directoryPath, childName));
        } catch {
          return retainedEntry();
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
          return retainedEntry();
        }
        if (currentNames.some((current) => !remainingNames.has(current)))
          return retainedEntry();
        const childResult = await removeEntry(
          directoryPath,
          childName,
          path.join(entry, childName),
          false,
          remainingNames,
        );
        if (childResult === "retained") {
          return retainedEntry();
        }
        remainingNames.delete(childName);
      }
      let after: string[];
      try {
        after = await readDirectoryNames(directoryPath);
      } catch (error) {
        return errorCode(error) === "ENOENT" ? "removed" : retainedEntry();
      }
      if (after.some((childName) => !listed.includes(childName)))
        return retainedEntry();
      try {
        currentInfo = await lstat(anchoredEntry);
      } catch {
        return retainedEntry();
      }
      if (!sameDirectory(openedInfo, currentInfo)) return retainedEntry();
      if (!beforeRemovalHookCalled) await hooks.beforeEntryRemoval?.(entry);
      if (expectedSiblingNames !== undefined) {
        let siblings: string[];
        try {
          siblings = await readDirectoryNames(parentDirectory);
        } catch {
          return retainedEntry();
        }
        if (siblings.some((sibling) => !expectedSiblingNames.has(sibling)))
          return retainedEntry();
      }
      let checkedDirectoryInfo;
      try {
        checkedDirectoryInfo = await lstat(anchoredEntry);
      } catch {
        return retainedEntry();
      }
      if (!sameDirectory(openedInfo, checkedDirectoryInfo))
        return retainedEntry();
      await hooks.afterEntryCheck?.(entry);
      let checkedDirectoryPreciseInfo;
      try {
        checkedDirectoryPreciseInfo = await lstat(anchoredEntry, {
          bigint: true,
        });
      } catch {
        return retainedEntry();
      }
      if (
        checkedDirectoryPreciseInfo.dev !== BigInt(openedInfo.dev) ||
        checkedDirectoryPreciseInfo.ino !== BigInt(openedInfo.ino)
      )
        return retainedEntry();
      const originalDirectoryMode = checkedDirectoryPreciseInfo.mode & 0o7777n;
      const strippedDirectoryMode = rootEntry
        ? originalDirectoryMode
        : originalDirectoryMode & ~0o222n;
      let directoryModeChanged = false;
      try {
        await directory.chmod(Number(strippedDirectoryMode));
        directoryModeChanged = strippedDirectoryMode !== originalDirectoryMode;
      } catch {
        return retainedEntry();
      }
      let afterChmodDirectoryInfo;
      try {
        afterChmodDirectoryInfo = await lstat(anchoredEntry, {
          bigint: true,
        });
      } catch {
        if (directoryModeChanged)
          await directory.chmod(Number(originalDirectoryMode));
        return retainedEntry();
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
        return retainedEntry();
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
      let heldGitMarkerMode = 0n;
      let gitMarkerPinName: string | null = null;
      let recoveredGitMarkerPath: string | null = null;
      let racedGitMarkerDestination: string | null = null;
      const restoreQuarantine = async (): Promise<boolean> => {
        if (directoryModeChanged)
          await directory.chmod(Number(originalDirectoryMode));
        try {
          await lstat(anchoredEntry);
          reportRetainedPath(
            path.join(path.dirname(entry), path.basename(quarantined)),
          );
          return false;
        } catch (error) {
          if (errorCode(error) !== "ENOENT") {
            reportRetainedPath(
              path.join(path.dirname(entry), path.basename(quarantined)),
            );
            return false;
          }
        }
        try {
          await hooks.afterRestoreNameCheck?.(quarantined, anchoredEntry, true);
          await rename(quarantined, anchoredEntry);
          for (const activePin of [...activePins]) {
            const relative = path.relative(quarantined, activePin);
            if (relative === "" || relative.startsWith(`..${path.sep}`))
              continue;
            activePins.delete(activePin);
            activePins.add(path.join(anchoredEntry, relative));
          }
          rootQuarantined = false;
          return true;
        } catch {
          reportRetainedPath(
            path.join(path.dirname(entry), path.basename(quarantined)),
          );
          return false;
        }
      };
      const restoreGitMarker = async (rootPath: string): Promise<boolean> => {
        if (!gitMarkerHeld || heldGitMarker === null) return true;
        if (heldGitMarkerHandle === null) return false;
        const destination = path.join(rootPath, ".git");
        const pinPath =
          gitMarkerPinName === null
            ? heldGitMarker
            : path.join(rootPath, gitMarkerPinName);
        try {
          await hooks.beforeGitMarkerRestoreLink?.(heldGitMarker, destination);
          await link(pinPath, destination);
          const [linkedInfo, heldInfo] = await Promise.all([
            lstat(destination, { bigint: true }),
            heldGitMarkerHandle.stat({ bigint: true }),
          ]);
          if (
            linkedInfo.dev !== heldInfo.dev ||
            linkedInfo.ino !== heldInfo.ino
          ) {
            throw new Error("Restored Git marker identity did not match");
          }
          await verifyPathContents(destination, heldGitMarkerHandle);
          reportRetainedPath(destination);
          reportRetainedPath(heldGitMarker);
          await hooks.afterGitMarkerLinked?.(heldGitMarker, destination);
          await verifyPathContents(destination, heldGitMarkerHandle);
          if (gitMarkerPinName !== null) {
            await hooks.beforePinCleanup?.(pinPath, destination);
            const [pinInfo, heldInfoAfterHook] = await Promise.all([
              lstat(pinPath, { bigint: true }),
              heldGitMarkerHandle.stat({ bigint: true }),
            ]);
            if (
              pinInfo.dev !== heldInfoAfterHook.dev ||
              pinInfo.ino !== heldInfoAfterHook.ino
            )
              throw new Error("Git marker pin identity changed before cleanup");
            await unlink(pinPath);
            activePins.delete(pinPath);
            gitMarkerPinName = null;
          }
          return true;
        } catch (error) {
          if (errorCode(error) === "EEXIST" && gitMarkerPinName !== null) {
            try {
              const recoveredPath = await recoverFileFromPin(
                rootPath,
                pinPath,
                heldGitMarkerHandle,
                heldGitMarkerMode,
                hooks,
              );
              recoveredGitMarkerPath = recoveredPath;
              racedGitMarkerDestination = destination;
              reportRetainedPath(recoveredPath);
              reportRetainedPath(destination);
              const heldPathInfo = await lstat(heldGitMarker, {
                bigint: true,
              });
              const originalInfo = await heldGitMarkerHandle.stat({
                bigint: true,
              });
              if (
                heldPathInfo.dev === originalInfo.dev &&
                heldPathInfo.ino === originalInfo.ino
              )
                reportRetainedPath(heldGitMarker);
              await hooks.beforePinCleanup?.(pinPath, recoveredPath);
              const [pinInfo, heldInfo] = await Promise.all([
                lstat(pinPath, { bigint: true }),
                heldGitMarkerHandle.stat({ bigint: true }),
              ]);
              if (pinInfo.dev !== heldInfo.dev || pinInfo.ino !== heldInfo.ino)
                throw new Error(
                  "Git marker pin identity changed before cleanup",
                );
              await unlink(pinPath);
              activePins.delete(pinPath);
              gitMarkerPinName = null;
              return false;
            } catch (recoveryError) {
              if (recoveryError instanceof RetainedRecoveryError)
                throw recoveryError;
              error = recoveryError;
            }
          }
          const heldInfo = await heldGitMarkerHandle.stat({ bigint: true });
          const candidates = [pinPath, heldGitMarker, quarantined];
          const retained: string[] = [];
          for (const candidate of candidates) {
            try {
              const current = await lstat(candidate, { bigint: true });
              if (current.dev === heldInfo.dev && current.ino === heldInfo.ino)
                retained.push(candidate);
            } catch {}
          }
          if (retained.length === 0) retained.push(displayPath(pinPath));
          const displayedRetained = retained.map(displayPath);
          for (const retainedPath of displayedRetained)
            reportRetainedPath(retainedPath);
          throw new RetainedRecoveryError(
            `Git marker recovery failed (${error instanceof Error ? error.message : String(error)}); original retained at ${displayedRetained.join(", ")}`,
            displayedRetained,
          );
        }
      };
      const retain = async (): Promise<RemoveEntryResult> => {
        const quarantineRestored = rootQuarantined
          ? await restoreQuarantine()
          : false;
        await restoreGitMarker(
          quarantineRestored || !rootQuarantined ? anchoredEntry : quarantined,
        );
        if (racedGitMarkerDestination !== null) {
          const retainedRootPath =
            quarantineRestored || !rootQuarantined
              ? entry
              : path.join(path.dirname(entry), path.basename(quarantined));
          reportRetainedPath(path.join(retainedRootPath, ".git"));
        }
        if (recoveredGitMarkerPath !== null) {
          const recoveredMarkerParent =
            quarantineRestored || !rootQuarantined
              ? entry
              : path.join(path.dirname(entry), path.basename(quarantined));
          reportRetainedPath(
            path.join(
              recoveredMarkerParent,
              path.basename(recoveredGitMarkerPath),
            ),
          );
        }
        if (directoryModeChanged)
          await directory.chmod(Number(originalDirectoryMode));
        return retainedEntry();
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
              [...activePins]
                .filter((pin) => path.dirname(pin) === parentDirectory)
                .map((pin) => path.basename(pin)),
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
          heldGitMarkerHandle = await open(
            path.join(directoryPath, ".git"),
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
          );
          const originalMarkerInfo = await heldGitMarkerHandle.stat({
            bigint: true,
          });
          const namedMarkerInfo = await lstat(rootGitMarker, {
            bigint: true,
          });
          if (
            originalMarkerInfo.dev !== namedMarkerInfo.dev ||
            originalMarkerInfo.ino !== namedMarkerInfo.ino
          )
            return await retain();
          heldGitMarkerMode = originalMarkerInfo.mode & 0o7777n;
          const pinResult = await createPinFromPath(
            directoryPath,
            rootGitMarker,
            {
              dev: originalMarkerInfo.dev,
              ino: originalMarkerInfo.ino,
            },
            heldGitMarkerHandle,
            hooks,
          );
          if (pinResult.pin === null) {
            const recoveredPath = await recoverFileFromHandle(
              directoryPath,
              heldGitMarkerHandle,
              heldGitMarkerMode,
              hooks,
            );
            reportRetainedPath(recoveredPath);
            throw new RetainedRecoveryError(
              `Could not pin the Git marker; verified recovery remains at ${recoveredPath}`,
              [recoveredPath],
            );
          }
          gitMarkerPinName = path.basename(pinResult.pin);
          activePins.add(pinResult.pin);
          await rename(rootGitMarker, heldGitMarker);
          gitMarkerHeld = true;
          const movedMarkerInfo = await lstat(heldGitMarker, {
            bigint: true,
          });
          if (
            originalMarkerInfo.dev !== movedMarkerInfo.dev ||
            originalMarkerInfo.ino !== movedMarkerInfo.ino
          )
            return await retain();
          heldMarkerInfo = await lstat(quarantined);
          await hooks.afterRootMarkerDetached?.(quarantined);
        }
        const finalEntries = await readDirectoryNames(directoryPath);
        const finalDirectoryInfo = await lstat(quarantined);
        if (
          finalEntries.some((name) => name !== gitMarkerPinName) ||
          !sameDirectory(openedInfo, finalDirectoryInfo) ||
          (heldMarkerInfo !== null &&
            (finalDirectoryInfo.ctimeMs !== heldMarkerInfo.ctimeMs ||
              finalDirectoryInfo.mtimeMs !== heldMarkerInfo.mtimeMs))
        ) {
          return await retain();
        }
        if (gitMarkerPinName !== null && heldGitMarker !== null) {
          const markerPin = path.join(quarantined, gitMarkerPinName);
          const [pinInfo, heldInfo] = await Promise.all([
            lstat(markerPin, { bigint: true }),
            heldGitMarkerHandle!.stat({ bigint: true }),
          ]);
          if (pinInfo.dev !== heldInfo.dev || pinInfo.ino !== heldInfo.ino)
            return await retain();
          await verifyPathContents(markerPin, heldGitMarkerHandle!);
          await hooks.beforePinCleanup?.(markerPin, heldGitMarker);
          await unlink(markerPin);
          activePins.delete(markerPin);
          gitMarkerPinName = null;
        }
        await rmdir(quarantined);
        rootQuarantined = false;
        if (heldGitMarker !== null && gitMarkerHeld) {
          await unlink(heldGitMarker);
          gitMarkerHeld = false;
        }
        return "removed";
      } catch (error) {
        if (error instanceof RetainedRecoveryError) {
          await retain();
          throw error;
        }
        await retain();
        const code = errorCode(error);
        return code === "ENOENT" ? "removed" : retainedEntry();
      }
    } finally {
      await heldGitMarkerHandle?.close();
      await directory.close();
    }
  };
  try {
    const status = await removeEntry(parentPath, rootName, root, true);
    return result(status);
  } finally {
    await parent.close();
  }
}
