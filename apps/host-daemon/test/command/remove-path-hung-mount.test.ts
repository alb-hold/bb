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
import { hostProc, useProcReaderForTests } from "@bb/process-utils";
import { afterEach, describe, expect, it } from "vitest";
import { CommandRouter } from "../../src/command-router.js";
import { setTestRemovalBounds } from "../../src/command-handlers/remove-held-directory.js";
import {
  createHarness,
  fetchDispatchTestArtifact,
  noopEventSink,
  unexpectedProjectAttachmentFetch,
  unexpectedProviderMaintenance,
} from "./dispatch-helpers.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const fuses: ChildProcess[] = [];
const watchdogs: ChildProcess[] = [];
const strays: number[] = [];

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

async function killAndAwaitExit(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  const until = performance.now() + 10_000;
  while (performance.now() < until) {
    if (!existsSync(`/proc/${pid}`)) return;
    await delay(20);
  }
}

afterEach(async () => {
  setTestRemovalBounds(undefined);
  useProcReaderForTests(null);
  for (const pid of strays.splice(0)) await killAndAwaitExit(pid);
  for (const watchdog of watchdogs.splice(0))
    if (watchdog.exitCode === null && watchdog.signalCode === null)
      watchdog.kill("SIGKILL");
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

async function stopFuseMount(
  base: string,
  mountPoint: string,
): Promise<number> {
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
  fuse.kill("SIGSTOP");
  const exit = await execFileAsync("timeout", ["2", "stat", mountPoint]).then(
    () => 0,
    (error: { code?: unknown }) => error.code,
  );
  if (exit !== 124)
    throw new Error(
      `BLOCKED-precondition: stat of the stopped mount ${mountPoint} exited ${String(exit)}, not 124`,
    );
  if (fuse.pid === undefined)
    throw new Error("BLOCKED-precondition: fuse-overlayfs has no pid");
  return fuse.pid;
}

function resumeLater(pid: number, seconds: number): void {
  const watchdog = spawn("sh", ["-c", `sleep ${seconds}; kill -CONT ${pid}`], {
    detached: true,
    stdio: "ignore",
  });
  watchdog.unref();
  watchdogs.push(watchdog);
}

async function removalChildren(): Promise<number[]> {
  const found: number[] = [];
  for (const name of await fs.readdir("/proc")) {
    if (!/^\d+$/u.test(name)) continue;
    const [stat, commandLine] = await Promise.all([
      fs.readFile(`/proc/${name}/stat`, "utf8").catch(() => ""),
      fs.readFile(`/proc/${name}/cmdline`, "utf8").catch(() => ""),
    ]);
    const parent = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1];
    if (
      parent === String(process.pid) &&
      commandLine.includes("remove-tree-child")
    )
      found.push(Number(name));
  }
  return found;
}

async function storageOverStoppedMount(): Promise<{
  root: string;
  target: string;
}> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bb-remove-path-hung-")),
  );
  roots.push(root);
  const target = path.join(root, "storage");
  const mountPoint = path.join(target, "sub", "mnt");
  await fs.mkdir(mountPoint, { recursive: true });
  await fs.writeFile(path.join(target, "data.txt"), "keep");
  const fusePid = await stopFuseMount(root, mountPoint);
  resumeLater(fusePid, 45);
  useProcReaderForTests({
    ...hostProc,
    readdir: async (name) =>
      name === "/proc" ? [String(process.pid)] : hostProc.readdir(name),
  });
  return { root, target };
}

function createRouter(): CommandRouter {
  const harness = createHarness({ workspacePath: "/tmp/env-hung-mount" });
  return new CommandRouter({
    dataDir: "/tmp/bb-router-test-data",
    eventSink: noopEventSink,
    fetchProjectAttachment: unexpectedProjectAttachmentFetch,
    fetchPluginHostArtifact: fetchDispatchTestArtifact,
    ...unexpectedProviderMaintenance,
    logger: { debug: () => undefined, warn: () => undefined },
    runtimeManager: harness.manager,
    threadStorageRootPath: "/tmp/bb-router-test-thread-storage",
  });
}

function removePath(router: CommandRouter, target: string, requestId: string) {
  return router.handleOnlineRpcRequest({
    type: "host-rpc.request",
    requestId,
    command: { type: "host.remove_path", path: target, recursive: true },
  });
}

