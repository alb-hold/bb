import {
  type ChildProcess,
  execFile,
  spawn,
  spawnSync,
} from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import { createWorktreeHostEntry, setTestRemoveDeadline } from "./host.js";
import { descendantsOnly } from "./host/descendants-only.js";
import { hostProc, useProcReaderForTests } from "./host/holders.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const mounts: { fuse: ChildProcess; mountPoint: string }[] = [];

function hasCommand(name: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${name}`]).status === 0;
}

const fuseAvailable =
  process.platform === "linux" &&
  existsSync("/dev/fuse") &&
  hasCommand("fuse-overlayfs") &&
  hasCommand("fusermount3");

afterEach(async () => {
  setTestRemoveDeadline(undefined);
  useProcReaderForTests(null);
  for (const { fuse, mountPoint } of mounts.splice(0)) {
    fuse.kill("SIGCONT");
    await execFileAsync("fusermount3", ["-u", mountPoint]).catch(() =>
      execFileAsync("fusermount3", ["-uz", mountPoint]).catch(() => {}),
    );
    if (fuse.exitCode === null && fuse.signalCode === null) {
      const exited = once(fuse, "exit");
      fuse.kill("SIGTERM");
      await exited;
    }
  }
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "bb",
      GIT_AUTHOR_EMAIL: "bb@example.com",
      GIT_COMMITTER_NAME: "bb",
      GIT_COMMITTER_EMAIL: "bb@example.com",
    },
  });
  return result.stdout;
}

async function stopFuseMount(base: string, mountPoint: string): Promise<void> {
  const layers = ["lower", "upper", "work"].map((name) =>
    join(base, `fuse-${name}`),
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
  mounts.push({ fuse, mountPoint });
  const until = performance.now() + 5_000;
  while (
    !(await fs.readFile("/proc/self/mountinfo", "utf8")).includes(
      ` ${mountPoint} `,
    )
  ) {
    if (performance.now() > until)
      throw new Error(
        `BLOCKED-precondition: fuse-overlayfs did not mount ${mountPoint}`,
      );
    await delay(10);
  }
  fuse.kill("SIGSTOP");
  const exit = await execFileAsync("timeout", ["2", "stat", mountPoint]).then(
    () => 0,
    (error: { code?: unknown }) => error.code,
  );
  if (exit !== 124)
    throw new Error(
      `BLOCKED-precondition: stat of the stopped mount ${mountPoint} exited ${String(exit)}, not 124`,
    );
}

async function createFixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "bb-worktree-hung-mount-")),
  );
  temporaryRoots.push(root);
  const sourcePath = join(root, "repo");
  const dataDir = join(root, "plugin-data");
  await fs.mkdir(sourcePath, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await git(sourcePath, "init", "--initial-branch=main");
  await fs.writeFile(join(sourcePath, "README.md"), "hello\n");
  await git(sourcePath, "add", ".");
  await git(sourcePath, "commit", "-m", "initial");
  const remotePath = join(root, "origin.git");
  await git(root, "init", "--bare", "--initial-branch=main", remotePath);
  await git(sourcePath, "remote", "add", "origin", remotePath);
  await git(sourcePath, "push", "origin", "main");
  const harness = experimental_createHostEntryHarness(
    createWorktreeHostEntry(),
    { experimental_paths: { dataDir, tempDir: join(dataDir, "tmp") } },
  );
  const path = join(dataDir, "worktrees", "thr_hung", "clean");
  await fs.mkdir(join(dataDir, "worktrees", "thr_hung"), { recursive: true });
  await git(sourcePath, "worktree", "add", "--detach", path, "origin/main");
  await fs.writeFile(`${path}.completed`, "clean\n");
  const mountPoint = join(path, "sub", "mnt");
  await fs.mkdir(mountPoint, { recursive: true });
  await stopFuseMount(root, mountPoint);
  return { sourcePath, harness, path, mountPoint };
}

describe.runIf(fuseAvailable)(
  "removing a worktree with a filesystem that stopped answering inside it",
  () => {
    it("keeps the worktree at its path within the deadline, names the stage and keeps answering other calls", async () => {
      const fixture = await createFixture();
      useProcReaderForTests(descendantsOnly(hostProc, process.pid));
      setTestRemoveDeadline(20_000);
      const started = performance.now();
      let removeFinishedAt = 0;

      const removing = fixture.harness
        .experimental_call("remove", {
          operationId: "remove-hung-mount",
          pathKey: "thr_hung",
          path: fixture.path,
          ownedBranch: null,
        })
        .finally(() => {
          removeFinishedAt = performance.now();
        });
      await delay(2_000);
      const answered = await fixture.harness.experimental_call(
        "defaultBaseBranch",
        { sourcePath: fixture.sourcePath },
      );
      const removeFinishedBeforeAnswer = removeFinishedAt !== 0;
      const removed = await removing;

      expect(answered).toHaveProperty("branch");
      expect(removeFinishedBeforeAnswer).toBe(false);
      expect(removeFinishedAt - started).toBeLessThan(30_000);
      expect(removed).toMatchObject({
        status: "retained",
        message: expect.stringMatching(
          /the removal did not finish within 20 seconds \(it stopped while [a-z ]+\)/,
        ),
      });
      await expect(
        fs.readFile(join(fixture.path, "README.md"), "utf8"),
      ).resolves.toBe("hello\n");
      await expect(fs.readdir(join(fixture.path, "sub"))).resolves.toEqual([
        "mnt",
      ]);
      await fixture.harness.experimental_dispose();
    }, 60_000);
  },
);
