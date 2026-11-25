import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  writeFile,
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
}: {
  rootDir: string;
  keepDir?: string;
  now?: number;
  maxAgeMs?: number;
  maxTotalBytes?: number;
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
        await rm(drop.path, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    };
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
}: {
  rootDir: string;
  name: string;
  bytes: Uint8Array;
}): Promise<string> {
  const fileName = basename(name.replaceAll("\\", "/"));
  if (fileName.length === 0 || fileName === "." || fileName === "..") {
    throw new Error("Dropped file has no usable name");
  }
  await ensurePlainRoot(rootDir);
  const dropDir = join(rootDir, randomUUID());
  await mkdir(dropDir, { mode: 0o700 });
  const path = join(dropDir, fileName);
  await writeFile(path, bytes, { mode: 0o600 });
  await pruneDroppedFiles({ rootDir, keepDir: dropDir });
  return path;
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
