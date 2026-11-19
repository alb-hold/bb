import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  directoryTreeChangedSince,
  inspectTreeBeforeMove,
  recordOwnWrite,
  removeDirectoryTree,
  treeSnapshot,
  untrustedTimestampFilesystem,
} from "../src/remove-directory-tree.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function tree(): Promise<string> {
  const parent = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "bb-tree-io-backend-")),
  );
  roots.push(parent);
  const root = path.join(parent, "entry");
  for (let directory = 0; directory < 4; directory += 1) {
    await fs.mkdir(path.join(root, `d${directory}`), { recursive: true });
    for (let file = 0; file < 10; file += 1)
      await fs.writeFile(path.join(root, `d${directory}`, `f${file}`), "x");
  }
  return root;
}

async function fileRequestsInFlight(
  run: () => Promise<unknown>,
): Promise<{ requests: string[]; polls: number }> {
  const seen = new Set<string>();
  let done = false;
  let polls = 0;
  const record = () => {
    for (const name of process.getActiveResourcesInfo())
      if (name.startsWith("FSReq")) seen.add(name);
  };
  const running = run().finally(() => {
    done = true;
  });
  record();
  while (!done) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    polls += 1;
    record();
  }
  await running;
  return { requests: [...seen], polls };
}

const callers: [
  string,
  (
    root: string,
    rootMetadata: { ctimeMs: number; mtimeMs: number },
  ) => Promise<unknown>,
][] = [
  [
    "directoryTreeChangedSince",
    (root) => directoryTreeChangedSince(root, Date.now() + 60_000),
  ],
  [
    "recordOwnWrite",
    (root) => recordOwnWrite(path.join(root, "d0", "f0"), "x"),
  ],
  [
    "untrustedTimestampFilesystem",
    (root) => untrustedTimestampFilesystem(root),
  ],
  [
    "inspectTreeBeforeMove",
    (root, rootMetadata) =>
      inspectTreeBeforeMove(root, Date.now() + 60_000, { rootMetadata }),
  ],
  ["treeSnapshot", (root) => treeSnapshot(root)],
  [
    "removeDirectoryTree",
    (root) => removeDirectoryTree(root, { startedAt: Date.now() + 60_000 }),
  ],
];

describe("tree helpers called in the daemon's own process", () => {
  it.each(callers)(
    "%s leaves its file operations on the thread pool",
    async (_name, call) => {
      const root = await tree();
      const info = await fs.lstat(root);
      const rootMetadata = { ctimeMs: info.ctimeMs, mtimeMs: info.mtimeMs };
      const observed = await fileRequestsInFlight(() =>
        call(root, rootMetadata),
      );
      expect(observed.requests.length).toBeGreaterThan(0);
      expect(observed.polls).toBeGreaterThan(0);
    },
  );
});
