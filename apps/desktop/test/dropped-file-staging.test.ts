import { makeTempDir } from "@bb/test-helpers";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  lstat,
  readdir,
  readFile,
  rm,
  rmdir,
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

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
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
  const DROP_IDS: Record<string, string> = {
    old: "00000000-0000-4000-8000-000000000001",
    fresh: "00000000-0000-4000-8000-000000000002",
    a: "00000000-0000-4000-8000-000000000003",
    b: "00000000-0000-4000-8000-000000000004",
    c: "00000000-0000-4000-8000-000000000005",
    inner: "00000000-0000-4000-8000-000000000006",
  };

  async function makeDrop(
    rootDir: string,
    name: string,
    bytes: number,
    ageMs: number,
  ): Promise<string> {
    const dir = join(rootDir, DROP_IDS[name] ?? name);
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

  it("skips a drop holding a symlink, never follows it and never throws", async () => {
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

    expect(await exists(inner)).toBe(true);
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
    expect(await readdir(outside)).toEqual([basename(oldDir)]);
  });

  it("does not follow an entry swapped for a symlink before it is removed", async () => {
    const rootDir = await makeTempDir("bb-drop-");
    const outside = await makeTempDir("bb-outside-");
    await writeFile(join(outside, "keep.txt"), "keep");
    const entry = await makeDrop(rootDir, "old", 10, 30 * DAY);

    await pruneDroppedFiles({
      rootDir,
      afterScan: async () => {
        await rm(entry, { recursive: true });
        await symlink(outside, entry);
      },
    });

    expect((await lstat(entry)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  it("falls back and leaves the outside directory unchanged when the root is swapped mid-stage", async () => {
    const base = await makeTempDir("bb-drop-");
    const outside = await makeTempDir("bb-outside-");
    const rootDir = join(base, "dropped-files");

    await expect(
      stageDroppedFile({
        rootDir,
        name: "a.png",
        bytes: new Uint8Array([1]),
        afterRootCheck: async () => {
          await rm(rootDir, { recursive: true });
          await symlink(outside, rootDir);
        },
      }),
    ).rejects.toThrow("changed while staging");

    expect(await readdir(outside)).toEqual([]);
  });

  it("never deletes recursively and removes normal old drops", async () => {
    const rootDir = await makeTempDir("bb-drop-");
    const old = await makeDrop(rootDir, "old", 10, 30 * DAY);
    vi.mocked(rm).mockClear();

    await pruneDroppedFiles({ rootDir });

    expect(await exists(old)).toBe(false);
    expect(rm).not.toHaveBeenCalled();
  });

  it("skips non-uuid entries and entries holding a subdirectory", async () => {
    const rootDir = await makeTempDir("bb-drop-");
    const plain = join(rootDir, "not-a-uuid");
    await mkdir(plain);
    await writeFile(join(plain, "a.png"), "x");
    const nested = await makeDrop(rootDir, "old", 10, 30 * DAY);
    await mkdir(join(nested, "sub"));
    await writeFile(join(nested, "sub", "deep.txt"), "deep");
    const when = new Date(Date.now() - 30 * DAY);
    await utimes(plain, when, when);

    await pruneDroppedFiles({ rootDir });

    expect(await exists(plain)).toBe(true);
    expect(await exists(join(nested, "sub", "deep.txt"))).toBe(true);
  });

  it("a root swapped before the delete leaves an outside tree intact", async () => {
    const base = await makeTempDir("bb-drop-");
    const outside = await makeTempDir("bb-outside-");
    const rootDir = join(base, "dropped-files");
    await mkdir(rootDir);
    const entry = await makeDrop(rootDir, "old", 10, 30 * DAY);
    const twin = join(outside, DROP_IDS["old"] as string);
    await mkdir(join(twin, "sub"), { recursive: true });
    await writeFile(join(twin, "sub", "deep.txt"), "deep");
    await writeFile(join(twin, "keep.txt"), "keep");

    await pruneDroppedFiles({
      rootDir,
      afterScan: async () => {
        await rm(entry, { recursive: true });
        await rmdir(rootDir);
        await symlink(outside, rootDir);
      },
    });

    expect(await readFile(join(twin, "sub", "deep.txt"), "utf8")).toBe("deep");
    expect(await readFile(join(twin, "keep.txt"), "utf8")).toBe("keep");
  });
});
