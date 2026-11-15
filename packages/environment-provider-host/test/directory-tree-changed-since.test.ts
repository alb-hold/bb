import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import {
  directoryTreeChangedSince,
  entryIdentity,
} from "../src/remove-directory-tree.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function renamedTree() {
  const parent = await fs.mkdtemp(path.join(tmpdir(), "bb-changed-since-"));
  roots.push(parent);
  const original = path.join(parent, "original");
  await fs.mkdir(path.join(original, "logs"), { recursive: true });
  await fs.writeFile(path.join(original, "HEAD"), "ref: refs/heads/main\n");
  await fs.writeFile(path.join(original, "gitdir"), "/old/.git\n");
  const old = new Date("2001-01-01T00:00:00Z");
  for (const entry of ["logs", "HEAD", "gitdir", ""])
    await fs.utimes(path.join(original, entry), old, old);
  await delay(100);
  const startedAt = Date.now() - 20;
  const root = path.join(parent, ".bb-removing-test");
  await fs.rename(original, root);
  const gitdir = path.join(root, "gitdir");
  await fs.writeFile(gitdir, "/quarantined/.git\n");
  return {
    root,
    gitdir,
    startedAt,
    baseline: {
      rootMetadata: await fs.lstat(root),
      unchangedEntries: new Map([
        [gitdir, entryIdentity(await fs.lstat(gitdir))],
      ]),
    },
  };
}

it("treats the renamed root and the rewritten gitdir as unchanged", async () => {
  const tree = await renamedTree();

  await expect(
    directoryTreeChangedSince(tree.root, tree.startedAt, tree.baseline),
  ).resolves.toBe(false);
  await expect(
    directoryTreeChangedSince(tree.root, tree.startedAt),
  ).resolves.toBe(true);
});

it("reports a new entry in the root after the baseline", async () => {
  const tree = await renamedTree();
  await fs.writeFile(path.join(tree.root, "ORIG_HEAD"), "late\n");

  await expect(
    directoryTreeChangedSince(tree.root, tree.startedAt, tree.baseline),
  ).resolves.toBe(true);
});

it("reports a gitdir rewritten again after its identity was taken", async () => {
  const tree = await renamedTree();
  await fs.writeFile(tree.gitdir, "/elsewhere/.git\n");

  await expect(
    directoryTreeChangedSince(tree.root, tree.startedAt, tree.baseline),
  ).resolves.toBe(true);
});

it("reports an exempt entry replaced by a directory", async () => {
  const tree = await renamedTree();
  await fs.rm(tree.gitdir);
  await fs.mkdir(tree.gitdir);

  await expect(
    directoryTreeChangedSince(tree.root, tree.startedAt, tree.baseline),
  ).resolves.toBe(true);
});
