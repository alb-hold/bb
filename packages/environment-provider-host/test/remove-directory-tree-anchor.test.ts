import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  FILE_TIMESTAMP_LAG_MS,
  removeDirectoryTree,
} from "../src/remove-directory-tree.js";

const roots: string[] = [];
const anchoring = process.platform === "linux" || process.platform === "darwin";

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function settledTree(): Promise<{ parent: string; root: string }> {
  const parent = await fs.mkdtemp(path.join(tmpdir(), "bb-anchor-"));
  roots.push(parent);
  const root = path.join(parent, "tree");
  await fs.mkdir(path.join(root, "nested", "deeper"), { recursive: true });
  await fs.writeFile(path.join(root, "top.txt"), "top");
  await fs.writeFile(path.join(root, "nested", "mid.txt"), "mid");
  await fs.writeFile(path.join(root, "nested", "deeper", "leaf.txt"), "leaf");
  await delay(FILE_TIMESTAMP_LAG_MS + 50);
  return { parent, root };
}

async function contents(root: string): Promise<string[]> {
  const names = await fs.readdir(root, { recursive: true });
  return names.map(String).sort();
}

describe.runIf(anchoring)("removing a tree anchored by its descriptors", () => {
  it("removes a settled tree", async () => {
    const { root } = await settledTree();
    const result = await removeDirectoryTree(root, { startedAt: Date.now() });
    expect(result).toEqual({
      status: "removed",
      retainedPaths: [],
      mountedPaths: [],
      unanchoredPaths: [],
    });
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a tree that gains an entry during the walk", async () => {
    const { root } = await settledTree();
    const late = path.join(root, "nested", "late.txt");
    const result = await removeDirectoryTree(root, {
      startedAt: Date.now(),
      afterDirectoryListed: async (directory) => {
        if (directory === path.join(root, "nested"))
          await fs.writeFile(late, "late");
      },
    });
    expect(result.status).toBe("retained");
    await expect(fs.readFile(late, "utf8")).resolves.toBe("late");
  });

  it("does not follow a name recreated at the old path after the directory was opened", async () => {
    const { root } = await settledTree();
    const moved = `${root}-moved`;
    const decoy = path.join(root, "decoy.txt");
    let swapped = false;
    const result = await removeDirectoryTree(root, {
      startedAt: Date.now(),
      afterDirectoryListed: async (directory) => {
        if (directory !== root || swapped) return;
        swapped = true;
        await fs.rename(root, moved);
        await fs.mkdir(root);
        await fs.writeFile(decoy, "decoy");
      },
    });
    expect(swapped).toBe(true);
    expect(result.status).toBe("retained");
    await expect(fs.readFile(decoy, "utf8")).resolves.toBe("decoy");
    expect(await contents(moved)).toEqual([
      "nested",
      "nested/deeper",
      "nested/deeper/leaf.txt",
      "nested/mid.txt",
      "top.txt",
    ]);
  });
});

describe.runIf(process.platform === "darwin")(
  "anchoring a directory on macOS",
  () => {
    it("falls back from /dev/fd to /.vol when /dev/fd cannot list the directory", async () => {
      const { root } = await settledTree();
      const used: string[] = [];
      const result = await removeDirectoryTree(root, {
        startedAt: Date.now(),
        statDescriptor: async (candidate) => {
          used.push(candidate.split("/").slice(0, 2).join("/"));
          return fs.stat(candidate);
        },
      });
      expect(result.status).toBe("removed");
      expect(used).toContain("/.vol");
    });

    it("keeps the tree when /.vol resolves to a different directory", async () => {
      const { parent, root } = await settledTree();
      const elsewhere = path.join(parent, "elsewhere");
      await fs.mkdir(elsewhere);
      const result = await removeDirectoryTree(root, {
        startedAt: Date.now(),
        statDescriptor: (candidate) =>
          fs.stat(candidate.startsWith("/.vol/") ? elsewhere : candidate),
      });
      expect(result.status).toBe("retained");
      expect(result.unanchoredPaths).toEqual([parent]);
      expect(await contents(root)).toHaveLength(5);
    });

    it("keeps the tree on a volume without /.vol", async () => {
      const { parent, root } = await settledTree();
      const result = await removeDirectoryTree(root, {
        startedAt: Date.now(),
        statDescriptor: async (candidate) => {
          if (candidate.startsWith("/.vol/"))
            throw Object.assign(new Error(`ENOENT: ${candidate}`), {
              code: "ENOENT",
            });
          return fs.stat(candidate);
        },
      });
      expect(result.status).toBe("retained");
      expect(result.unanchoredPaths).toEqual([parent]);
      expect(await contents(root)).toHaveLength(5);
    });

    it("does not anchor through /dev/fd when its device differs from the descriptor's, even when it lists", async () => {
      const { parent, root } = await settledTree();
      const result = await removeDirectoryTree(root, {
        startedAt: Date.now(),
        statDescriptor: async (candidate) => {
          if (candidate.startsWith("/.vol/"))
            throw Object.assign(new Error(`ENOENT: ${candidate}`), {
              code: "ENOENT",
            });
          const real = await fs.stat(candidate);
          return {
            dev: real.dev + 1,
            ino: real.ino,
            isDirectory: () => real.isDirectory(),
          };
        },
        readDirectoryNames: (directory) =>
          directory.startsWith("/dev/fd/")
            ? Promise.resolve([])
            : fs.readdir(directory),
      });
      expect(result.status).toBe("retained");
      expect(result.unanchoredPaths).toEqual([parent]);
      expect(await contents(root)).toHaveLength(5);
    });
  },
);
