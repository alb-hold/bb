import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { FILE_TIMESTAMP_LAG_MS } from "bb-environment-provider-host/remove-directory-tree";
import { afterEach, describe, expect, it } from "vitest";
import { removeWorktree } from "./worktree.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd });
}

async function worktreeWithLinkedTools(): Promise<{
  path: string;
  root: string;
  source: string;
}> {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bb-darwin-worktree-")),
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
  const tools = path.join(workspace, "node_modules", "tool", "bin");
  const bin = path.join(workspace, "node_modules", ".bin");
  await fs.mkdir(tools, { recursive: true });
  await fs.mkdir(bin);
  await fs.writeFile(path.join(tools, "cli.js"), "#!/usr/bin/env node\n");
  await fs.symlink("../tool/bin/cli.js", path.join(bin, "tool"));
  await fs.symlink("../missing/bin/cli.js", path.join(bin, "gone"));
  await delay(FILE_TIMESTAMP_LAG_MS + 50);
  return { path: workspace, root: managed, source };
}

describe.runIf(process.platform === "darwin")(
  "removing a git worktree on macOS",
  () => {
    it("removes a worktree whose node_modules/.bin holds live and dangling symbolic links", async () => {
      const worktree = await worktreeWithLinkedTools();
      await removeWorktree({ path: worktree.path, rootPath: worktree.root });
      await expect(fs.lstat(worktree.path)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const { stdout } = await execFile("git", ["worktree", "list"], {
        cwd: worktree.source,
      });
      expect(stdout).not.toContain(worktree.path);
    });
  },
);
