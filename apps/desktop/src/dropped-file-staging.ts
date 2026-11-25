import { mkdtemp, open } from "node:fs/promises";
import { basename, join } from "node:path";
import { ipcMain } from "electron";
import { DROPPED_FILE_MAX_BYTES } from "@bb/desktop-contract";
import { z } from "zod";
import { BB_DESKTOP_STAGE_DROPPED_FILE_CHANNEL } from "./desktop-window-command-ipc.js";

const stageDroppedFileRequestSchema = z.object({
  name: z.string(),
  bytes: z
    .instanceof(Uint8Array)
    .refine((bytes) => bytes.byteLength <= DROPPED_FILE_MAX_BYTES, {
      message: "Dropped file is too large to attach",
    }),
});

export async function stageDroppedFile({
  tempDir,
  name,
  bytes,
}: {
  tempDir: string;
  name: string;
  bytes: Uint8Array;
}): Promise<string> {
  const fileName = basename(name.replaceAll("\\", "/"));
  if (fileName.length === 0 || fileName === "." || fileName === "..") {
    throw new Error("Dropped file has no usable name");
  }
  const dropDir = await mkdtemp(join(tempDir, "bb-drop-"));
  const path = join(dropDir, fileName);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return path;
}

export function registerDroppedFileStagingIpc(
  applicationWindowWebContentsIds: ReadonlySet<number>,
  getTempDir: () => string,
): void {
  ipcMain.handle(
    BB_DESKTOP_STAGE_DROPPED_FILE_CHANNEL,
    async (event, payload: unknown) => {
      if (!applicationWindowWebContentsIds.has(event.sender.id)) {
        throw new Error("Dropped file staging is limited to bb windows");
      }
      const request = stageDroppedFileRequestSchema.parse(payload);
      return stageDroppedFile({ tempDir: getTempDir(), ...request });
    },
  );
}
