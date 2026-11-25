import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
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

interface StagedDrop {
  path: string;
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

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else if (entry.isFile()) total += (await lstat(path)).size;
  }
  return total;
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
    if (!(await isPlainDirectory(rootDir))) {
      console.warn(
        "bb: skipping dropped-file pruning, store is not a plain directory",
      );
      return;
    }
    const realRoot = await realpath(rootDir);
    const drops: StagedDrop[] = [];
    for (const entry of await readdir(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(rootDir, entry.name);
      try {
        if (!(await realpath(path)).startsWith(`${realRoot}${sep}`)) continue;
        const info = await lstat(path);
        drops.push({
          path,
          mtimeMs: info.mtimeMs,
          bytes: await directoryBytes(path),
        });
      } catch {
        continue;
      }
    }
    const remove = async (drop: StagedDrop): Promise<boolean> => {
      try {
        const info = await lstat(drop.path);
        if (!info.isDirectory() || info.isSymbolicLink()) return false;
        const real = await realpath(drop.path);
        if (dirname(real) !== realRoot) return false;
        await rm(real, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    };
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
  const dropDir = await mkdtemp(join(rootDir, "drop-"));
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
    await rm(realDrop ?? dropDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
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
