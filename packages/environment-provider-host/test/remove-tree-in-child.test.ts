import {
  type ChildProcess,
  execFile as execFileCallback,
  spawn,
  spawnSync,
} from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  PARTIALLY_REMOVED_REASON,
  decodeChildRemovalOptions,
  encodeChildRemovalOptions,
  keptTreeReasons,
  recordOwnWrite,
  removalChildEnvironment,
  removeDirectoryTreeInChild,
  stuckRemovalProcess,
  stuckRemovalReason,
  type ChildRemoval,
  type RemovalHeartbeat,
} from "../src/remove-directory-tree.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const mounts: { fuse: ChildProcess; mountPoint: string }[] = [];
const strayPids = new Set<number>();
const GITDIR_CONTENTS = "/quarantined/.git\n";
const CHANGED = "changed data";

function hasCommand(name: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${name}`]).status === 0;
}

const fuseAvailable =
  process.platform === "linux" &&
  existsSync("/dev/fuse") &&
  hasCommand("fuse-overlayfs") &&
  hasCommand("fusermount3");

afterEach(async () => {
  for (const pid of strayPids) if (alive(pid)) process.kill(pid, "SIGKILL");
  strayPids.clear();
  for (const { fuse, mountPoint } of mounts.splice(0)) {
    fuse.kill("SIGCONT");
    await execFile("fusermount3", ["-u", mountPoint]).catch(() =>
      execFile("fusermount3", ["-uz", mountPoint]).catch(() => {}),
    );
    if (fuse.exitCode === null && fuse.signalCode === null) {
      const exited = once(fuse, "exit");
      fuse.kill("SIGTERM");
      await exited;
    }
  }
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function treeOf(directories: number, filesPerDirectory: number) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "bb-remove-child-"));
  roots.push(root);
  for (let directory = 0; directory < directories; directory += 1) {
    const directoryPath = path.join(root, `d${directory}`);
    await fs.mkdir(directoryPath);
    await Promise.all(
      Array.from({ length: filesPerDirectory }, (_, file) =>
        fs.writeFile(path.join(directoryPath, `f${file}`), `${file}\n`),
      ),
    );
  }
  return root;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function quarantineLeftovers(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true });
  return entries.filter((entry) =>
    path.basename(entry).startsWith(".bb-removing-"),
  );
}

async function untilTrue(check: () => boolean, ms: number): Promise<void> {
  const until = performance.now() + ms;
  while (!check()) {
    if (performance.now() > until)
      throw new Error(`the condition did not hold within ${ms} ms`);
    await delay(10);
  }
}

async function stopFuseMount(mountPoint: string): Promise<void> {
  const base = await fs.mkdtemp(path.join(tmpdir(), "bb-remove-fuse-"));
  roots.push(base);
  const layers = ["lower", "upper", "work"].map((name) =>
    path.join(base, name),
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
}

async function expectHung(mountPoint: string): Promise<void> {
  const exit = await execFile("timeout", ["2", "stat", mountPoint]).then(
    () => 0,
    (error: { code?: unknown }) => error.code,
  );
  if (exit !== 124)
    throw new Error(
      `BLOCKED-precondition: stat of the stopped mount ${mountPoint} exited ${String(exit)}, not 124`,
    );
}

async function hungTree() {
  const root = await fs.realpath(await treeOf(2, 20));
  const mountPoint = path.join(root, "sub", "mnt");
  await fs.mkdir(mountPoint, { recursive: true });
  await stopFuseMount(mountPoint);
  await expectHung(mountPoint);
  return { root, mountPoint };
}

function expectNamesListedDirectory(removal: ChildRemoval, mountPoint: string) {
  expect(removal.result.notRespondingPaths).toHaveLength(1);
  const named = removal.result.notRespondingPaths[0]!;
  expect([mountPoint, path.dirname(mountPoint)]).toContain(named);
  const reasons = keptTreeReasons(removal.result, (entry) => entry, CHANGED);
  expect(reasons).toContain(
    `a filesystem was not responding while listing ${named}`,
  );
  expect(reasons).not.toContain(CHANGED);
}

async function quarantinedTree() {
  const parent = await fs.mkdtemp(path.join(tmpdir(), "bb-remove-child-"));
  roots.push(parent);
  const original = path.join(parent, "original");
  await fs.mkdir(path.join(original, "logs"), { recursive: true });
  await fs.writeFile(path.join(original, "HEAD"), "ref: refs/heads/main\n");
  await fs.writeFile(path.join(original, "gitdir"), "/old/.git\n");
  await fs.writeFile(path.join(original, "logs", "HEAD"), "old log\n");
  const old = new Date("2001-01-01T00:00:00Z");
  for (const entry of ["logs/HEAD", "logs", "HEAD", "gitdir", ""])
    await fs.utimes(path.join(original, entry), old, old);
  await delay(100);
  const startedAt = Date.now() - 20;
  const root = path.join(parent, ".bb-removing-test");
  await fs.rename(original, root);
  const gitdir = path.join(root, "gitdir");
  await fs.writeFile(gitdir, GITDIR_CONTENTS);
  const rootMetadata = await fs.lstat(root);
  return {
    root,
    gitdir,
    startedAt,
    rootMetadataBaseline: {
      ctimeMs: rootMetadata.ctimeMs,
      mtimeMs: rootMetadata.mtimeMs,
    },
    ownWrites: new Map([
      [gitdir, await recordOwnWrite(gitdir, GITDIR_CONTENTS)],
    ]),
  };
}

it("removes a tree in another process that reports every entry boundary", async () => {
  const root = await treeOf(4, 50);
  const heartbeats: RemovalHeartbeat[] = [];

  const removal = await removeDirectoryTreeInChild(root, {
    startedAt: Number.MAX_SAFE_INTEGER,
    onHeartbeat: (heartbeat) => heartbeats.push(heartbeat),
  });

  expect(removal.result.status).toBe("removed");
  await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  expect(removal.pid).not.toBe(process.pid);
  expect(removal.ops).toBe(212);
  expect(heartbeats.length).toBeGreaterThan(0);
  for (const heartbeat of heartbeats) {
    expect(heartbeat.pid).toBe(removal.pid);
    expect(
      heartbeat.entry === root ||
        heartbeat.entry.startsWith(`${root}${path.sep}`),
    ).toBe(true);
    expect(heartbeat.ops).toBeLessThanOrEqual(removal.ops);
  }
  const directories = [0, 1, 2, 3].map((index) =>
    path.join(root, `d${index}`),
  );
  expect(
    heartbeats
      .filter((heartbeat) => heartbeat.directory)
      .map((heartbeat) => heartbeat.entry)
      .sort(),
  ).toEqual([...Array(4).fill(root), ...directories, ...directories].sort());
});

it("returns a retained result naming the entry the other process kept", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "bb-remove-child-"));
  roots.push(root);
  const pin = path.join(root, "sub", ".bb-pin-stale");
  await fs.mkdir(path.dirname(pin));
  await fs.writeFile(pin, "pin\n");

  const removal = await removeDirectoryTreeInChild(root, {
    startedAt: Number.MAX_SAFE_INTEGER,
  });

  expect(removal.result.status).toBe("retained");
  expect(removal.result.retainedPaths).toEqual([pin]);
  await expect(fs.readFile(pin, "utf8")).resolves.toBe("pin\n");
});

it("keeps the whole tree when an entry changed after the removal started", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "bb-remove-child-"));
  roots.push(root);
  const startedAt = Date.now() - 5_000;
  const late = path.join(root, "late.txt");
  await fs.writeFile(late, "late\n");
  const rootMetadata = await fs.lstat(root);

  const removal = await removeDirectoryTreeInChild(root, {
    startedAt,
    rootMetadataBaseline: {
      ctimeMs: rootMetadata.ctimeMs,
      mtimeMs: rootMetadata.mtimeMs,
    },
  });

  expect(removal.result.status).toBe("retained");
  expect(removal.result.retainedPaths).toEqual([root]);
  expect(removal.result.removalStarted).toBe(false);
  await expect(fs.readFile(late, "utf8")).resolves.toBe("late\n");
});

it("carries the root baseline, own writes and quarantined root into the other process", async () => {
  const tree = await quarantinedTree();

  const removal = await removeDirectoryTreeInChild(tree.root, {
    startedAt: tree.startedAt,
    allowQuarantinedRoot: true,
    rootMetadataBaseline: tree.rootMetadataBaseline,
    ownWrites: tree.ownWrites,
  });

  expect(removal.result.status).toBe("removed");
  await expect(fs.lstat(tree.root)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
  ["the own writes", { ownWrites: undefined }],
  ["the root baseline", { rootMetadataBaseline: undefined }],
  ["the quarantined root permission", { allowQuarantinedRoot: undefined }],
] as const)(
  "keeps the quarantined tree when %s are left out",
  async (_case, omitted) => {
    const tree = await quarantinedTree();

    const removal = await removeDirectoryTreeInChild(tree.root, {
      startedAt: tree.startedAt,
      allowQuarantinedRoot: true,
      rootMetadataBaseline: tree.rootMetadataBaseline,
      ownWrites: tree.ownWrites,
      ...omitted,
    });

    expect(removal.result.status).toBe("retained");
    await expect(fs.readFile(tree.gitdir, "utf8")).resolves.toBe(
      GITDIR_CONTENTS,
    );
  },
);

it("encodes own writes so they survive a JSON round trip unchanged", async () => {
  const tree = await quarantinedTree();
  const options = {
    startedAt: tree.startedAt,
    allowQuarantinedRoot: true as const,
    rootMetadataBaseline: tree.rootMetadataBaseline,
    ownWrites: tree.ownWrites,
  };

  const decoded = decodeChildRemovalOptions(
    JSON.parse(JSON.stringify(encodeChildRemovalOptions(options))),
  );

  expect(decoded).toEqual(options);
  expect(
    decodeChildRemovalOptions(
      JSON.parse(
        JSON.stringify(encodeChildRemovalOptions({ startedAt: 7 })),
      ),
    ),
  ).toEqual({ startedAt: 7 });
});

it("passes only the allowlisted environment to the removal process", () => {
  const environment = {
    NODE_OPTIONS: "--import tsx",
    PATH: "/usr/bin",
    HOME: "/home/someone",
    TMPDIR: "/tmp/x",
    ELECTRON_RUN_AS_NODE: "1",
  };

  expect(removalChildEnvironment(environment, false)).toEqual({
    TMPDIR: "/tmp/x",
    ELECTRON_RUN_AS_NODE: "1",
  });
  expect(removalChildEnvironment({ PATH: "/usr/bin" }, true)).toEqual({
    ELECTRON_RUN_AS_NODE: "1",
  });
  expect(removalChildEnvironment({ PATH: "/usr/bin" }, false)).toEqual({});
});

it("starts the removal process when the daemon carries NODE_OPTIONS it cannot load", async () => {
  const root = await treeOf(1, 3);
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require ${path.join(root, "missing-preload.cjs")}`;
  try {
    const removal = await removeDirectoryTreeInChild(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
    });
    expect(removal.result.status).toBe("removed");
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
});

