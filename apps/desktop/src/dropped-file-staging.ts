import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { ipcMain } from "electron";
import { z } from "zod";
import { BB_DESKTOP_STAGE_DROPPED_FILE_CHANNEL } from "./desktop-window-command-ipc.js";

const stageDroppedFileRequestSchema = z.object({
  name: z.string(),
  bytes: z.instanceof(Uint8Array),
});

const DROPPED_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DROPPED_FILE_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

const DROP_DIR_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DROP_MAX_FILES = 4;

interface Identity {
  dev: number;
  ino: number;
}

interface StagedFile extends Identity {
  name: string;
}

interface StagedDrop extends Identity {
  path: string;
  files: StagedFile[];
  mtimeMs: number;
  bytes: number;
}

async function isPlainDirectory(path: string): Promise<boolean> {
  const info = await lstat(path);
  return info.isDirectory() && !info.isSymbolicLink();
}

async function ensurePlainRoot(rootDir: string): Promise<void> {
  await mkdir(dirname(rootDir), { recursive: true });
  try {
    await mkdir(rootDir, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  }
  if (!(await isPlainDirectory(rootDir))) {
    throw new Error("Dropped-file store is not a plain directory");
  }
}

async function removeDropEntries(
  dir: string,
  names: readonly string[],
  verify?: (name: string | null) => Promise<void>,
): Promise<boolean> {
  for (const name of names) {
    await verify?.(name);
    await unlink(join(dir, name)).catch(() => undefined);
  }
  await verify?.(null);
  try {
    await rmdir(dir);
    return true;
  } catch {
    return false;
  }
}

async function requireIdentity(
  path: string,
  expected: Identity,
  isFile: boolean,
): Promise<void> {
  const info = await lstat(path);
  const kind = isFile ? info.isFile() : info.isDirectory();
  if (
    !kind ||
    info.isSymbolicLink() ||
    info.dev !== expected.dev ||
    info.ino !== expected.ino
  ) {
    throw new Error("Dropped-file store changed while pruning");
  }
}

async function scanDrop(path: string): Promise<StagedDrop | null> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) return null;
  const children = await readdir(path, { withFileTypes: true });
  if (children.length > DROP_MAX_FILES) return null;
  const files: StagedFile[] = [];
  let bytes = 0;
  for (const child of children) {
    if (!child.isFile()) return null;
    const childInfo = await lstat(join(path, child.name));
    if (!childInfo.isFile()) return null;
    bytes += childInfo.size;
    files.push({ name: child.name, dev: childInfo.dev, ino: childInfo.ino });
  }
  return {
    path,
    files,
    dev: info.dev,
    ino: info.ino,
    mtimeMs: info.mtimeMs,
    bytes,
  };
}

export async function pruneDroppedFiles({
  rootDir,
  keepDir,
  now = Date.now(),
  maxAgeMs = DROPPED_FILE_MAX_AGE_MS,
  maxTotalBytes = DROPPED_FILE_MAX_TOTAL_BYTES,
  afterScan,
}: {
  rootDir: string;
  keepDir?: string;
  now?: number;
  maxAgeMs?: number;
  maxTotalBytes?: number;
  afterScan?: () => Promise<void>;
}): Promise<void> {
  try {
    const rootInfo = await lstat(rootDir);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      console.warn(
        "bb: skipping dropped-file pruning, store is not a plain directory",
      );
      return;
    }
    const drops: StagedDrop[] = [];
    for (const entry of await readdir(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !DROP_DIR_NAME.test(entry.name)) continue;
      try {
        const drop = await scanDrop(join(rootDir, entry.name));
        if (drop !== null) drops.push(drop);
      } catch {
        continue;
      }
    }
    const remove = (drop: StagedDrop): Promise<boolean> =>
      removeDropEntries(
        drop.path,
        drop.files.map((file) => file.name),
        async (name) => {
          await requireIdentity(rootDir, rootInfo, false);
          await requireIdentity(drop.path, drop, false);
          const file = drop.files.find((candidate) => candidate.name === name);
          if (file !== undefined) {
            await requireIdentity(join(drop.path, file.name), file, true);
          }
        },
      );
    await afterScan?.();
    const kept: StagedDrop[] = [];
    for (const drop of drops) {
      const expired = now - drop.mtimeMs > maxAgeMs;
      if (drop.path === keepDir || !expired || !(await remove(drop))) {
        kept.push(drop);
      }
    }
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = kept.reduce((sum, drop) => sum + drop.bytes, 0);
    for (const drop of kept) {
      if (total <= maxTotalBytes) break;
      if (drop.path === keepDir) continue;
      if (await remove(drop)) total -= drop.bytes;
    }
  } catch {
    return;
  }
}

export async function stageDroppedFile({
  rootDir,
  name,
  bytes,
  afterRootCheck,
}: {
  rootDir: string;
  name: string;
  bytes: Uint8Array;
  afterRootCheck?: () => Promise<void>;
}): Promise<string> {
  const fileName = basename(name.replaceAll("\\", "/"));
  if (fileName.length === 0 || fileName === "." || fileName === "..") {
    throw new Error("Dropped file has no usable name");
  }
  await ensurePlainRoot(rootDir);
  const realRoot = await realpath(rootDir);
  await afterRootCheck?.();
  const dropDir = join(rootDir, randomUUID());
  await mkdir(dropDir, { mode: 0o700 });
  let realDrop: string | null = null;
  try {
    realDrop = await realpath(dropDir);
    if (
      dirname(realDrop) !== realRoot ||
      (await realpath(rootDir)) !== realRoot
    ) {
      throw new Error("Dropped-file store changed while staging");
    }
    const realPath = join(realDrop, fileName);
    const handle = await open(realPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) {
        throw new Error("Staged file is not a regular file");
      }
    } finally {
      await handle.close();
    }
    if (!(await realpath(realPath)).startsWith(`${realRoot}${sep}`)) {
      throw new Error("Staged file escaped the dropped-file store");
    }
  } catch (error) {
    await removeDropEntries(realDrop ?? dropDir, [fileName]);
    throw error;
  }
  await pruneDroppedFiles({ rootDir, keepDir: dropDir });
  return join(dropDir, fileName);
}

export function registerDroppedFileStagingIpc(
  applicationWindowWebContentsIds: ReadonlySet<number>,
  getRootDir: () => string | null,
): void {
  ipcMain.handle(
    BB_DESKTOP_STAGE_DROPPED_FILE_CHANNEL,
    async (event, payload: unknown) => {
      if (!applicationWindowWebContentsIds.has(event.sender.id)) {
        throw new Error("Dropped file staging is limited to bb windows");
      }
      const rootDir = getRootDir();
      if (rootDir === null) throw new Error("bb storage is not ready");
      const request = stageDroppedFileRequestSchema.parse(payload);
      return stageDroppedFile({ rootDir, ...request });
    },
  );
}
