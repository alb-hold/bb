import { execFile as execFileCallback, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { FILE_TIMESTAMP_LAG_MS } from "bb-environment-provider-host/remove-directory-tree";
import {
  worktreeTrashEntryName,
  worktreeTrashEntryTrashedAt,
} from "bb-environment-provider-host/worktree-trash";
import { afterEach, describe, expect, it } from "vitest";
import {
  isWorktreePreservedError,
  setTestWorktreeHolderScan,
} from "./worktree-preservation.js";
import { removeWorktree } from "./worktree.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  setTestWorktreeHolderScan(undefined);
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd })).stdout;
}

async function managedWorktree(): Promise<{
  path: string;
  root: string;
  source: string;
  dataDir: string;
}> {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bb-worktree-trash-")),
  );
  roots.push(base);
  const source = path.join(base, "source");
  const dataDir = path.join(base, "host-data");
  const root = path.join(dataDir, "worktrees", "thr_trash");
  const bare = path.join(base, "remote.git");
  const workspace = path.join(root, "repo");
  await Promise.all([
    fs.mkdir(source),
    fs.mkdir(root, { recursive: true }),
  ]);
  await git(base, "init", "--bare", bare);
  await git(source, "init", "--initial-branch=main");
  await git(source, "config", "user.name", "Worktree Test");
  await git(source, "config", "user.email", "worktree-test@example.invalid");
  await fs.writeFile(path.join(source, "README.md"), "published\n");
  await git(source, "add", "README.md");
  await git(source, "commit", "-m", "published");
  await git(source, "remote", "add", "origin", bare);
  await git(source, "push", "--set-upstream", "origin", "main");
  await git(source, "worktree", "add", "-b", "feature", workspace);
  await git(workspace, "push", "--set-upstream", "origin", "feature");
  await delay(FILE_TIMESTAMP_LAG_MS + 50);
  return { path: workspace, root, source, dataDir };
}

function hiddenHolder(cwd: string): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.stdin.once("data", () => { require("node:fs").writeFileSync("late.txt", "written after removal\\n"); process.exit(0); });',
    ],
    { cwd, stdio: ["pipe", "ignore", "inherit"] },
  );
  children.push(child);
  return child;
}

async function missing(target: string): Promise<boolean> {
  return fs.lstat(target).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
}

describe("removing a git worktree into the trash", () => {
  it("renames the tree into the trash on macOS, so a holder the scan cannot see keeps writing into it", async () => {
    const worktree = await managedWorktree();
    const trashRoot = path.join(worktree.dataDir, ".trash");
    const holder = hiddenHolder(worktree.path);
    await delay(200);
    expect(holder.exitCode).toBeNull();
    setTestWorktreeHolderScan({ status: "clear" });
    const removedAt = Date.parse("2026-11-18T10:00:00.000Z");

    await removeWorktree({
      path: worktree.path,
      rootPath: worktree.root,
      trashRoot,
      testHooks: { platform: "darwin", now: () => removedAt },
    });

    expect(await missing(worktree.path)).toBe(true);
    const entries = await fs.readdir(trashRoot);
    expect(entries).toHaveLength(1);
    const entry = path.join(trashRoot, entries[0]!);
    expect(entries[0]).toMatch(/^thr_trash-repo-/u);
    expect(worktreeTrashEntryTrashedAt(entries[0]!)).toBe(removedAt);
    expect(await fs.readFile(path.join(entry, "README.md"), "utf8")).toBe(
      "published\n",
    );
    expect(await git(worktree.source, "worktree", "list")).not.toContain(
      worktree.path,
    );

    holder.stdin!.write("go\n");
    const [code] = await once(holder, "exit");
    expect(code).toBe(0);
    expect(await fs.readFile(path.join(entry, "late.txt"), "utf8")).toBe(
      "written after removal\n",
    );
  });

  it.runIf(existsSync("/dev/shm"))(
    "keeps the worktree on macOS when the trash is on another device",
    async () => {
      const worktree = await managedWorktree();
      const otherDevice = await fs.mkdtemp(
        path.join("/dev/shm", "bb-worktree-trash-"),
      );
      roots.push(otherDevice);
      const trashRoot = path.join(otherDevice, ".trash");
      await fs.mkdir(trashRoot);
      const [worktreeInfo, trashInfo] = await Promise.all([
        fs.lstat(worktree.path),
        fs.lstat(trashRoot),
      ]);
      expect(trashInfo.dev).not.toBe(worktreeInfo.dev);
      setTestWorktreeHolderScan({ status: "clear" });

      const error = await removeWorktree({
        path: worktree.path,
        rootPath: worktree.root,
        trashRoot,
        testHooks: { platform: "darwin" },
      }).then(
        () => null,
        (failure: unknown) => failure,
      );

      expect(isWorktreePreservedError(error)).toBe(true);
      expect((error as Error).message).toContain("on another device");
      expect(
        await fs.readFile(path.join(worktree.path, "README.md"), "utf8"),
      ).toBe("published\n");
      expect(await fs.readdir(trashRoot)).toEqual([]);
      expect(await git(worktree.source, "worktree", "list")).toContain(
        worktree.path,
      );
    },
  );

  it("puts the worktree back when the move into the trash fails on macOS", async () => {
    const worktree = await managedWorktree();
    const trashRoot = path.join(worktree.dataDir, ".trash");
    const removedAt = Date.parse("2026-11-18T10:00:00.000Z");
    const occupied = path.join(
      trashRoot,
      worktreeTrashEntryName("thr_trash-repo", new Date(removedAt)),
    );
    await fs.mkdir(occupied, { recursive: true });
    await fs.writeFile(path.join(occupied, "other.txt"), "another tree\n");
    setTestWorktreeHolderScan({ status: "clear" });

    const error = await removeWorktree({
      path: worktree.path,
      rootPath: worktree.root,
      trashRoot,
      testHooks: { platform: "darwin", now: () => removedAt },
    }).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(isWorktreePreservedError(error)).toBe(true);
    expect((error as Error).message).toContain("could not move it to the trash");
    expect(
      await fs.readFile(path.join(worktree.path, "README.md"), "utf8"),
    ).toBe("published\n");
    expect(await fs.readdir(trashRoot)).toEqual([path.basename(occupied)]);
    expect(await fs.readdir(occupied)).toEqual(["other.txt"]);
    expect(await git(worktree.source, "worktree", "list")).toContain(
      worktree.path,
    );
    expect(await git(worktree.path, "status", "--porcelain")).toBe("");
  });

  it("deletes the worktree at once on Linux and leaves no trash", async () => {
    const worktree = await managedWorktree();
    const trashRoot = path.join(worktree.dataDir, ".trash");
    setTestWorktreeHolderScan({ status: "clear" });

    await removeWorktree({
      path: worktree.path,
      rootPath: worktree.root,
      trashRoot,
      testHooks: { platform: "linux" },
    });

    expect(await missing(worktree.path)).toBe(true);
    expect(await missing(trashRoot)).toBe(true);
    expect(await git(worktree.source, "worktree", "list")).not.toContain(
      worktree.path,
    );
  });
});
