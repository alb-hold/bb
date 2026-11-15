import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FILE_TIMESTAMP_LAG_MS } from "bb-environment-provider-host/remove-directory-tree";
import { afterEach, describe, expect, it } from "vitest";
import {
  hostProc,
  useProcReaderForTests,
  type ProcReader,
} from "@bb/process-utils";
import {
  HOLDER_REFUSAL_FIRST_DELAY_MS,
  HOLDER_REFUSAL_MAX_DELAY_MS,
  resetHolderRefusalsForTests,
  useHolderRefusalClockForTests,
  useProcessCredentialsReaderForTests,
  useProcessStartReaderForTests,
} from "./holder-refusal-backoff.js";
import { removeDirectoryAfterHolderRecheck } from "./remove-held-directory.js";

const children: ChildProcess[] = [];
const roots: string[] = [];
afterEach(async () => {
  useProcReaderForTests(null);
  useHolderRefusalClockForTests(null);
  useProcessStartReaderForTests(null);
  useProcessCredentialsReaderForTests(null);
  resetHolderRefusalsForTests();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

const python = spawnSync("python3", ["--version"]);
const runsHere =
  process.platform === "linux" &&
  python.status === 0 &&
  (typeof process.getuid !== "function" || process.getuid() !== 0);

async function target() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-holder-refusal-"));
  roots.push(root);
  const directory = path.join(root, "target");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "held.txt"), "precious\n");
  await delay(FILE_TIMESTAMP_LAG_MS + 50);
  return directory;
}

