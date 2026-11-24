import {
  type ChildProcess,
  execFile,
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
import { afterEach, describe, expect, it } from "vitest";
import { removeHostPath } from "../../src/command-handlers/path-mutations.js";
import { processDoubtsIgnorableForRemoval } from "../../src/command-handlers/temporary-removal.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const fuses: ChildProcess[] = [];
const originalTmpdir = process.env.TMPDIR;

function hasCommand(name: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${name}`]).status === 0;
}

const fuseAvailable =
  process.platform === "linux" &&
  existsSync("/dev/fuse") &&
  hasCommand("fuse-overlayfs") &&
  hasCommand("fusermount3");

async function mountsUnder(root: string): Promise<string[]> {
  const table = await fs.readFile("/proc/self/mountinfo", "utf8");
  return table
    .split("\n")
    .map((line) => line.split(" ")[4] ?? "")
    .filter((mountPoint) => mountPoint.startsWith(`${root}/`))
    .reverse();
}

afterEach(async () => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  for (const fuse of fuses) fuse.kill("SIGCONT");
  for (const root of roots)
    for (const mountPoint of await mountsUnder(root))
      await execFileAsync("fusermount3", ["-u", mountPoint]).catch(() =>
        execFileAsync("fusermount3", ["-uz", mountPoint]).catch(() => {}),
      );
  for (const fuse of fuses.splice(0))
    if (fuse.exitCode === null && fuse.signalCode === null) {
      const exited = once(fuse, "exit");
      fuse.kill("SIGTERM");
      await exited;
    }
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function startFuseMount(
  base: string,
  mountPoint: string,
): Promise<ChildProcess> {
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
  fuses.push(fuse);
  const until = performance.now() + 5_000;
  while (!(await mountsUnder(base)).includes(mountPoint)) {
    if (performance.now() > until)
      throw new Error(
        `BLOCKED-precondition: fuse-overlayfs did not mount ${mountPoint}`,
      );
    await delay(10);
  }
  return fuse;
}

const removalContext = {
  dataDir: "/nonexistent/bb-temporary-removal-data",
  threadStorageRootPath: "/nonexistent/bb-temporary-removal-storage",
  runtimeManager: { listLoadedWorkspacePaths: () => [] },
};

async function targetInStoppedMount(): Promise<{
  fuse: ChildProcess;
  target: string;
}> {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bb-temporary-removal-mount-")),
  );
  roots.push(base);
  const temporaryRoot = path.join(base, "tmp");
  const mountPoint = path.join(temporaryRoot, "mnt");
  await fs.mkdir(mountPoint, { recursive: true });
  process.env.TMPDIR = temporaryRoot;
  const fuse = await startFuseMount(base, mountPoint);
  const target = path.join(mountPoint, "bundle");
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "evidence.txt"), "bundle");
  fuse.kill("SIGSTOP");
  const exit = await execFileAsync("timeout", ["2", "ls", target]).then(
    () => 0,
    (error: { code?: unknown }) => error.code,
  );
  if (exit !== 124)
    throw new Error(
      `BLOCKED-precondition: listing ${target} on the stopped mount exited ${String(exit)}, not 124`,
    );
  return { fuse, target };
}

describe.runIf(fuseAvailable)(
  "relaxing process doubts for a temporary directory on a filesystem that stopped answering",
  () => {
    it("refuses a temporary removal of a target inside a stopped mount in bounded time, before touching it, and leaves its contents", async () => {
      const { fuse, target } = await targetInStoppedMount();

      const started = performance.now();
      const outcome = await Promise.race([
        removeHostPath(
          {
            type: "host.remove_path",
            path: target,
            recursive: true,
            temporaryRemoval: { protectedPaths: [] },
          },
          removalContext,
        ).then(
          () => ({ removed: true as const }),
          (error: unknown) => ({ removed: false as const, error }),
        ),
        delay(5_000).then(() => "still waiting" as const),
      ]);
      const elapsed = performance.now() - started;

      expect(outcome).toMatchObject({
        removed: false,
        error: {
          code: "path_in_use",
          message: `Refusing to remove ${target}: it is on a different filesystem mount than the temporary directory, so it was not touched.`,
        },
      });
      expect(elapsed).toBeLessThan(1_000);
      fuse.kill("SIGCONT");
      await expect(
        fs.readFile(path.join(target, "evidence.txt"), "utf8"),
      ).resolves.toBe("bundle");
    }, 60_000);

    it("refuses in bounded time a target inside a stopped mount in the temporary directory and leaves its contents", async () => {
      const { fuse, target } = await targetInStoppedMount();

      const started = performance.now();
      const verdict = await Promise.race([
        processDoubtsIgnorableForRemoval(target, removalContext, []),
        delay(5_000).then(() => "still waiting" as const),
      ]);
      const elapsed = performance.now() - started;

      expect(verdict).toBe(false);
      expect(elapsed).toBeLessThan(1_000);
      fuse.kill("SIGCONT");
      await expect(
        fs.readFile(path.join(target, "evidence.txt"), "utf8"),
      ).resolves.toBe("bundle");
    }, 30_000);
  },
);
