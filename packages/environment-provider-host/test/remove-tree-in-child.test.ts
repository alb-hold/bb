import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import {
  decodeChildRemovalOptions,
  encodeChildRemovalOptions,
  recordOwnWrite,
  removalChildEnvironment,
  removeDirectoryTreeInChild,
  type RemovalHeartbeat,
} from "../src/remove-directory-tree.js";

const roots: string[] = [];
const GITDIR_CONTENTS = "/quarantined/.git\n";

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function treeOf(directories: number, filesPerDirectory: number) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "bb-remove-child-"));
  roots.push(root);
  for (let directory = 0; directory < directories; directory += 1) {
    const directoryPath = path.join(root, `d${directory}`);
    await fs.mkdir(directoryPath);
    await Promise.all(
      Array.from({ length: filesPerDirectory }, (_, file) =>
        fs.writeFile(path.join(directoryPath, `f${file}`), `${file}\n`),
      ),
    );
  }
  return root;
}

async function quarantinedTree() {
  const parent = await fs.mkdtemp(path.join(tmpdir(), "bb-remove-child-"));
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
  const rootMetadata = await fs.lstat(root);
  return {
    root,
    gitdir,
    startedAt,
    rootMetadataBaseline: {
      ctimeMs: rootMetadata.ctimeMs,
      mtimeMs: rootMetadata.mtimeMs,
    },
    ownWrites: new Map([
      [gitdir, await recordOwnWrite(gitdir, GITDIR_CONTENTS)],
    ]),
  };
}

it("removes a tree in another process that reports every entry boundary", async () => {
  const root = await treeOf(4, 50);
  const heartbeats: RemovalHeartbeat[] = [];

  const removal = await removeDirectoryTreeInChild(root, {
    startedAt: Number.MAX_SAFE_INTEGER,
    onHeartbeat: (heartbeat) => heartbeats.push(heartbeat),
  });

  expect(removal.result.status).toBe("removed");
  await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  expect(removal.pid).not.toBe(process.pid);
  expect(removal.ops).toBe(204);
  expect(heartbeats.length).toBeGreaterThan(0);
  for (const heartbeat of heartbeats) {
    expect(heartbeat.pid).toBe(removal.pid);
    expect(heartbeat.entry.startsWith(`${root}${path.sep}`)).toBe(true);
    expect(heartbeat.ops).toBeLessThanOrEqual(removal.ops);
  }
});

it("returns a retained result with the changed entry from the other process", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "bb-remove-child-"));
  roots.push(root);
  const startedAt = Date.now() - 5_000;
  const late = path.join(root, "late.txt");
  await fs.writeFile(late, "late\n");
  const rootMetadata = await fs.lstat(root);

  const removal = await removeDirectoryTreeInChild(root, {
    startedAt,
    rootMetadataBaseline: {
      ctimeMs: rootMetadata.ctimeMs,
      mtimeMs: rootMetadata.mtimeMs,
    },
  });

  expect(removal.result.status).toBe("retained");
  expect(removal.result.retainedPaths).toContain(late);
  await expect(fs.readFile(late, "utf8")).resolves.toBe("late\n");
});

it("carries the root baseline, own writes and quarantined root into the other process", async () => {
  const tree = await quarantinedTree();

  const removal = await removeDirectoryTreeInChild(tree.root, {
    startedAt: tree.startedAt,
    allowQuarantinedRoot: true,
    rootMetadataBaseline: tree.rootMetadataBaseline,
    ownWrites: tree.ownWrites,
  });

  expect(removal.result.status).toBe("removed");
  await expect(fs.lstat(tree.root)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
  ["the own writes", { ownWrites: undefined }],
  ["the root baseline", { rootMetadataBaseline: undefined }],
  ["the quarantined root permission", { allowQuarantinedRoot: undefined }],
] as const)(
  "keeps the quarantined tree when %s are left out",
  async (_case, omitted) => {
    const tree = await quarantinedTree();

    const removal = await removeDirectoryTreeInChild(tree.root, {
      startedAt: tree.startedAt,
      allowQuarantinedRoot: true,
      rootMetadataBaseline: tree.rootMetadataBaseline,
      ownWrites: tree.ownWrites,
      ...omitted,
    });

    expect(removal.result.status).toBe("retained");
    await expect(fs.readFile(tree.gitdir, "utf8")).resolves.toBe(
      GITDIR_CONTENTS,
    );
  },
);

it("encodes own writes so they survive a JSON round trip unchanged", async () => {
  const tree = await quarantinedTree();
  const options = {
    startedAt: tree.startedAt,
    allowQuarantinedRoot: true as const,
    rootMetadataBaseline: tree.rootMetadataBaseline,
    ownWrites: tree.ownWrites,
  };

  const decoded = decodeChildRemovalOptions(
    JSON.parse(JSON.stringify(encodeChildRemovalOptions(options))),
  );

  expect(decoded).toEqual(options);
  expect(
    decodeChildRemovalOptions(
      JSON.parse(
        JSON.stringify(encodeChildRemovalOptions({ startedAt: 7 })),
      ),
    ),
  ).toEqual({ startedAt: 7 });
});

it("passes only the allowlisted environment to the removal process", () => {
  const environment = {
    NODE_OPTIONS: "--import tsx",
    PATH: "/usr/bin",
    HOME: "/home/someone",
    TMPDIR: "/tmp/x",
    ELECTRON_RUN_AS_NODE: "1",
  };

  expect(removalChildEnvironment(environment, false)).toEqual({
    TMPDIR: "/tmp/x",
    ELECTRON_RUN_AS_NODE: "1",
  });
  expect(removalChildEnvironment({ PATH: "/usr/bin" }, true)).toEqual({
    ELECTRON_RUN_AS_NODE: "1",
  });
  expect(removalChildEnvironment({ PATH: "/usr/bin" }, false)).toEqual({});
});

it("starts the removal process when the daemon carries NODE_OPTIONS it cannot load", async () => {
  const root = await treeOf(1, 3);
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require ${path.join(root, "missing-preload.cjs")}`;
  try {
    const removal = await removeDirectoryTreeInChild(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
    });
    expect(removal.result.status).toBe("removed");
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
});

it(
  "switches context less than once per two entries on a 5k-file tree",
  async () => {
    const root = await treeOf(10, 500);

    const removal = await removeDirectoryTreeInChild(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
    });

    expect(removal.result.status).toBe("removed");
    expect(removal.ops).toBe(5_010);
    expect(removal.voluntaryContextSwitches / removal.ops).toBeLessThan(0.5);
  },
  120_000,
);
