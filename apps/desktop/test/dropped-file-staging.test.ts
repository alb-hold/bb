import { makeTempDir } from "@bb/test-helpers";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  pruneDroppedFiles,
  stageDroppedFile,
} from "../src/dropped-file-staging.js";

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

describe("pruneDroppedFiles", () => {
  const DAY = 24 * 60 * 60 * 1000;

  async function makeDrop(
    rootDir: string,
    name: string,
    bytes: number,
    ageMs: number,
  ): Promise<string> {
    const dir = join(rootDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.png"), new Uint8Array(bytes));
    const when = new Date(Date.now() - ageMs);
    await utimes(dir, when, when);
    return dir;
  }

  async function exists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  it("removes drops older than seven days and keeps fresh ones", async () => {
    const rootDir = await makeTempDir("bb-drop-");
    const old = await makeDrop(rootDir, "old", 10, 8 * DAY);
    const fresh = await makeDrop(rootDir, "fresh", 10, 1 * DAY);

    await pruneDroppedFiles({ rootDir });

    expect(await exists(old)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });

  it("evicts oldest first past the size cap and never the current copy", async () => {
    const rootDir = await makeTempDir("bb-drop-");
    const oldest = await makeDrop(rootDir, "a", 100, 3 * DAY);
    const middle = await makeDrop(rootDir, "b", 100, 2 * DAY);
    const current = await makeDrop(rootDir, "c", 100, 1 * DAY);

    await pruneDroppedFiles({ rootDir, keepDir: current, maxTotalBytes: 250 });

    expect(await exists(oldest)).toBe(false);
    expect(await exists(middle)).toBe(true);
    expect(await exists(current)).toBe(true);

    await pruneDroppedFiles({ rootDir, keepDir: current, maxTotalBytes: 50 });

    expect(await exists(middle)).toBe(false);
    expect(await exists(current)).toBe(true);
  });

  it("prunes when a new file is staged and keeps that copy", async () => {
    const rootDir = await makeTempDir("bb-drop-");
    const old = await makeDrop(rootDir, "old", 10, 9 * DAY);

    const path = await stageDroppedFile({
      rootDir,
      name: "new.png",
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(await exists(old)).toBe(false);
    expect(await readFile(path)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("never follows a symlink out of the root and never throws", async () => {
    const rootDir = await makeTempDir("bb-drop-");
    const outside = await makeTempDir("bb-outside-");
    await writeFile(join(outside, "keep.txt"), "keep");
    const when = new Date(Date.now() - 30 * DAY);
    await symlink(outside, join(rootDir, "link"));
    const inner = await makeDrop(rootDir, "inner", 10, 30 * DAY);
    await symlink(outside, join(inner, "escape"));
    await utimes(inner, when, when);

    await expect(pruneDroppedFiles({ rootDir })).resolves.toBeUndefined();
    await expect(
      pruneDroppedFiles({ rootDir: join(rootDir, "missing") }),
    ).resolves.toBeUndefined();

    expect(await exists(inner)).toBe(false);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  it("leaves a symlinked store root alone and refuses to stage through it", async () => {
    const base = await makeTempDir("bb-drop-");
    const outside = await makeTempDir("bb-outside-");
    const oldDir = await makeDrop(outside, "old", 10, 30 * DAY);
    const rootDir = join(base, "dropped-files");
    await symlink(outside, rootDir);

    await pruneDroppedFiles({ rootDir });
    await expect(
      stageDroppedFile({
        rootDir,
        name: "a.png",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow("not a plain directory");

    expect(await exists(oldDir)).toBe(true);
    expect(await readdir(outside)).toEqual(["old"]);
  });
});
