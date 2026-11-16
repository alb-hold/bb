import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import {
  directoryTreeChangedSince,
  recordOwnWrite,
  removeDirectoryTree,
  RetainedRecoveryError,
  type RemoveDirectoryTreeHooks,
} from "../src/remove-directory-tree.js";

const roots: string[] = [];
const GITDIR_CONTENTS = "/quarantined/.git\n";
const SAME_LENGTH_REWRITE = "/quarantinXd/.git\n";

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
  await fs.writeFile(path.join(original, "logs", "HEAD"), "old log\n");
  const old = new Date("2001-01-01T00:00:00Z");
  for (const entry of ["logs/HEAD", "logs", "HEAD", "gitdir", ""])
    await fs.utimes(path.join(original, entry), old, old);
  await delay(100);
  const startedAt = Date.now() - 20;
  const root = path.join(parent, ".bb-removing-test");
  await fs.rename(original, root);
  const gitdir = path.join(root, "gitdir");
  await fs.writeFile(gitdir, GITDIR_CONTENTS);
  return {
    root,
    gitdir,
    startedAt,
    baseline: {
      rootMetadata: await fs.lstat(root),
      ownWrites: new Map([
        [gitdir, await recordOwnWrite(gitdir, GITDIR_CONTENTS)],
      ]),
    },
  };
}

it.each([
  ["a microsecond after the baseline", -0.001, true],
  ["exactly at the baseline", 0, true],
  ["a microsecond before the baseline", 0.001, false],
] as const)(
  "judges an entry stamped %s as changed: %s",
  async (_case, offset, changed) => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "bb-changed-since-"));
    roots.push(root);
    const entry = path.join(root, "late");
    await fs.writeFile(entry, "late\n");
    const rootMetadata = await fs.lstat(root);
    const stamp = await fs.lstat(entry);

    await expect(
      directoryTreeChangedSince(
        root,
        Math.max(stamp.ctimeMs, stamp.mtimeMs) + offset,
        { rootMetadata },
      ),
    ).resolves.toBe(changed);
  },
);

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

async function removeTree(
  tree: Awaited<ReturnType<typeof renamedTree>>,
  hooks: RemoveDirectoryTreeHooks = {},
) {
  return removeDirectoryTree(tree.root, {
    startedAt: tree.startedAt,
    allowQuarantinedRoot: true,
    rootMetadataBaseline: {
      ctimeMs: tree.baseline.rootMetadata.ctimeMs,
      mtimeMs: tree.baseline.rootMetadata.mtimeMs,
    },
    ownWrites: tree.baseline.ownWrites,
    ...hooks,
  });
}

async function findFileWith(
  directory: string,
  contents: string,
): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const candidate = path.join(entry.parentPath, entry.name);
    if ((await fs.readFile(candidate, "utf8")) === contents)
      found.push(candidate);
  }
  return found;
}

it("removes a tree whose own write is untouched", async () => {
  const tree = await renamedTree();

  await expect(removeTree(tree)).resolves.toMatchObject({
    status: "removed",
    mountedPaths: [],
    unanchoredPaths: [],
    removalStarted: true,
  });
  await expect(fs.access(tree.root)).rejects.toThrow();
});

it("retains an own write rewritten in place before removal starts", async () => {
  const tree = await renamedTree();
  await delay(20);
  await fs.writeFile(tree.gitdir, GITDIR_CONTENTS);

  await expect(removeTree(tree)).resolves.toMatchObject({
    status: "retained",
  });
  await expect(fs.readFile(tree.gitdir, "utf8")).resolves.toBe(GITDIR_CONTENTS);
});

it("retains an own write whose contents differ from what was recorded", async () => {
  const tree = await renamedTree();
  const baseline = {
    ...tree.baseline,
    ownWrites: new Map([
      [tree.gitdir, await recordOwnWrite(tree.gitdir, SAME_LENGTH_REWRITE)],
    ]),
  };

  await expect(removeTree({ ...tree, baseline })).resolves.toMatchObject({
    status: "retained",
  });
  await expect(fs.readFile(tree.gitdir, "utf8")).resolves.toBe(GITDIR_CONTENTS);
});

it.each([
  "beforeEntryRemoval",
  "afterEntryCheck",
  "beforeEntryRename",
  "afterEntryQuarantined",
] as const)(
  "keeps a write through a descriptor held on the own write at %s",
  async (hook) => {
    const tree = await renamedTree();
    const held = await fs.open(tree.gitdir, "r+");
    let written = false;
    try {
      const write = async (entry: string) => {
        if (entry !== tree.gitdir || written) return;
        await delay(20);
        await held.write(SAME_LENGTH_REWRITE, 0);
        written = true;
      };
      const hooks: RemoveDirectoryTreeHooks = {};
      hooks[hook] = write;
      const outcome = await removeTree(tree, hooks).then(
        (result) => result.status,
        (error: unknown) => {
          if (error instanceof RetainedRecoveryError) return "retained";
          throw error;
        },
      );
      expect(written).toBe(true);
      expect(outcome).toBe("retained");
      await expect(
        findFileWith(path.dirname(tree.root), SAME_LENGTH_REWRITE),
      ).resolves.not.toEqual([]);
    } finally {
      await held.close();
    }
  },
);

it("keeps a file created in the tree while the own write is being removed", async () => {
  const tree = await renamedTree();
  const late = path.join(tree.root, "ORIG_HEAD");
  let created = false;
  const result = await removeTree(tree, {
    afterEntryCheck: async (entry) => {
      if (entry !== tree.gitdir || created) return;
      await fs.writeFile(late, "late\n");
      created = true;
    },
  });

  expect(created).toBe(true);
  expect(result.status).toBe("retained");
  await expect(fs.readFile(late, "utf8")).resolves.toBe("late\n");
});

it.each([
  ["a directory", "logs"],
  ["a file", "HEAD"],
] as const)(
  "keeps the whole tree when %s in it is on another device",
  async (_kind, mounted) => {
    const tree = await renamedTree();
    const mountPoint = path.join(tree.root, mounted);

    const result = await removeTree(tree, {
      entryDevice: (entry, device) =>
        entry === mountPoint ? device + 1 : device,
    });

    expect(result.status).toBe("retained");
    expect(result.mountedPaths).toEqual([mountPoint]);
    await expect(
      fs.readFile(path.join(tree.root, "logs", "HEAD"), "utf8"),
    ).resolves.toBe("old log\n");
    await expect(
      fs.readFile(path.join(tree.root, "HEAD"), "utf8"),
    ).resolves.toBe("ref: refs/heads/main\n");
  },
);

it("keeps an entry that another filesystem is mounted on after inspection", async () => {
  const tree = await renamedTree();
  const mountPoint = path.join(tree.root, "logs");
  let checks = 0;

  const result = await removeTree(tree, {
    entryDevice: (entry, device) =>
      entry === mountPoint && ++checks > 1 ? device + 1 : device,
  });

  expect(checks).toBe(2);
  expect(result.status).toBe("retained");
  expect(result.mountedPaths).toEqual([mountPoint]);
  await expect(
    fs.readFile(path.join(tree.root, "logs", "HEAD"), "utf8"),
  ).resolves.toBe("old log\n");
});
