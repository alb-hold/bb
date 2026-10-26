import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hostHoldScanIo,
  scanProcessesHoldingUnder,
  type HoldScanIo,
} from "../src/cwd-scan.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const denied = () => Object.assign(new Error("denied"), { code: "EACCES" });
const gone = () => Object.assign(new Error("gone"), { code: "ENOENT" });
const failed = () => Object.assign(new Error("io"), { code: "EIO" });
const dir = async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "bb-hold-scan-")));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  return base;
};

interface FakeThread {
  cwd?: string | Error;
  namespace?: string | Error;
}

interface FakeProcess {
  threads?: Record<string, FakeThread>;
  tasks?: string[] | Error;
  cwd?: string | Error;
  exe?: string | Error;
  fds?: string[] | Error;
  maps?: string | Error;
  namespace?: string | Error;
  root?: string | Error;
  uid?: number;
  comm?: string;
}

const OWN_NAMESPACE = "mnt:[4026531841]";

const ROOT_MOUNT_INFO = "1 0 8:1 / / rw - ext4 /dev/sda1 rw\n";

function mapsLine(path: string): string {
  return `7f0000000000-7f0000001000 r--p 00000000 08:01 1234                      ${path}`;
}

function fakeLinux(
  processes: Record<number, FakeProcess>,
  overrides: Partial<HoldScanIo> = {},
): HoldScanIo {
  const fact = <Value>(
    pid: number,
    pick: (process: FakeProcess) => Value | Error | undefined,
    fallback: Value,
  ): Promise<Value> => {
    const process = processes[pid];
    if (process === undefined) return Promise.reject(gone());
    const value = pick(process);
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value ?? fallback);
  };
  const threadFact = <Key extends keyof FakeThread>(
    pid: number,
    tid: string,
    key: Key,
    inherited: (process: FakeProcess) => FakeThread[Key],
    fallback: string,
  ): Promise<string> => {
    const process = processes[pid];
    if (process === undefined) return Promise.reject(gone());
    const own = process.threads?.[tid];
    const value =
      own !== undefined
        ? own[key]
        : tid === String(pid)
          ? inherited(process)
          : undefined;
    if (value instanceof Error) return Promise.reject(value);
    if (own === undefined && tid !== String(pid)) return Promise.reject(gone());
    return Promise.resolve(typeof value === "string" ? value : fallback);
  };
  return {
    platform: "linux",
    uid: 1000,
    selfPid: 1,
    listProcessIds: async () => Object.keys(processes),
    listTasks: (pid) =>
      fact(
        pid,
        (process) =>
          process.tasks ?? [
            String(pid),
            ...Object.keys(process.threads ?? {}).filter(
              (tid) => tid !== String(pid),
            ),
          ],
        [],
      ),
    readTaskCwd: (pid, tid) =>
      threadFact(pid, tid, "cwd", (process) => process.cwd, "/elsewhere"),
    readTaskNamespace: (pid, tid) =>
      threadFact(
        pid,
        tid,
        "namespace",
        (process) => process.namespace,
        OWN_NAMESPACE,
      ),
    readMountInfo: async () => ROOT_MOUNT_INFO,
    readCwd: (pid) => fact(pid, (process) => process.cwd, "/elsewhere"),
    effectiveUid: async (pid) => processes[pid]?.uid ?? 1000,
    readComm: async (pid) => processes[pid]?.comm ?? "node",
    runLsof: async () => {
      throw new Error("unused");
    },
    readExe: (pid) => fact(pid, (process) => process.exe, "/usr/bin/node"),
    listOpenFiles: (pid) => fact(pid, (process) => process.fds, []),
    readMaps: (pid) => fact(pid, (process) => process.maps, ""),
    readOwnMountNamespace: async () => OWN_NAMESPACE,
    readRoot: (pid) => fact(pid, (process) => process.root, "/"),
    runLsofOpenFiles: async () => {
      throw new Error("unused");
    },
    ...overrides,
  };
}

function reasonOf(scan: { status: string; reason?: string }): string {
  return scan.status === "unknown" ? (scan.reason ?? "") : "";
}

