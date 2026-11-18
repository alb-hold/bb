import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  removeDirectoryTree,
  treeSnapshot,
} from "../src/remove-directory-tree.js";

const HOUR_MS = 60 * 60_000;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function tree(files: Record<string, string>): Promise<string> {
  const parent = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "bb-tree-snapshot-")),
  );
  roots.push(parent);
  const root = path.join(parent, "entry");
  for (const [relative, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), {
      recursive: true,
    });
    await fs.writeFile(path.join(root, relative), text);
  }
  return root;
}

async function treeFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const pending = [""];
  while (pending.length > 0) {
    const relative = pending.pop()!;
    const entry = path.join(root, relative);
    const info = await fs.lstat(entry);
    if (info.isDirectory()) {
      for (const name of await fs.readdir(entry))
        pending.push(path.join(relative, name));
    } else {
      files[relative] = await fs.readFile(entry, "utf8");
    }
  }
  return files;
}

async function snapshotEntries(
  root: string,
): Promise<ReadonlyMap<string, string>> {
  const snapshot = await treeSnapshot(root);
  expect(snapshot).not.toBeNull();
  return snapshot!.entries;
}

it("removes a tree that still matches its snapshot when the clock went back past every entry", async () => {
  const root = await tree({
    ".git": "gitdir: /elsewhere\n",
    "a.txt": "a\n",
    "src/b.txt": "b\n",
    "src/deep/c.txt": "c\n",
  });
  await fs.mkdir(path.join(root, "empty"));
  const expectedEntries = await snapshotEntries(root);

  const removal = await removeDirectoryTree(root, {
    startedAt: Date.now() + HOUR_MS,
    expectedEntries,
  });

  expect(removal.status).toBe("removed");
  await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps every byte of a tree that changed after its snapshot, and starts no removal, when the clock went back", async () => {
  const root = await tree({ "src/a.txt": "a\n", "z.txt": "z\n" });
  const expectedEntries = await snapshotEntries(root);
  await fs.writeFile(path.join(root, "z.txt"), "written after\n");

  const removal = await removeDirectoryTree(root, {
    startedAt: Date.now() + HOUR_MS,
    expectedEntries,
  });

  expect(removal.status).toBe("retained");
  expect(removal.removalStarted).toBe(false);
  expect(await treeFiles(root)).toEqual({
    "src/a.txt": "a\n",
    "z.txt": "written after\n",
  });
});

it("keeps a file rewritten during the walk before its own check when the clock went back", async () => {
  const root = await tree({ "src/b.txt": "b\n" });
  const target = path.join(root, "src", "b.txt");
  const expectedEntries = await snapshotEntries(root);
  const rewritten: string[] = [];

  const removal = await removeDirectoryTree(root, {
    startedAt: Date.now() + HOUR_MS,
    expectedEntries,
    beforeEntryRemoval: async (entry) => {
      if (entry !== target || rewritten.length > 0) return;
      await fs.writeFile(entry, "written during the walk\n");
      rewritten.push(entry);
    },
  });

  expect(rewritten).toEqual([target]);
  expect(removal.status).toBe("retained");
  expect(await fs.readFile(target, "utf8")).toBe("written during the walk\n");
});

it("keeps a directory that gained an entry during the walk when the clock went back", async () => {
  const root = await tree({ "src/b.txt": "b\n" });
  const directory = path.join(root, "src");
  const expectedEntries = await snapshotEntries(root);
  const created: string[] = [];

  const removal = await removeDirectoryTree(root, {
    startedAt: Date.now() + HOUR_MS,
    expectedEntries,
    beforeEntryRemoval: async (entry) => {
      if (entry !== directory || created.length > 0) return;
      await fs.mkdir(path.join(entry, "new"));
      created.push(entry);
    },
  });

  expect(created).toEqual([directory]);
  expect(removal.status).toBe("retained");
  expect((await fs.readdir(directory)).sort()).toEqual(["b.txt", "new"]);
});
