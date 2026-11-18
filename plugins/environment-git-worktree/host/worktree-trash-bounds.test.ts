import {
  type ChildProcess,
  execFile as execFileCallback,
  spawn,
  spawnSync,
} from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { FILE_TIMESTAMP_LAG_MS } from "bb-environment-provider-host/remove-directory-tree";
import { removalDeadlineReason } from "bb-environment-provider-host/remove-timeout";
import { afterEach, describe, expect, it } from "vitest";
import {
  isWorktreePreservedError,
  setTestWorktreeHolderScan,
} from "./worktree-preservation.js";
import { removeWorktree } from "./worktree.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const mounts: ChildProcess[] = [];

function hasCommand(name: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${name}`]).status === 0;
}

const fuseAvailable =
  process.platform === "linux" &&
  existsSync("/dev/fuse") &&
  hasCommand("fuse-overlayfs") &&
  hasCommand("fusermount3");

async function mountedUnder(base: string): Promise<string[]> {
  if (process.platform !== "linux") return [];
  const table = await fs.readFile("/proc/self/mountinfo", "utf8");
  return table
    .split("\n")
    .map((line) => line.split(" ")[4])
    .filter(
      (mountPoint): mountPoint is string =>
        mountPoint !== undefined && mountPoint.startsWith(`${base}/`),
    );
}

afterEach(async () => {
  setTestWorktreeHolderScan(undefined);
  for (const fuse of mounts.splice(0)) fuse.kill("SIGCONT");
  for (const root of roots) {
    for (const mountPoint of await mountedUnder(root)) {
      await execFile("fusermount3", ["-u", mountPoint]).catch(() =>
        execFile("fusermount3", ["-uz", mountPoint]).catch(() => {}),
      );
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

async function managedWorktree() {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bb-worktree-trash-bounds-")),
  );
  roots.push(base);
  const source = path.join(base, "source");
  const dataDir = path.join(base, "host-data");
  const root = path.join(dataDir, "worktrees", "thr_bounds");
  const bare = path.join(base, "remote.git");
  const workspace = path.join(root, "repo");
  await Promise.all([fs.mkdir(source), fs.mkdir(root, { recursive: true })]);
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
  await fs.mkdir(path.join(workspace, "sub", "deeper"), { recursive: true });
  await fs.writeFile(path.join(workspace, "sub", "deeper", "kept.txt"), "x\n");
  await delay(FILE_TIMESTAMP_LAG_MS + 50);
  return {
    base,
    path: workspace,
    root,
    source,
    trashRoot: path.join(dataDir, ".trash"),
  };
}

async function stopFuseMount(base: string, mountPoint: string): Promise<void> {
  const layers = ["lower", "upper", "work"].map((name) =>
    path.join(base, `fuse-${name}`),
  );
  await Promise.all(layers.map((layer) => fs.mkdir(layer)));
  const fuse = spawn(
    "fuse-overlayfs",
    [
      "-f",
      "-o",
      `lowerdir=${layers[0]},upperdir=${layers[1]},workdir=${layers[2]}`,
      mountPoint,
    ],
    { stdio: "ignore" },
  );
  mounts.push(fuse);
  const until = performance.now() + 5_000;
  while (!(await mountedUnder(base)).includes(mountPoint)) {
    if (performance.now() > until)
      throw new Error(
        `BLOCKED-precondition: fuse-overlayfs did not mount ${mountPoint}`,
      );
    await delay(10);
  }
  fuse.kill("SIGSTOP");
  const exit = await execFile("timeout", ["2", "stat", mountPoint]).then(
    () => 0,
    (error: { code?: unknown }) => error.code,
  );
  if (exit !== 124)
    throw new Error(
      `BLOCKED-precondition: stat of the stopped mount ${mountPoint} exited ${String(exit)}, not 124`,
    );
}

async function trashEntries(trashRoot: string): Promise<string[]> {
  return fs.readdir(trashRoot).catch(() => []);
}

describe("bounding the macOS inspection before a worktree moves to the trash", () => {
  it("keeps the worktree and names the entry when the deadline passes during the inspection", async () => {
    const worktree = await managedWorktree();
    setTestWorktreeHolderScan({ status: "clear" });
    const deadline = new AbortController();
    let inspecting = false;
    const heartbeatPids = new Set<number>();

    const error = await removeWorktree({
      path: worktree.path,
      rootPath: worktree.root,
      trashRoot: worktree.trashRoot,
      deadline: { signal: deadline.signal, ms: 120_000 },
      testHooks: {
        platform: "darwin",
        afterFinalCheck: async () => {
          inspecting = true;
        },
        onRemovalHeartbeat: (heartbeat) => {
          if (!inspecting) return;
          heartbeatPids.add(heartbeat.pid);
          deadline.abort();
        },
      },
    }).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(isWorktreePreservedError(error)).toBe(true);
    expect([...heartbeatPids]).toHaveLength(1);
    expect(heartbeatPids.has(process.pid)).toBe(false);
    expect((error as Error).message).toContain(
      `${removalDeadlineReason(120_000)} (it stopped at ${worktree.path}`,
    );
    expect(await trashEntries(worktree.trashRoot)).toEqual([]);
    expect(
      await fs.readFile(
        path.join(worktree.path, "sub", "deeper", "kept.txt"),
        "utf8",
      ),
    ).toBe("x\n");
    expect(await git(worktree.source, "worktree", "list")).toContain(
      worktree.path,
    );
  });

  it.runIf(fuseAvailable)(
    "keeps the worktree within the deadline when a filesystem inside it stops answering during the inspection",
    async () => {
      const worktree = await managedWorktree();
      setTestWorktreeHolderScan({ status: "clear" });
      const started = performance.now();

      const outcome = await Promise.race([
        removeWorktree({
          path: worktree.path,
          rootPath: worktree.root,
          trashRoot: worktree.trashRoot,
          deadline: { signal: AbortSignal.timeout(20_000), ms: 20_000 },
          testHooks: {
            platform: "darwin",
            afterFinalCheck: async (quarantinedPath) => {
              const mountPoint = path.join(quarantinedPath, "sub", "mnt");
              await fs.mkdir(mountPoint);
              await stopFuseMount(worktree.base, mountPoint);
            },
          },
        }).then(
          () => ({ kind: "removed" as const }),
          (failure: unknown) => ({ kind: "failed" as const, failure }),
        ),
        delay(35_000).then(() => ({ kind: "still running" as const })),
      ]);
      const elapsed = performance.now() - started;

      expect(outcome.kind).toBe("failed");
      const failure = outcome.kind === "failed" ? outcome.failure : null;
      expect(isWorktreePreservedError(failure)).toBe(true);
      expect(elapsed).toBeLessThan(30_000);
      expect((failure as Error).message).toContain(
        `the removal did not finish within 20 seconds (it stopped at ${worktree.path}`,
      );
      expect((failure as Error).message).toMatch(
        new RegExp(
          `the inspection process \\d+ was killed while it read ${worktree.path}`,
        ),
      );
      expect(await trashEntries(worktree.trashRoot)).toEqual([]);
      expect(
        await fs.readFile(path.join(worktree.path, "README.md"), "utf8"),
      ).toBe("published\n");
      expect((await fs.readdir(path.join(worktree.path, "sub"))).sort()).toEqual(
        ["deeper", "mnt"],
      );
    },
    60_000,
  );
});