describe("scanProcessesHoldingUnder on Linux", () => {
  it("is clear when no process works in, runs from, has open or maps anything inside the directory", async () => {
    const base = await dir();
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeLinux({
        10: {
          cwd: "/elsewhere",
          fds: ["/var/log/x", "socket:[123]", "pipe:[9]"],
          maps: mapsLine("/usr/lib/libc.so.6"),
        },
      }),
    );
    expect(scan).toEqual({
      status: "clear",
      excludedOtherUsers: 0,
      unvouchedHelpers: [],
    });
  });

  it("is held through the working directory", async () => {
    const base = await dir();
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeLinux({ 10: { cwd: `${base}/sub` } }),
    );
    expect(scan).toMatchObject({
      status: "held",
      holders: [{ pid: 10, path: `${base}/sub`, through: "working-directory" }],
    });
  });

  it("is held through an open file although the working directory is elsewhere", async () => {
    const base = await dir();
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeLinux({
        10: { cwd: "/elsewhere", fds: ["/tmp/x", `${base}/attachment.png`] },
      }),
    );
    expect(scan).toMatchObject({
      status: "held",
      holders: [
        { pid: 10, path: `${base}/attachment.png`, through: "open-file" },
      ],
    });
  });

  it("is held through a deleted file that is still open inside the directory", async () => {
    const base = await dir();
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeLinux({ 10: { fds: [`${base}/a.db (deleted)`] } }),
    );
    expect(scan).toMatchObject({
      status: "held",
      holders: [{ pid: 10, through: "open-file" }],
    });
  });

  it("is held through the program it runs", async () => {
    const base = await dir();
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeLinux({ 10: { exe: `${base}/bin/server` } }),
    );
    expect(scan).toMatchObject({
      status: "held",
      holders: [{ pid: 10, path: `${base}/bin/server`, through: "program" }],
    });
  });

  it("is held through a file mapped into memory", async () => {
    const base = await dir();
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeLinux({
        10: {
          maps: `${mapsLine("/usr/lib/libc.so.6")}\n${mapsLine(`${base}/data/index with space.bin`)}\n`,
        },
      }),
    );
    expect(scan).toMatchObject({
      status: "held",
      holders: [
        {
          pid: 10,
          path: `${base}/data/index with space.bin`,
          through: "memory-map",
        },
      ],
    });
  });

  it("does not treat a sibling that only shares the directory name as a prefix as inside it", async () => {
    const base = await dir();
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeLinux({
        10: {
          cwd: `${base}-other`,
          exe: `${base}-other/run`,
          fds: [`${base}-other/file`],
          maps: mapsLine(`${base}-other/lib.so`),
        },
      }),
    );
    expect(scan.status).toBe("clear");
  });

  it("never holds on this process itself", async () => {
    const base = await dir();
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeLinux({ 1: { cwd: base, fds: [`${base}/x`] } }),
    );
    expect(scan.status).toBe("clear");
  });

  it("ignores a process that exits while its open files are read", async () => {
    const base = await dir();
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeLinux({ 10: { fds: gone() }, 11: { cwd: "/elsewhere" } }),
    );
    expect(scan.status).toBe("clear");
  });

  it.each([
    ["open files", { fds: denied() }],
    ["memory maps", { maps: denied() }],
    ["program", { exe: denied() }],
    ["working directory", { cwd: denied() }],
    ["root folder", { root: denied() }],
    ["mount namespace", { namespace: denied() }],
  ] as const)(
    "is unknown when the %s of a same-user process that is not a known helper cannot be read",
    async (what, process) => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({ 10: process }),
      );
      expect(scan.status).toBe("unknown");
      expect(reasonOf(scan)).toContain("process 10");
      expect(reasonOf(scan)).toContain(what);
    },
  );

  it("is unknown when the open files of a same-user process fail to read for any other reason", async () => {
    const base = await dir();
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeLinux({ 10: { fds: failed() } }),
    );
    expect(scan.status).toBe("unknown");
    expect(reasonOf(scan)).toContain("open files of process 10");
  });

  it("is clear, naming the helper once, when the unreadable same-user process is an allow-listed helper", async () => {
    const base = await dir();
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeLinux({ 10: { fds: denied(), maps: denied(), comm: "sshd" } }),
    );
    expect(scan).toEqual({
      status: "clear",
      excludedOtherUsers: 0,
      unvouchedHelpers: [{ pid: 10, comm: "sshd" }],
    });
  });

  it("excludes and records another user's process whose open files cannot be read", async () => {
    const base = await dir();
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeLinux({ 10: { fds: denied(), uid: 0 } }),
    );
    expect(scan).toEqual({
      status: "clear",
      excludedOtherUsers: 1,
      unvouchedHelpers: [],
      skippedOtherUsers: [{ pid: 10, uid: 0, errno: "EACCES" }],
    });
  });

  it("is unknown for a same-user process in another mount namespace, and excludes another user's", async () => {
    const base = await dir();
    const sandboxed = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeLinux({ 10: { namespace: "mnt:[4026532999]" } }),
    );
    expect(sandboxed.status).toBe("unknown");
    expect(reasonOf(sandboxed)).toContain("mount namespace");
    const foreign = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeLinux({ 10: { namespace: "mnt:[4026532999]", uid: 0 } }),
    );
    expect(foreign).toMatchObject({
      status: "clear",
      excludedOtherUsers: 1,
      skippedOtherUsers: [{ pid: 10, uid: 0, errno: "other-namespace" }],
    });
  });

  it("is unknown for a same-user process under a different root folder", async () => {
    const base = await dir();
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeLinux({ 10: { root: "/srv/chroot" } }),
    );
    expect(scan.status).toBe("unknown");
    expect(reasonOf(scan)).toContain("root folder");
  });

  it("is unknown, not held, when a process holds a file but another process cannot be vouched for", async () => {
    const base = await dir();
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeLinux({ 10: { fds: [`${base}/x`] }, 11: { fds: failed() } }),
    );
    expect(scan.status).toBe("unknown");
  });

  it("is unknown when the process list or this process's mount namespace cannot be read, on Windows, and for a symlinked target", async () => {
    const base = await dir();
    expect(
      (
        await scanProcessesHoldingUnder(
          { directories: [base] },
          fakeLinux(
            {},
            {
              listProcessIds: async () => {
                throw denied();
              },
            },
          ),
        )
      ).status,
    ).toBe("unknown");
    expect(
      (
        await scanProcessesHoldingUnder(
          { directories: [base] },
          fakeLinux(
            {},
            {
              readOwnMountNamespace: async () => {
                throw denied();
              },
            },
          ),
        )
      ).status,
    ).toBe("unknown");
    expect(
      (
        await scanProcessesHoldingUnder(
          { directories: [base] },
          { ...fakeLinux({}), platform: "win32" },
        )
      ).status,
    ).toBe("unknown");
    await mkdir(join(base, "real"));
    await symlink(join(base, "real"), join(base, "link"));
    expect(
      (
        await scanProcessesHoldingUnder(
          { directories: [join(base, "link")] },
          fakeLinux({}),
        )
      ).status,
    ).toBe("unknown");
  });

  describe("threads", () => {
    it("is held through the working directory of a worker thread while the main thread works elsewhere", async () => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({
          10: {
            cwd: "/elsewhere",
            threads: { "11": { cwd: `${base}/sub` } },
          },
        }),
      );
      expect(scan).toMatchObject({
        status: "held",
        holders: [
          { pid: 10, path: `${base}/sub`, through: "working-directory" },
        ],
      });
    });

    it("is unknown for a worker thread in another mount namespace of a same-user process, and excludes another user's", async () => {
      const base = await dir();
      const sandboxed = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({
          10: { threads: { "11": { namespace: "mnt:[4026532999]" } } },
        }),
      );
      expect(sandboxed.status).toBe("unknown");
      expect(reasonOf(sandboxed)).toContain("mount namespace");
      const foreign = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({
          10: { uid: 0, threads: { "11": { namespace: "mnt:[4026532999]" } } },
        }),
      );
      expect(foreign).toMatchObject({ status: "clear", excludedOtherUsers: 1 });
    });

    it("is unknown when the working directory of a worker thread cannot be read", async () => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({ 10: { threads: { "11": { cwd: denied() } } } }),
      );
      expect(scan.status).toBe("unknown");
      expect(reasonOf(scan)).toContain("working directory of process 10");
    });

    it("ignores a thread that exits while the threads are read", async () => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({ 10: { tasks: ["10", "12"] } }),
      );
      expect(scan.status).toBe("clear");
    });

    it("is unknown when the main thread has exited while other threads still run", async () => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({
          10: {
            cwd: gone(),
            root: gone(),
            tasks: ["10", "11"],
            threads: { "11": { cwd: "/elsewhere" } },
          },
        }),
      );
      expect(scan.status).toBe("unknown");
      expect(reasonOf(scan)).toContain("main thread of process 10");
    });

    it("is clear for a zombie with no other thread and for a process that vanished", async () => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({
          10: { cwd: gone(), root: gone(), tasks: ["10"] },
          11: { tasks: gone() },
        }),
      );
      expect(scan.status).toBe("clear");
    });
  });

  describe("a filesystem mounted more than once", () => {
    const mounts = (base: string) =>
      [
        "1 0 8:48 / / rw - ext4 /dev/sdd rw",
        "2 1 8:48 / /mnt/alias ro - ext4 /dev/sdd ro",
        "3 1 8:48 /tmp /srv/tmp rw - ext4 /dev/sdd rw",
        "4 1 8:48 /var /srv/var rw - ext4 /dev/sdd rw",
        "5 1 9:1 / /mnt/other rw - ext4 /dev/sde rw",
        "6 1 8:48 / /mnt/with\\040space ro - ext4 /dev/sdd ro",
        `7 1 0:50 / ${base}-unrelated rw - tmpfs tmpfs rw`,
      ].join("\n") + "\n";

    it.each([
      [
        "a second mount of the whole filesystem",
        (base: string) => `/mnt/alias${base}/sub`,
      ],
      [
        "a bind mount of an ancestor directory",
        (base: string) => `/srv/tmp${base.slice("/tmp".length)}/sub`,
      ],
      [
        "a mount point whose name holds an escaped space",
        (base: string) => `/mnt/with space${base}/sub`,
      ],
    ])("is held through %s", async (_label, aliasOf) => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux(
          { 10: { cwd: aliasOf(base) } },
          { readMountInfo: async () => mounts(base) },
        ),
      );
      expect(scan).toMatchObject({
        status: "held",
        holders: [{ pid: 10, through: "working-directory" }],
      });
    });

    it("does not treat a mount of another device, or of a sibling directory, as showing the directory", async () => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux(
          {
            10: { cwd: `/mnt/other${base}/sub` },
            11: { cwd: `/srv/var${base}/sub` },
          },
          { readMountInfo: async () => mounts(base) },
        ),
      );
      expect(scan.status).toBe("clear");
    });

    it("is held through the alias of a directory that itself sits under a bind mount", async () => {
      const scan = await scanProcessesHoldingUnder(
        { directories: [await dir()] },
        fakeLinux(
          { 10: { cwd: "/home/me/wt/sub" } },
          {
            readMountInfo: async () =>
              [
                "1 0 8:1 / / rw - ext4 /dev/sda1 rw",
                "2 1 8:1 /home/me /srv/me rw - ext4 /dev/sda1 rw",
              ].join("\n"),
          },
        ),
      );
      expect(scan.status).toBe("clear");
      const aliased = await scanProcessesHoldingUnder(
        { directories: ["/srv/me/wt"] },
        fakeLinux(
          { 10: { cwd: "/home/me/wt/sub" } },
          {
            readMountInfo: async () =>
              [
                "1 0 8:1 / / rw - ext4 /dev/sda1 rw",
                "2 1 8:1 /home/me /srv/me rw - ext4 /dev/sda1 rw",
              ].join("\n"),
          },
        ),
      );
      expect(aliased.status).toBe("held");
    });

    it.each([
      [
        "cannot be read",
        async () => {
          throw denied();
        },
      ],
      ["has a line that cannot be parsed", async () => "garbage\n"],
      ["is empty", async () => ""],
    ])("is unknown when the mount table %s", async (_label, readMountInfo) => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({}, { readMountInfo }),
      );
      expect(scan.status).toBe("unknown");
      expect(reasonOf(scan)).toContain("mount table");
    });
  });

  describe("memory map paths", () => {
    it.each([
      ["a space", "a b", "a\\040b"],
      ["a run of spaces", "a  b", "a\\040\\040b"],
      ["a tab", "a\tb", "a\\011b"],
      ["a backslash", "a\\b", "a\\134b"],
    ])(
      "finds a file mapped from a directory name holding %s",
      async (_label, name, escaped) => {
        const base = await dir();
        const directory = join(base, name);
        await mkdir(directory);
        const scan = await scanProcessesHoldingUnder(
          { directories: [directory] },
          fakeLinux({ 10: { maps: mapsLine(`${base}/${escaped}/index.bin`) } }),
        );
        expect(scan).toMatchObject({
          status: "held",
          holders: [
            { pid: 10, path: `${directory}/index.bin`, through: "memory-map" },
          ],
        });
      },
    );

    it("keeps the path of a deleted mapped file", async () => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({ 10: { maps: mapsLine(`${base}/x.bin (deleted)`) } }),
      );
      expect(scan.status).toBe("held");
    });

    it("ignores anonymous mappings and pseudo paths", async () => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({
          10: {
            maps: `7f0000000000-7f0000001000 rw-p 00000000 00:00 0 \n7ffd0000-7ffd1000 rw-p 00000000 00:00 0                          [stack]\n`,
          },
        }),
      );
      expect(scan.status).toBe("clear");
    });
  });

  it("is unknown when no directory is named", async () => {
    const scan = await scanProcessesHoldingUnder(
      { directories: [] },
      fakeLinux({ 10: { cwd: "/anywhere" } }),
    );
    expect(scan.status).toBe("unknown");
  });

  it.skipIf(process.platform !== "linux")(
    "finds a real process that holds a file open inside the directory while its working directory is elsewhere",
    async () => {
      const base = await dir();
      const elsewhere = await dir();
      const target = join(base, "attachment.bin");
      await writeFile(target, "x");
      const child = spawn(
        process.execPath,
        [
          "-e",
          "require('node:fs').openSync(process.argv[1], 'r'); setInterval(() => {}, 1000)",
          target,
        ],
        { cwd: elsewhere, stdio: "ignore" },
      );
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      cleanups.push(async () => {
        child.kill("SIGKILL");
        await exited;
      });
      await expect
        .poll(async () => {
          const scan = await scanProcessesHoldingUnder({
            directories: [base],
          });
          return scan.status === "held"
            ? scan.holders.map((holder) => holder.through)
            : scan.status;
        })
        .toEqual(["open-file"]);
      expect(child.exitCode).toBeNull();
    },
  );

  it.skipIf(process.platform !== "linux")(
    "is clear for a real process that opened a file inside the directory and closed it again",
    async () => {
      const base = await dir();
      const target = join(base, "attachment.bin");
      await writeFile(target, "x");
      const child = spawn(
        process.execPath,
        [
          "-e",
          "const fs = require('node:fs'); fs.closeSync(fs.openSync(process.argv[1], 'r')); process.stdout.write('closed\\n'); setInterval(() => {}, 1000)",
          target,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      cleanups.push(async () => {
        child.kill("SIGKILL");
        await exited;
      });
      await new Promise<void>((resolve) =>
        child.stdout.once("data", () => resolve()),
      );
      const scan = await scanProcessesHoldingUnder({ directories: [base] });
      expect(scan.status).toBe("clear");
    },
  );
});