it(
  "switches context less than once per two entries on a 5k-file tree",
  async () => {
    const root = await treeOf(10, 500);

    const removal = await removeDirectoryTreeInChild(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
    });

    expect(removal.result.status).toBe("removed");
    expect(removal.ops).toBe(5_030);
    expect(removal.voluntaryContextSwitches / removal.ops).toBeLessThan(0.5);
  },
  120_000,
);

it(
  "stops a healthy walk within a second of an abort and leaves no half-removed names",
  async () => {
    const root = await treeOf(20, 1_000);
    const controller = new AbortController();
    let abortedAt = 0;

    const removal = await removeDirectoryTreeInChild(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
      signal: controller.signal,
      onHeartbeat: (heartbeat) => {
        if (abortedAt !== 0 || heartbeat.ops < 2_000) return;
        abortedAt = performance.now();
        controller.abort();
      },
    });

    expect(abortedAt).toBeGreaterThan(0);
    expect(performance.now() - abortedAt).toBeLessThan(1_000);
    expect(alive(removal.pid)).toBe(false);
    expect(removal.stop?.cause).toBe("abort");
    expect(removal.result.status).toBe("retained");
    expect(removal.result.stoppedPaths.length).toBeGreaterThan(0);
    const reasons = keptTreeReasons(removal.result, (entry) => entry, CHANGED);
    expect(reasons).toContain(PARTIALLY_REMOVED_REASON);
    expect(reasons).not.toContain(CHANGED);
    await expect(fs.lstat(root)).resolves.toBeDefined();
    await expect(quarantineLeftovers(root)).resolves.toEqual([]);
  },
  120_000,
);