describe.runIf(fuseAvailable)(
  "removing a path with a filesystem that stopped answering inside it",
  () => {
    it("keeps answering other host calls, gives up within the deadline and puts the directory back", async () => {
      const { root, target } = await storageOverStoppedMount();
      setTestRemovalBounds({ deadlineMs: 20_000, stallMs: 5_000 });
      const router = createRouter();
      const started = performance.now();
      let removeFinishedAt = 0;

      const removing = removePath(router, target, "remove-hung").finally(() => {
        removeFinishedAt = performance.now();
      });
      await delay(2_000);
      const askedAt = performance.now();
      const answered = await router.handleOnlineRpcRequest({
        type: "host-rpc.request",
        requestId: "exists-while-removing",
        command: { type: "host.paths_exist", paths: [root] },
      });
      const answeredAt = performance.now();
      const removeFinishedBeforeAnswer = removeFinishedAt !== 0;
      const removed = await removing;

      expect(answered).toMatchObject({
        ok: true,
        result: { existence: { [root]: true } },
      });
      expect(answeredAt - started).toBeLessThan(4_000);
      expect(answeredAt - askedAt).toBeLessThan(2_000);
      expect(removeFinishedBeforeAnswer).toBe(false);
      expect(removeFinishedAt - started).toBeLessThan(30_000);
      expect(removed).toMatchObject({
        ok: false,
        errorCode: "path_in_use",
        errorMessage: expect.stringContaining(
          `a filesystem was not responding while listing ${path.join(target, "sub")}`,
        ),
      });
      await expect(
        fs.readFile(path.join(target, "data.txt"), "utf8"),
      ).resolves.toBe("keep");
      await expect(fs.readdir(path.join(target, "sub"))).resolves.toEqual([
        "mnt",
      ]);
    }, 90_000);

    it("leaves the data in its removal path while the stopped removal process has not exited", async () => {
      const { root, target } = await storageOverStoppedMount();
      setTestRemovalBounds({
        deadlineMs: 4_000,
        stallMs: 1_000,
        graceMs: 300,
        exitWaitMs: 300,
        killSignal: "SIGCONT",
      });
      const router = createRouter();

      const removed = await removePath(router, target, "remove-unexited");
      const message = removed.ok ? "" : removed.errorMessage;
      const live = /The removal process (\d+) has not exited/u.exec(message);
      if (live !== null) strays.push(Number(live[1]));
      const quarantines = (await fs.readdir(root)).filter((name) =>
        name.startsWith(".storage.removing-"),
      );

      expect(removed).toMatchObject({ ok: false, errorCode: "path_in_use" });
      expect(live).not.toBeNull();
      expect(existsSync(`/proc/${live?.[1]}`)).toBe(true);
      expect(quarantines).toHaveLength(1);
      expect(message).toContain(
        `so recoverable data stays at ${path.join(root, quarantines[0] ?? "")} until it does; the original path ${target} was not replaced`,
      );
      expect(existsSync(target)).toBe(false);
      await expect(
        fs.readFile(path.join(root, quarantines[0] ?? "", "data.txt"), "utf8"),
      ).resolves.toBe("keep");
      const retried = await removePath(router, target, "remove-retry");
      expect(retried).toMatchObject({
        ok: false,
        errorCode: "path_in_use",
        errorMessage: expect.stringContaining(
          `an earlier removal of this path is still stuck (process ${live?.[1]})`,
        ),
      });
      expect(existsSync(target)).toBe(false);
    }, 90_000);

    it("puts the directory back once the stopped removal process exits before the deadline", async () => {
      const { root, target } = await storageOverStoppedMount();
      setTestRemovalBounds({
        deadlineMs: 6_000,
        stallMs: 1_000,
        graceMs: 300,
        exitWaitMs: 300,
        killSignal: "SIGCONT",
      });
      const router = createRouter();
      const started = performance.now();

      const removing = removePath(router, target, "remove-exits-in-fence");
      await delay(2_500);
      const children = await removalChildren();
      strays.push(...children);
      const killedAt = performance.now();
      for (const pid of children) process.kill(pid, "SIGKILL");
      const removed = await removing;
      const finishedAt = performance.now();

      expect(children).toHaveLength(1);
      expect(finishedAt - killedAt).toBeLessThan(2_000);
      expect(finishedAt - started).toBeLessThan(6_000);
      expect(removed).toMatchObject({
        ok: false,
        errorCode: "path_in_use",
        errorMessage: expect.stringContaining(
          `a filesystem was not responding while listing ${path.join(target, "sub")}`,
        ),
      });
      expect(removed.ok ? "" : removed.errorMessage).not.toContain(
        "has not exited",
      );
      await expect(
        fs.readFile(path.join(target, "data.txt"), "utf8"),
      ).resolves.toBe("keep");
      expect(
        (await fs.readdir(root)).filter((name) =>
          name.startsWith(".storage.removing-"),
        ),
      ).toEqual([]);
    }, 90_000);
  },
);
