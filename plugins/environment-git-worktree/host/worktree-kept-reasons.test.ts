import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  FILE_TIMESTAMP_LAG_MS,
  type RemoveDirectoryTreeHooks,
} from "bb-environment-provider-host/remove-directory-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { descendantsOnly } from "./descendants-only.js";
import { hostProc, useProcReaderForTests } from "./holders.js";
import { removeWorktree } from "./worktree.js";

const injected = vi.hoisted(() => ({
  hooks: null as null | (() => RemoveDirectoryTreeHooks),
}));

vi.mock(
  "bb-environment-provider-host/remove-directory-tree",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("bb-environment-provider-host/remove-directory-tree")
      >();
    return {
      ...actual,
      removeDirectoryTree: (
        root: string,
        hooks: RemoveDirectoryTreeHooks = {},
      ) =>
        actual.removeDirectoryTree(root, {
          ...hooks,
          ...(injected.hooks?.() ?? {}),
        }),
      removeDirectoryTreeInChild: async (
        root: string,
        options: Parameters<typeof actual.removeDirectoryTreeInChild>[1],
      ) => {
        if (injected.hooks === null)
          return actual.removeDirectoryTreeInChild(root, options);
        return {
          result: await actual.removeDirectoryTree(root, {
            ...actual.decodeChildRemovalOptions(
              actual.encodeChildRemovalOptions(options),
            ),
            ...injected.hooks(),
          }),
          pid: process.pid,
          ops: 0,
          voluntaryContextSwitches: 0,
          stop: null,
          exit: { code: 0, signal: null },
        };
      },
    };
  },
);

const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterEach(async () => {
  injected.hooks = null;
  useProcReaderForTests(null);
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd });
}

async function worktree(): Promise<{ path: string; root: string }> {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bb-kept-reasons-")),
  );
  roots.push(base);
  const source = path.join(base, "source");
  const managed = path.join(base, "managed");
  const bare = path.join(base, "remote.git");
  const workspace = path.join(managed, "repo");
  await Promise.all([fs.mkdir(source), fs.mkdir(managed)]);
  await git(base, "init", "--bare", bare);
  await git(source, "init", "--initial-branch=main");
  await git(source, "config", "user.name", "Worktree Test");
  await git(source, "config", "user.email", "worktree-test@example.invalid");
  await fs.writeFile(path.join(source, "README.md"), "published\n");
  await fs.writeFile(path.join(source, ".gitignore"), "node_modules/\n");
  await git(source, "add", "README.md", ".gitignore");
  await git(source, "commit", "-m", "published");
  await git(source, "remote", "add", "origin", bare);
  await git(source, "push", "--set-upstream", "origin", "main");
  await git(source, "worktree", "add", "-b", "feature", workspace);
  await git(workspace, "push", "--set-upstream", "origin", "feature");
  for (const name of ["a", "b"]) {
    await fs.mkdir(path.join(workspace, "node_modules", name), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspace, "node_modules", name, "out.txt"),
      name,
    );
  }
  await delay(FILE_TIMESTAMP_LAG_MS + 50);
  return { path: workspace, root: managed };
}

function failingAnchors(
  failNow: () => boolean,
): Pick<RemoveDirectoryTreeHooks, "statDescriptor"> {
  return {
    statDescriptor: async (candidate) => {
      if (failNow())
        throw Object.assign(new Error(`ENOENT: ${candidate}`), {
          code: "ENOENT",
        });
      return fs.stat(candidate);
    },
  };
}

async function keptMessage(target: {
  path: string;
  root: string;
}): Promise<string> {
  const error = await removeWorktree({
    path: target.path,
    rootPath: target.root,
  }).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}

describe.runIf(process.platform === "linux" || process.platform === "darwin")(
  "the reasons a worktree removal gives when a directory cannot be anchored",
  () => {
    beforeEach(() => {
      if (process.platform === "linux")
        useProcReaderForTests(descendantsOnly(hostProc, -1));
    });

    it("names only the anchor failure when it fails before anything is removed", async () => {
      const target = await worktree();
      injected.hooks = () => failingAnchors(() => true);
      const message = await keptMessage(target);
      expect(message).toContain(
        "could not anchor directory on this filesystem",
      );
      expect(message).not.toContain("new or changed");
      expect(message).not.toContain("partially removed");
      await expect(
        fs.readFile(
          path.join(target.path, "node_modules", "a", "out.txt"),
          "utf8",
        ),
      ).resolves.toBe("a");
    });

    it("says the worktree may be partially removed when the anchor fails after removal began", async () => {
      const target = await worktree();
      let removing = false;
      injected.hooks = () => ({
        ...failingAnchors(() => removing),
        beforeEntryRename: async () => {
          removing = true;
        },
      });
      const message = await keptMessage(target);
      expect(removing).toBe(true);
      expect(message).toContain(
        "could not anchor directory on this filesystem",
      );
      expect(message).toContain("partially removed");
      expect(message).not.toContain("new or changed");
    });

    it("removes the worktree tree in a separate process", async () => {
      const target = await worktree();
      const pids = new Set<number>();

      await removeWorktree({
        path: target.path,
        rootPath: target.root,
        testHooks: {
          onRemovalHeartbeat: (heartbeat) => pids.add(heartbeat.pid),
        },
      });

      await expect(fs.lstat(target.path)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(pids.size).toBeGreaterThan(0);
      expect(pids.has(process.pid)).toBe(false);
    });
  },
);