it(
  "lets the walk stop itself at the deadline and exit cleanly",
  async () => {
    const root = await treeOf(20, 1_000);

    const removal = await removeDirectoryTreeInChild(root, {
      startedAt: Number.MAX_SAFE_INTEGER,
      deadline: AbortSignal.timeout(1_000),
    });

    expect(removal.stop?.cause).toBe("deadline");
    expect(removal.exit).toEqual({ code: 0, signal: null });
    expect(removal.result.status).toBe("retained");
    expect(removal.result.stoppedPaths.length).toBeGreaterThan(0);
    expect(removal.result.notRespondingPaths).toEqual([]);
    await expect(quarantineLeftovers(root)).resolves.toEqual([]);
  },
  120_000,
);

describe.runIf(fuseAvailable)(
  "a filesystem that stops answering under the tree",
  () => {
    it("ends the walk within the stall time and names the directory it was listing", async () => {
      const { root, mountPoint } = await hungTree();
      const started = performance.now();

      const removal = await removeDirectoryTreeInChild(root, {
        startedAt: Number.MAX_SAFE_INTEGER,
        stallMs: 3_000,
      });

      expect(performance.now() - started).toBeLessThan(8_000);
      expect(removal.stop?.cause).toBe("stall");
      expect(removal.result.status).toBe("retained");
      expect(alive(removal.pid)).toBe(false);
      expectNamesListedDirectory(removal, mountPoint);
      await expect(fs.readdir(path.dirname(mountPoint))).resolves.toEqual([
        "mnt",
      ]);
    }, 30_000);

    it("ends the walk when the mount appears under a directory it has not reached", async () => {
      const root = await fs.realpath(await treeOf(20, 500));
      const last = (await fs.readdir(root)).at(-1)!;
      const mountPoint = path.join(root, last, "mnt");
      await fs.mkdir(mountPoint);
      let mounting: Promise<void> | null = null;
      let stopped = false;
      let reachedBeforeStop = false;

      const removal = await removeDirectoryTreeInChild(root, {
        startedAt: Number.MAX_SAFE_INTEGER,
        stallMs: 3_000,
        onHeartbeat: (heartbeat) => {
          mounting ??= stopFuseMount(mountPoint).then(() => {
            stopped = true;
          });
          if (!stopped && heartbeat.entry.startsWith(path.join(root, last)))
            reachedBeforeStop = true;
        },
      });

      await mounting;
      if (reachedBeforeStop)
        throw new Error(
          `BLOCKED-precondition: the walk reached ${last} before its mount was stopped`,
        );
      await expectHung(mountPoint);
      expect(removal.stop?.cause).toBe("stall");
      expect(alive(removal.pid)).toBe(false);
      expectNamesListedDirectory(removal, mountPoint);
    }, 60_000);

    it("keeps the daemon's own fs calls answering while four walks hang", async () => {
      expect(process.env.UV_THREADPOOL_SIZE ?? "4").toBe("4");
      const trees = await Promise.all([0, 1, 2, 3].map(() => hungTree()));
      const controller = new AbortController();
      const hanging = new Set<string>();

      const removals = trees.map(({ root, mountPoint }) =>
        removeDirectoryTreeInChild(root, {
          startedAt: Number.MAX_SAFE_INTEGER,
          signal: controller.signal,
          graceMs: 200,
          onHeartbeat: (heartbeat) => {
            if (heartbeat.entry === path.dirname(mountPoint)) hanging.add(root);
          },
        }),
      );
      await untilTrue(() => hanging.size === trees.length, 10_000);
      await delay(500);
      const started = performance.now();
      await fs.stat(tmpdir());
      const statMs = performance.now() - started;
      controller.abort();
      const finished = await Promise.all(removals);

      expect(statMs).toBeLessThan(2_000);
      for (const removal of finished) {
        expect(removal.result.status).toBe("retained");
        expect(alive(removal.pid)).toBe(false);
      }
    }, 60_000);

    it("kills the walk when it does not stop within the grace period", async () => {
      const { root, mountPoint } = await hungTree();
      const started = performance.now();

      const removal = await removeDirectoryTreeInChild(root, {
        startedAt: Number.MAX_SAFE_INTEGER,
        deadline: AbortSignal.timeout(1_500),
        graceMs: 500,
      });

      expect(performance.now() - started).toBeLessThan(5_000);
      expect(removal.stop?.cause).toBe("deadline");
      expect(removal.exit?.signal).toBe("SIGKILL");
      expect(alive(removal.pid)).toBe(false);
      expect(removal.result.status).toBe("retained");
      expect(removal.result.notRespondingPaths).toEqual([]);
      expect(removal.result.stoppedPaths).toEqual([path.dirname(mountPoint)]);
    }, 30_000);

    it("refuses a second removal of a path whose first removal process would not die", async () => {
      const { root } = await hungTree();

      const first = await removeDirectoryTreeInChild(root, {
        startedAt: Number.MAX_SAFE_INTEGER,
        stallMs: 1_000,
        exitWaitMs: 300,
        killSignal: "SIGCONT",
      });
      strayPids.add(first.pid);

      expect(first.exit).toBeNull();
      expect(alive(first.pid)).toBe(true);
      expect(stuckRemovalProcess(root)).toBe(first.pid);
      await expect(
        removeDirectoryTreeInChild(root, { startedAt: Number.MAX_SAFE_INTEGER }),
      ).rejects.toThrow(stuckRemovalReason(first.pid));
      process.kill(first.pid, "SIGKILL");
      await untilTrue(() => stuckRemovalProcess(root) === null, 5_000);
      expect(alive(first.pid)).toBe(false);
    }, 30_000);
  },
);
