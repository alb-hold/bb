import { makeTempDir } from "@bb/test-helpers";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stageDroppedFile } from "../src/dropped-file-staging.js";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

describe("stageDroppedFile", () => {
  it("copies the bytes under the same file name into a private directory", async () => {
    const rootDir = join(await makeTempDir("bb-drop-"), "dropped-files");
    const name = "Screenshot 2026-11-25 at 1.35.15 AM.png";
    const bytes = randomBytes(4096);

    const path = await stageDroppedFile({ rootDir, name, bytes });

    expect(basename(path)).toBe(name);
    expect(path.startsWith(rootDir)).toBe(true);
    expect(await readFile(path)).toEqual(bytes);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await stat(rootDir)).mode & 0o777).toBe(0o700);
  });

  it("keeps a hostile file name inside the staging directory", async () => {
    const rootDir = join(await makeTempDir("bb-drop-"), "dropped-files");
    const path = await stageDroppedFile({
      rootDir,
      name: "../../escape.png",
      bytes: new Uint8Array([1]),
    });
    expect(basename(path)).toBe("escape.png");
    expect(path.startsWith(`${rootDir}/`)).toBe(true);
    await expect(
      stageDroppedFile({ rootDir, name: "..", bytes: new Uint8Array() }),
    ).rejects.toThrow("no usable name");
  });
});