async function startProcess(options: {
  comm: string;
  dumpable: boolean;
  inside?: string;
  extraArgs?: string[];
}) {
  const source = [
    "import ctypes, os, signal, sys, time",
    "libc = ctypes.CDLL(None, use_errno=True)",
    "inside = sys.argv[-2]",
    "kept = []",
    "def release(*_):",
    "    for fd in kept: os.close(fd)",
    "    kept.clear()",
    "    os.chdir('/')",
    "    assert libc.prctl(4, 1, 0, 0, 0) == 0",
    "    print('released', flush=True)",
    "signal.signal(signal.SIGUSR1, release)",
    "if inside:",
    "    os.chdir(inside)",
    "    kept.append(os.open(os.path.join(inside, 'held.txt'), os.O_RDWR))",
    options.dumpable ? "" : "assert libc.prctl(4, 0, 0, 0, 0) == 0",
    "assert libc.prctl(15, sys.argv[-1].encode(), 0, 0, 0) == 0",
    "print('ready', flush=True)",
    "while True: time.sleep(600)",
  ].join("\n");
  const child = spawn(
    "python3",
    [
      "-c",
      "import os; exec(os.environ['BB_HOLDER_SOURCE'])",
      ...(options.extraArgs ?? []),
      options.inside ?? "",
      options.comm,
    ],
    {
      env: { ...process.env, BB_HOLDER_SOURCE: source },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  children.push(child);
  await new Promise<void>((resolve) =>
    child.stdout?.once("data", () => resolve()),
  );
  return child;
}

async function unreadable(pid: number): Promise<boolean> {
  try {
    await fs.readlink(`/proc/${pid}/ns/mnt`);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EACCES";
  }
}

function readerWatching(pid: number) {
  const counts = { scans: 0 };
  const reader: ProcReader = {
    ...hostProc,
    readdir: async (target) => {
      if (target !== "/proc") return hostProc.readdir(target);
      counts.scans += 1;
      return ["self", String(pid)];
    },
  };
  return { counts, reader };
}

async function attempt(directory: string): Promise<string> {
  try {
    await removeDirectoryAfterHolderRecheck({
      directory,
      action: "remove",
      recursive: true,
    });
    return "removed";
  } catch (error) {
    return (error as Error).message;
  }
}

describe.skipIf(!runsHere)("a removal blocked by an unreadable process", () => {
  it("keeps a target held by an unreadable process named ssh-agent and names both doubts", async ({
    skip,
  }) => {
    const directory = await target();
    const child = await startProcess({
      comm: "ssh-agent",
      dumpable: false,
      inside: directory,
    });
    const pid = child.pid ?? 0;
    skip(!(await unreadable(pid)), "the kernel lets this user read it");
    useProcReaderForTests(readerWatching(pid).reader);
    const outcome = await attempt(directory);
    expect(outcome).toContain("could not be established");
    expect(outcome).toContain(`process ${pid} (`);
    expect(outcome).toContain("it is non-dumpable");
    expect(outcome).toContain("cwd identity could not be read");
    expect(outcome).toContain(
      `process ${pid} (ssh-agent) has an unreadable holder path`,
    );
    await expect(
      fs.readFile(path.join(directory, "held.txt"), "utf8"),
    ).resolves.toBe("precious\n");
  });

  it("names an unreadable holder by its comm and never by its arguments", async ({
    skip,
  }) => {
    const directory = await target();
    const child = await startProcess({
      comm: "worker",
      dumpable: false,
      inside: directory,
      extraArgs: ["--token=SECRETVALUE", "postgres://u:SECRET@h/db"],
    });
    const pid = child.pid ?? 0;
    skip(!(await unreadable(pid)), "the kernel lets this user read it");
    expect(await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).toContain(
      "SECRETVALUE",
    );
    useProcReaderForTests(readerWatching(pid).reader);
    const outcome = await attempt(directory);
    expect(outcome).toContain("could not be established");
    expect(outcome).toContain(
      `process ${pid} (worker) has an unreadable holder path`,
    );
    expect(outcome).toContain("(worker; it is non-dumpable)");
    expect(outcome).not.toContain("SECRET");
    expect(outcome).not.toContain("postgres://");
    expect(outcome).not.toContain("python3");
  });

  it("removes a target when a readable process named ssh-agent holds nothing in it", async () => {
    const directory = await target();
    const child = await startProcess({ comm: "ssh-agent", dumpable: true });
    const pid = child.pid ?? 0;
    expect((await fs.readFile(`/proc/${pid}/comm`, "utf8")).trim()).toBe(
      "ssh-agent",
    );
    useProcReaderForTests(readerWatching(pid).reader);
    expect(await attempt(directory)).toBe("removed");
    expect(existsSync(directory)).toBe(false);
  });

  it("answers an unchanged set from the first reason without scanning or renaming, and doubles the wait up to the cap", async ({
    skip,
  }) => {
    const directory = await target();
    const child = await startProcess({
      comm: "notagent",
      dumpable: false,
      inside: directory,
    });
    const pid = child.pid ?? 0;
    skip(!(await unreadable(pid)), "the kernel lets this user read it");
    let now = 1_000_000;
    useHolderRefusalClockForTests(() => now);
    const { counts, reader } = readerWatching(pid);
    useProcReaderForTests(reader);
    const first = await attempt(directory);
    expect(first).toContain("could not be established");
    expect(counts.scans).toBe(1);
    const reason = /established \((.*)\)\. Nothing was stopped/u.exec(
      first,
    )?.[1];
    expect(reason).toBeDefined();
    const delays: number[] = [];
    let scanStartedAt = now;
    let delay = HOLDER_REFUSAL_FIRST_DELAY_MS;
    for (let round = 0; round < 8; round += 1) {
      now = scanStartedAt + delay - 1;
      const before = await fs.lstat(directory, { bigint: true });
      const quick = await attempt(directory);
      const after = await fs.lstat(directory, { bigint: true });
      expect(counts.scans).toBe(round + 1);
      expect(quick).toContain(`(${reason}). Nothing was stopped`);
      expect(quick).toContain("The same processes have blocked it since");
      expect(after.ctimeNs).toBe(before.ctimeNs);
      now = scanStartedAt + delay;
      const full = await attempt(directory);
      expect(counts.scans).toBe(round + 2);
      expect(full).not.toContain("The same processes have blocked it since");
      delays.push(delay);
      scanStartedAt = now;
      delay = Math.min(delay * 2, HOLDER_REFUSAL_MAX_DELAY_MS);
    }
    expect(delays.map((value) => value / 1000)).toEqual([
      15, 30, 60, 120, 240, 480, 600, 600,
    ]);
  });

  it("scans again at once when a blocking process exits", async ({ skip }) => {
    const directory = await target();
    const child = await startProcess({
      comm: "notagent",
      dumpable: false,
      inside: directory,
    });
    const pid = child.pid ?? 0;
    skip(!(await unreadable(pid)), "the kernel lets this user read it");
    let now = 1_000_000;
    useHolderRefusalClockForTests(() => now);
    const { counts, reader } = readerWatching(pid);
    useProcReaderForTests(reader);
    expect(await attempt(directory)).toContain("could not be established");
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    now += 1;
    expect(await attempt(directory)).toBe("removed");
    expect(counts.scans).toBe(2);
  });

  it("scans again at once when a blocking pid now belongs to a newer process", async ({
    skip,
  }) => {
    const directory = await target();
    const child = await startProcess({
      comm: "notagent",
      dumpable: false,
      inside: directory,
    });
    const pid = child.pid ?? 0;
    skip(!(await unreadable(pid)), "the kernel lets this user read it");
    let now = 1_000_000;
    useHolderRefusalClockForTests(() => now);
    let start = "100";
    useProcessStartReaderForTests(async (asked) =>
      asked === pid ? start : null,
    );
    const { counts, reader } = readerWatching(pid);
    useProcReaderForTests(reader);
    await attempt(directory);
    now += 1;
    await attempt(directory);
    expect(counts.scans).toBe(1);
    start = "200";
    now += 1;
    const again = await attempt(directory);
    expect(counts.scans).toBe(2);
    expect(again).not.toContain("The same processes have blocked it since");
  });
});

describe.skipIf(!runsHere)("a remembered refusal whose blocker changed", () => {
  it("scans again before the wait ends when a blocker becomes readable and leaves", async ({
    skip,
  }) => {
    const directory = await target();
    const child = await startProcess({
      comm: "notagent",
      dumpable: false,
      inside: directory,
    });
    const pid = child.pid ?? 0;
    skip(!(await unreadable(pid)), "the kernel lets this user read it");
    let now = 1_000_000;
    useHolderRefusalClockForTests(() => now);
    const { counts, reader } = readerWatching(pid);
    useProcReaderForTests(reader);
    expect(await attempt(directory)).toContain("could not be established");
    now += 1;
    expect(await attempt(directory)).toContain(
      "The same processes have blocked it since",
    );
    expect(counts.scans).toBe(1);
    const released = new Promise<void>((resolve) =>
      child.stdout?.once("data", () => resolve()),
    );
    child.kill("SIGUSR1");
    await released;
    expect(await unreadable(pid)).toBe(false);
    now += 1;
    expect(await attempt(directory)).toBe("removed");
    expect(counts.scans).toBe(2);
    expect(existsSync(directory)).toBe(false);
  });

  it("scans again before the wait ends when a blocker's credentials change", async ({
    skip,
  }) => {
    const directory = await target();
    const child = await startProcess({
      comm: "notagent",
      dumpable: false,
      inside: directory,
    });
    const pid = child.pid ?? 0;
    skip(!(await unreadable(pid)), "the kernel lets this user read it");
    let now = 1_000_000;
    useHolderRefusalClockForTests(() => now);
    let credentials = "1000,1000,1000,1000 0000000800000000";
    useProcessCredentialsReaderForTests(async (asked) =>
      asked === pid ? credentials : null,
    );
    const { counts, reader } = readerWatching(pid);
    useProcReaderForTests(reader);
    await attempt(directory);
    now += 1;
    await attempt(directory);
    expect(counts.scans).toBe(1);
    credentials = "1000,1000,1000,1000 0000000000000000";
    now += 1;
    const again = await attempt(directory);
    expect(counts.scans).toBe(2);
    expect(again).not.toContain("The same processes have blocked it since");
  });
});

describe("a removal refused without named processes", () => {
  it("never answers from a remembered refusal", async () => {
    const directory = await target();
    const scan = {
      status: "uncertain" as const,
      reason: "the process mount information is unreadable",
    };
    const results: string[] = [];
    for (let round = 0; round < 2; round += 1) {
      try {
        await removeDirectoryAfterHolderRecheck({
          directory,
          action: "remove",
          recursive: true,
          testWorktreeHolderScan: scan,
        });
        results.push("removed");
      } catch (error) {
        results.push((error as Error).message);
      }
    }
    for (const result of results) {
      expect(result).toContain("the process mount information is unreadable");
      expect(result).not.toContain("The same processes have blocked it since");
    }
  });
});
