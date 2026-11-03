import { execFile as execFileCallback, spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { access, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeWorktree } from "./worktree.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const workers: ReturnType<typeof spawn>[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd });
  return result.stdout;
}

async function makeWorktree(
  existingRoot?: string,
): Promise<{ path: string; root: string }> {
  const root =
    existingRoot ??
    (await mkdtemp(path.join(os.tmpdir(), "bb-preserve-worktree-")));
  if (!roots.includes(root)) roots.push(root);
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
  await writeFile(path.join(source, ".gitignore"), ".env\n");
  await git(source, "add", "README.md");
  await git(source, "add", ".gitignore");
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
  vi.restoreAllMocks();
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

  it("keeps ignored local data when force removal is requested", async () => {
    const worktree = await makeWorktree();
    const ignoredFile = path.join(worktree.path, ".env");
    await writeFile(ignoredFile, "local secret\n");
    await remove(worktree, true).catch(() => undefined);
    await expect(readFile(ignoredFile, "utf8")).resolves.toBe("local secret\n");
  });

  it("keeps data written as the worktree is quarantined for forced removal", async () => {
    const worktree = await makeWorktree();
    const originalRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await originalRename(from, to);
      if (String(from) === worktree.path) {
        await writeFile(path.join(String(to), ".env"), "raced write\n");
      }
    });
    await expect(remove(worktree, true)).rejects.toMatchObject({
      code: "worktree_preserved",
    });
    await expect(
      readFile(path.join(worktree.path, ".env"), "utf8"),
    ).resolves.toBe("raced write\n");
    expect(
      await git(worktree.path, "status", "--porcelain", "--ignored=matching"),
    ).toContain(".env");
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

  it.skipIf(
    process.platform !== "linux" ||
      (typeof process.getuid === "function" && process.getuid() === 0),
  )("keeps a worktree held by a non-dumpable process that predates it and spoofs an agent name", async ({ skip }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-preserve-worktree-"));
    roots.push(root);
    const signalMarker = path.join(root, "signalled-agent");
    skip(spawnSync("python3", ["--version"]).status !== 0, "python3 is not available");
    const worker = spawn(
      "python3",
      [
        "-c",
        `import ctypes, signal, sys, time
libc = ctypes.CDLL(None)
libc.prctl(4, 0, 0, 0, 0)
libc.prctl(15, b"ssh-agent", 0, 0, 0)
signal.signal(signal.SIGTERM, lambda *_: (open(sys.argv[1], "w").write("signal"), sys.exit(0)))
print("ready", flush=True)
while not __import__("os").path.isdir(sys.argv[2]): time.sleep(0.01)
__import__("os").chdir(sys.argv[2])
print("entered", flush=True)
time.sleep(120)`,
        signalMarker,
        path.join(root, "managed", "repo"),
      ],
      { cwd: root, argv0: "ssh-agent", stdio: ["ignore", "pipe", "ignore"] },
    );
    workers.push(worker);
    await new Promise<void>((resolve, reject) => {
      worker.stdout?.once("data", () => resolve());
      worker.once("error", reject);
    });
    const worktree = await makeWorktree(root);
    await new Promise<void>((resolve, reject) => {
      worker.stdout?.once("data", () => resolve());
      worker.once("error", reject);
    });
    expect((await readFile(`/proc/${worker.pid}/comm`, "utf8")).trim()).toBe(
      "ssh-agent",
    );
    try {
      await readlink(`/proc/${worker.pid}/task/${worker.pid}/cwd`);
      skip(true, "the kernel lets this user read the non-dumpable process");
    } catch (error) {
      skip((error as NodeJS.ErrnoException).code !== "EACCES", "the process cwd was not unreadable");
    }
    await remove(worktree, true).catch(() => undefined);
    expect(() => process.kill(worker.pid!, 0)).not.toThrow();
    await expect(access(signalMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(worktree.path)).resolves.toBeUndefined();
    expect(await readFile(path.join(worktree.path, "README.md"), "utf8")).toBe("published\n");
  });
});
