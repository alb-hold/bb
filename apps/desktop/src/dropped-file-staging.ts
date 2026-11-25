import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ipcMain } from "electron";
import { z } from "zod";
import { BB_DESKTOP_STAGE_DROPPED_FILE_CHANNEL } from "./desktop-window-command-ipc.js";

const stageDroppedFileRequestSchema = z.object({
  name: z.string(),
  bytes: z.instanceof(Uint8Array),
});

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
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  const dropDir = join(rootDir, randomUUID());
  await mkdir(dropDir, { mode: 0o700 });
  const path = join(dropDir, fileName);
  await writeFile(path, bytes, { mode: 0o600 });
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
