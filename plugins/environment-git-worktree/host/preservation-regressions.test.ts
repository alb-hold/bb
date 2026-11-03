import { execFile as execFileCallback, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { removeWorktree } from "./worktree.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const workers: ReturnType<typeof spawn>[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd });
  return result.stdout;
}

async function makeWorktree(): Promise<{ path: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bb-preserve-worktree-"));
  roots.push(root);
  const source = path.join(root, "source");
  const managed = path.join(root, "managed");
  const bare = path.join(root, "remote.git");
  const workspace = path.join(managed, "repo");
  await Promise.all([mkdir(source), mkdir(managed)]);
  await git(root, "init", "--bare", bare);
  await git(source, "init", "--initial-branch=main");
  await git(source, "config", "user.name", "Worktree Test");
  await git(source, "config", "user.email", "worktree-test@example.invalid");
  await writeFile(path.join(source, "README.md"), "published\n");
  await git(source, "add", "README.md");
  await git(source, "commit", "-m", "published");
  await git(source, "remote", "add", "origin", bare);
  await git(source, "push", "--set-upstream", "origin", "main");
  await git(source, "worktree", "add", "-b", "feature", workspace);
  await git(source, "-C", workspace, "push", "--set-upstream", "origin", "feature");
  return { path: workspace, root: managed };
}

async function remove(
  worktree: { path: string; root: string },
  force = true,
): Promise<void> {
  await Reflect.apply(removeWorktree, undefined, [
    { path: worktree.path, rootPath: worktree.root, force },
  ]);
}

afterEach(async () => {
  await Promise.all(
    workers.splice(0).map(async (worker) => {
      if (worker.exitCode !== null || worker.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
      worker.kill("SIGKILL");
      await exited;
    }),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("real worktree teardown preservation", () => {
  it.each([
    ["modified", async (workspace: string) => writeFile(path.join(workspace, "README.md"), "edited\n")],
    ["staged", async (workspace: string) => {
      await writeFile(path.join(workspace, "staged.txt"), "staged\n");
      await git(workspace, "add", "staged.txt");
    }],
    ["untracked", async (workspace: string) => writeFile(path.join(workspace, "draft.txt"), "draft\n")],
  ])("keeps a %s worktree despite forced git removal", async (_kind, change) => {
    const worktree = await makeWorktree();
    await change(worktree.path);
    await remove(worktree, true).catch(() => undefined);
    await expect(access(worktree.path)).resolves.toBeUndefined();
    expect(await git(worktree.path, "status", "--porcelain")).not.toBe("");
  });

  it("keeps a worktree used as another live process's cwd without signalling it", async () => {
    const worktree = await makeWorktree();
    const signalMarker = path.join(worktree.root, "signalled");
    const worker = spawn(
      process.execPath,
      ["-e", "const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(process.argv[1],'signal');process.exit(0)});setInterval(()=>{},1000);process.send('ready')", signalMarker],
      { cwd: worktree.path, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    workers.push(worker);
    await new Promise<void>((resolve, reject) => {
      worker.once("message", () => resolve());
      worker.once("error", reject);
    });
    await remove(worktree).catch(() => undefined);
    expect(() => process.kill(worker.pid!, 0)).not.toThrow();
    await expect(access(signalMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(worktree.path)).resolves.toBeUndefined();
    expect(await readFile(path.join(worktree.path, "README.md"), "utf8")).toBe("published\n");
  });
});