describe("scanProcessesHoldingUnder on macOS, through ps and lsof -F pfn0", () => {
  const psLine = (pid: number, uid: number, comm: string) =>
    `${String(pid).padStart(6)} ${String(uid).padStart(5)} ${comm}\n`;
  const record = (pid: number, files: Record<string, string>) =>
    `p${pid}\0\n${Object.entries(files)
      .map(([fd, name]) => `f${fd}\0n${name}\0\n`)
      .join("")}`;

  function fakeMac(options: {
    ps: string[];
    lsof: string;
    uid?: number | null;
    code?: number;
    stderr?: string;
  }): HoldScanIo & { delays: number[]; psCalls: number; lsofCalls: number } {
    const delays: number[] = [];
    const state = { delays, psCalls: 0, lsofCalls: 0 };
    return {
      ...fakeLinux({}),
      platform: "darwin",
      uid: options.uid === undefined ? 501 : options.uid,
      selfPid: 1,
      runPs: async () => {
        const text =
          options.ps[Math.min(state.psCalls, options.ps.length - 1)] ?? "";
        state.psCalls += 1;
        return { code: 0, stdout: text, stderr: "" };
      },
      runLsofOpenFiles: async () => {
        state.lsofCalls += 1;
        return {
          code: options.code ?? 0,
          stdout: options.lsof,
          stderr: options.stderr ?? "",
        };
      },
      delay: async (ms) => {
        state.delays.push(ms);
      },
      get delays() {
        return state.delays;
      },
      get psCalls() {
        return state.psCalls;
      },
      get lsofCalls() {
        return state.lsofCalls;
      },
    };
  }

  it("is held through an open file although the working directory is elsewhere", async () => {
    const base = await dir();
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeMac({
        ps: [psLine(60, 501, "node")],
        lsof: record(60, {
          cwd: "/Users/me",
          "3": `${base}/attachment.png`,
        }),
      }),
    );
    expect(scan).toMatchObject({
      status: "held",
      holders: [
        { pid: 60, path: `${base}/attachment.png`, through: "open-file" },
      ],
    });
  });

  it.each([
    ["txt", "program"],
    ["mem", "memory-map"],
    ["cwd", "working-directory"],
  ] as const)(
    "reports a %s entry inside the directory as %s",
    async (fd, through) => {
      const base = await dir();
      const files =
        fd === "cwd"
          ? { cwd: `${base}/sub` }
          : { cwd: "/Users/me", [fd]: `${base}/lib` };
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeMac({ ps: [psLine(60, 501, "node")], lsof: record(60, files) }),
      );
      expect(scan).toMatchObject({
        status: "held",
        holders: [{ pid: 60, through }],
      });
    },
  );

  it("does not hold on a sibling that shares only a name prefix, or on a socket name", async () => {
    const base = await dir();
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeMac({
        ps: [psLine(60, 501, "node")],
        lsof: record(60, {
          cwd: "/Users/me",
          "3": `${base}-other/file`,
          "4": "*:8080",
        }),
      }),
    );
    expect(scan).toMatchObject({
      status: "clear",
      excludedOtherUsers: 0,
      unvouchedHelpers: [],
    });
  });

  it("is clear when every same-user process appears in the listing and none is inside", async () => {
    const base = await dir();
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeMac({
        ps: [
          psLine(60, 501, "node") +
            psLine(61, 501, "zsh") +
            psLine(2, 0, "launchd"),
        ],
        lsof:
          record(60, { cwd: "/Users/me" }) +
          record(61, { cwd: "/Users/me", "0": "/dev/ttys001" }),
      }),
    );
    expect(scan).toEqual({
      status: "clear",
      excludedOtherUsers: 1,
      unvouchedHelpers: [],
      skippedOtherUsers: [{ pid: 2, uid: 0, errno: "other-euid" }],
    });
  });

  it("is unknown when a same-user process is missing from the listing, is not a helper and is still alive on the second look", async () => {
    const base = await dir();
    const table =
      psLine(20, 501, "/Applications/Hardened.app/hardened-helper") +
      psLine(21, 501, "zsh");
    const io = fakeMac({
      ps: [table, table],
      lsof: record(21, { cwd: "/Users/me" }),
    });
    const scan = await scanProcessesHoldingUnder({ directories: [base] }, io);
    expect(scan.status).toBe("unknown");
    expect(reasonOf(scan)).toContain("process 20 (hardened-helper)");
    expect(io.delays).toEqual([200]);
    expect(io.psCalls).toBe(2);
  });

  it("is unknown for a process the listing shows files for but no working directory", async () => {
    const base = await dir();
    const table = psLine(20, 501, "node");
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeMac({ ps: [table, table], lsof: record(20, { "3": "/tmp/x" }) }),
    );
    expect(scan.status).toBe("unknown");
  });

  it("ignores a process that has exited by the second look, and reports a known helper without looking again", async () => {
    const base = await dir();
    const first =
      psLine(40, 501, "short-lived") +
      psLine(41, 501, "node") +
      psLine(50, 501, "/usr/bin/ssh-agent");
    const second =
      psLine(41, 501, "node") + psLine(50, 501, "/usr/bin/ssh-agent");
    const io = fakeMac({
      ps: [first, second],
      lsof: record(41, { cwd: "/Users/me" }),
    });
    const scan = await scanProcessesHoldingUnder({ directories: [base] }, io);
    expect(scan).toMatchObject({
      status: "clear",
      unvouchedHelpers: [{ pid: 50, comm: "ssh-agent" }],
    });
    expect(io.delays).toEqual([200]);
  });

  it("still reports a holder when another same-user process is invisible", async () => {
    const base = await dir();
    const table = psLine(20, 501, "hardened") + psLine(60, 501, "node");
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeMac({
        ps: [table, table],
        lsof: record(60, { cwd: "/Users/me", "3": `${base}/x` }),
      }),
    );
    expect(scan.status).toBe("held");
  });

  it.each([
    ["a directory holding a backslash", "back\\slash"],
    ["a directory holding a non-ASCII character", "café"],
    ["a directory holding a newline", "new\nline"],
  ])("is unknown, without running lsof, for %s", async (_label, name) => {
    const base = await dir();
    const odd = join(base, name);
    await mkdir(odd);
    const io = fakeMac({ ps: [psLine(60, 501, "node")], lsof: "" });
    const scan = await scanProcessesHoldingUnder({ directories: [odd] }, io);
    expect(scan.status).toBe("unknown");
    expect(io.lsofCalls).toBe(0);
  });

  it.each([
    ["exit code 2", { code: 2, stderr: "" }],
    ["exit 1 and an empty stderr", { code: 1, stderr: "" }],
    [
      "exit 0 and a warning on stderr",
      {
        code: 0,
        stderr: "lsof: WARNING: can't stat() fuse file system /Volumes/x",
      },
    ],
    ["exit 1 and a warning on stderr", { code: 1, stderr: "lsof: WARNING: x" }],
  ])("is unknown when lsof has %s", async (_label, outcome) => {
    const base = await dir();
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeMac({ ps: [psLine(60, 501, "node")], lsof: "", ...outcome }),
    );
    expect(scan.status).toBe("unknown");
  });

  it("is unknown when lsof or ps cannot run, when ps is unavailable and when the user is unknown", async () => {
    const base = await dir();
    const io = fakeMac({
      ps: [psLine(60, 501, "node")],
      lsof: record(60, { cwd: "/x" }),
    });
    expect(
      (
        await scanProcessesHoldingUnder(
          { directories: [base] },
          {
            ...io,
            runLsofOpenFiles: async () => {
              throw new Error("lsof timed out");
            },
          },
        )
      ).status,
    ).toBe("unknown");
    expect(
      (
        await scanProcessesHoldingUnder(
          { directories: [base] },
          { ...io, runPs: async () => ({ code: 1, stdout: "", stderr: "" }) },
        )
      ).status,
    ).toBe("unknown");
    const { runPs: _runPs, ...withoutPs } = io;
    expect(
      (await scanProcessesHoldingUnder({ directories: [base] }, withoutPs))
        .status,
    ).toBe("unknown");
    expect(
      (
        await scanProcessesHoldingUnder(
          { directories: [base] },
          fakeMac({ ps: [psLine(60, 501, "node")], lsof: "", uid: null }),
        )
      ).status,
    ).toBe("unknown");
  });

  it.skipIf(process.platform !== "linux")(
    "finds a real process's open file through the real lsof listing, with the macOS code path",
    async () => {
      const base = await dir();
      const elsewhere = await dir();
      const target = join(base, "attachment.bin");
      await writeFile(target, "x");
      const child = spawn(
        process.execPath,
        [
          "-e",
          "require('node:fs').openSync(process.argv[1], 'r'); setInterval(() => {}, 1000)",
          target,
        ],
        { cwd: elsewhere, stdio: "ignore" },
      );
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      cleanups.push(async () => {
        child.kill("SIGKILL");
        await exited;
      });
      const asMac: HoldScanIo = {
        ...hostHoldScanIo,
        platform: "darwin",
        runPs: async () => ({
          code: 0,
          stdout: psLine(child.pid ?? 0, hostHoldScanIo.uid ?? 0, "node"),
          stderr: "",
        }),
      };
      await expect
        .poll(async () => {
          const scan = await scanProcessesHoldingUnder(
            { directories: [base] },
            asMac,
          );
          return scan.status === "held"
            ? scan.holders.map((holder) => holder.through)
            : scan.status === "unknown"
              ? scan.reason
              : scan.status;
        })
        .toEqual(["open-file"]);
    },
  );
});
