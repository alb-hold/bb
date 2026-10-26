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
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hostHoldScanIo,
  mountsInsideDirectory,
  parseAclListing,
  parseCredentials,
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
  gids?: number[];
  parent?: number;
  nestedPidNamespace?: boolean;
  dacCapability?: boolean;
  processNamespace?: string | Error;
  argv?: string[];
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
    statPath: async () => ({ uid: 1000, gid: 1000, mode: 0o755 }),
    readAcl: async () => "none",
    readCredentials: async (pid) => {
      const process = processes[pid];
      if (process === undefined) {
        if (pid === 1)
          return {
            uid: 0,
            gids: [0],
            parentPid: 0,
            nestedPidNamespace: false,
            dacCapability: false,
          };
        throw gone();
      }
      const uid = process.uid ?? 1000;
      return {
        uid,
        gids: process.gids ?? [uid],
        parentPid: process.parent ?? 1,
        nestedPidNamespace: process.nestedPidNamespace ?? false,
        dacCapability: process.dacCapability ?? false,
      };
    },
    readProcessNamespace: (pid) =>
      fact(pid, (process) => process.processNamespace, OWN_NAMESPACE),
    runPsUser: async () => ({ code: 0, stdout: "nobody\n", stderr: "" }),
    readCmdline: (pid) =>
      fact(pid, (process) => process.argv, [processes[pid]?.comm ?? "node"]),
    runPsTree: async () => {
      throw new Error("unused");
    },
    runIdGroups: async () => {
      throw new Error("unused");
    },
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

  it("names the process, its user and the namespace that block a same-user result", async () => {
    const base = await dir();
    const namespaced = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeLinux({ 10: { namespace: "mnt:[4026532226]" } }),
    );
    expect(namespaced).toMatchObject({
      status: "unknown",
      code: "foreign-namespace",
      blocker: { pid: 10, uid: 1000, namespace: "mnt:[4026532226]" },
    });
    const rooted = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeLinux({ 10: { root: "/srv/chroot" } }),
    );
    expect(rooted).toMatchObject({
      blocker: { pid: 10, uid: 1000, namespace: "root:/srv/chroot" },
    });
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
            12: { cwd: `/srv/var${base.slice("/var".length)}/sub` },
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

    it("is held through a mount whose source is a subfolder of the directory, at the place it is mounted", async () => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux(
          { 10: { cwd: "/srv/sub/deeper" }, 11: { cwd: "/srv/elsewhere" } },
          {
            readMountInfo: async () =>
              [
                "1 0 8:48 / / rw - ext4 /dev/sdd rw",
                `2 1 8:48 ${base}/sub /srv/sub rw - ext4 /dev/sdd rw`,
                "3 1 8:48 /other /srv/elsewhere rw - ext4 /dev/sdd rw",
                "4 1 9:1 /anything /srv/foreign rw - ext4 /dev/sde rw",
              ].join("\n"),
          },
        ),
      );
      expect(scan).toMatchObject({
        status: "held",
        holders: [{ pid: 10, path: "/srv/sub/deeper" }],
      });
    });

    describe("mountsInsideDirectory", () => {
      const table = [
        "1 0 8:1 / / rw - ext4 /dev/sda1 rw",
        "2 1 0:50 / /data/work/cache rw - tmpfs tmpfs rw",
        "3 1 8:2 / /data/work/nfs rw - nfs4 server:/x rw",
        "4 1 8:1 /x /data/work rw - ext4 /dev/sda1 rw",
        "5 1 8:1 / /data/worker rw - ext4 /dev/sda1 rw",
        "6 1 0:51 / /data/work/with\\040space rw - tmpfs tmpfs rw",
      ].join("\n");

      it("lists every mount point below the directory and none beside it or at it", () => {
        expect(mountsInsideDirectory("/data/work", table)).toEqual([
          "/data/work/cache",
          "/data/work/nfs",
          "/data/work/with space",
        ]);
      });

      it("lists nothing for a directory with no mount below it, and null for a table it cannot parse", () => {
        expect(mountsInsideDirectory("/data/worker", table)).toEqual([]);
        expect(mountsInsideDirectory("/data/work", "garbage\n")).toBeNull();
      });
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
      ["a space", "a b", "a b"],
      ["a run of spaces", "a   b", "a   b"],
      ["a tab", "a\tb", "a\tb"],
      ["a newline, which the kernel prints as \\012", "a\nb", "a\\012b"],
      ["a backslash, which the kernel prints as \\134", "a\\b", "a\\134b"],
    ])(
      "finds a file mapped from a directory name holding %s",
      async (_label, name, printed) => {
        const base = await dir();
        const directory = join(base, name);
        await mkdir(directory);
        const scan = await scanProcessesHoldingUnder(
          { directories: [directory] },
          fakeLinux({ 10: { maps: mapsLine(`${base}/${printed}/index.bin`) } }),
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

  describe("processes of other users", () => {
    const stranger = { fds: denied(), uid: 1234 };
    const entry = (uid: number, gid: number, mode: number) => ({
      uid,
      gid,
      mode,
    });
    const statsOf = (
      stats: Record<string, { uid: number; gid: number; mode: number }>,
      acls: Record<string, "none" | "deny-only" | "allow" | Error> = {},
    ): Partial<HoldScanIo> => ({
      statPath: async (path) => {
        const known = stats[path];
        if (known === undefined) return entry(1000, 1000, 0o755);
        return known;
      },
      readAcl: async (path) => {
        const known = acls[path] ?? "none";
        if (known instanceof Error) throw known;
        return known;
      },
    });
    const codeOfScan = (scan: { status: string; code?: string }) =>
      scan.status === "unknown" ? scan.code : scan.status;

    it("excludes a root process and counts it, whatever the modes of the directories", async () => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({ 10: { fds: denied(), uid: 0 } }),
      );
      expect(scan).toMatchObject({
        status: "clear",
        excludedOtherUsers: 1,
        skippedOtherUsers: [{ pid: 10, uid: 0 }],
      });
    });

    it("is unknown for another non-root user's process when every folder on the way lets other users search", async () => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({ 10: stranger }),
      );
      expect(codeOfScan(scan)).toBe("other-user-reachable");
      expect(reasonOf(scan)).toContain("process 10 runs as user 1234");
    });

    it("is clear, and records the process, when the user is the owner of a folder on the way whose owner bits deny search", async () => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux(
          { 10: stranger },
          statsOf({ [dirname(base)]: entry(1234, 1234, 0o655) }),
        ),
      );
      expect(scan).toMatchObject({
        status: "clear",
        excludedOtherUsers: 1,
        skippedOtherUsers: [{ pid: 10, uid: 1234 }],
      });
    });

    it("is clear when a folder on the way belongs to a group the user is not in, and unknown when the user is in it", async () => {
      const base = await dir();
      const parent = dirname(base);
      const stats = statsOf({ [parent]: entry(1000, 50, 0o750) });
      const outside = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({ 10: stranger }, stats),
      );
      expect(outside.status).toBe("clear");
      const inside = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({ 10: { ...stranger, gids: [1234, 50] } }, stats),
      );
      expect(codeOfScan(inside)).toBe("other-user-reachable");
    });

    it("reads the group of a folder only against the groups of the process, and unions the groups of one user's processes", async () => {
      const base = await dir();
      const stats = statsOf({ [dirname(base)]: entry(1000, 50, 0o750) });
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux(
          {
            10: { ...stranger, gids: [1234, 50] },
            11: { ...stranger, gids: [1234] },
          },
          stats,
        ),
      );
      expect(codeOfScan(scan)).toBe("other-user-reachable");
    });

    it.each([
      [0o700, "clear"],
      [0o744, "clear"],
      [0o754, "clear"],
      [0o751, "unknown"],
      [0o755, "unknown"],
      [0o750, "clear"],
      [0o640, "clear"],
    ])(
      "treats mode %o of a folder owned by someone else, in a group the user is not in, as %s",
      async (mode, status) => {
        const base = await dir();
        const scan = await scanProcessesHoldingUnder(
          { directories: [base] },
          fakeLinux(
            { 10: stranger },
            statsOf({ [base]: entry(1000, 50, mode) }),
          ),
        );
        expect(scan.status).toBe(status);
      },
    );

    it("ignores a deny-only access control list, and is unknown for one that allows anything", async () => {
      const base = await dir();
      const parent = dirname(base);
      const stats = { [parent]: entry(1000, 50, 0o750) };
      const denyOnly = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({ 10: stranger }, statsOf(stats, { [parent]: "deny-only" })),
      );
      expect(denyOnly.status).toBe("clear");
      const allow = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({ 10: stranger }, statsOf(stats, { [parent]: "allow" })),
      );
      expect(codeOfScan(allow)).toBe("other-user-acl");
    });

    it("is unknown when an access control list or a mode cannot be read", async () => {
      const base = await dir();
      const parent = dirname(base);
      const unreadableAcl = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux(
          { 10: stranger },
          statsOf({ [parent]: entry(1000, 50, 0o750) }, { [parent]: failed() }),
        ),
      );
      expect(codeOfScan(unreadableAcl)).toBe("other-user-acl");
      const unreadableMode = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux(
          { 10: stranger },
          {
            statPath: async () => {
              throw denied();
            },
          },
        ),
      );
      expect(codeOfScan(unreadableMode)).toBe("other-user-acl");
    });

    it("is unknown when the folder is closed but another path to it, through a second mount, is not", async () => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux(
          { 10: stranger },
          {
            ...statsOf({ [base]: entry(1000, 50, 0o700) }),
            readMountInfo: async () =>
              [
                "1 0 8:48 / / rw - ext4 /dev/sdd rw",
                "2 1 8:48 / /mnt/alias ro - ext4 /dev/sdd ro",
              ].join("\n"),
          },
        ),
      );
      expect(codeOfScan(scan)).toBe("other-user-reachable");
    });

    it("is unknown when one of several other users can reach the folder", async () => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux(
          {
            10: { fds: denied(), uid: 1234 },
            11: { fds: denied(), uid: 4321, gids: [4321, 50] },
          },
          statsOf({ [dirname(base)]: entry(1000, 50, 0o750) }),
        ),
      );
      expect(codeOfScan(scan)).toBe("other-user-reachable");
      expect(reasonOf(scan)).toContain("user 4321");
    });

    it("is unknown for another user's process in a nested process namespace, however closed the folder is", async () => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux(
          { 10: { ...stranger, nestedPidNamespace: true } },
          statsOf({ [base]: entry(1000, 50, 0o700) }),
        ),
      );
      expect(codeOfScan(scan)).toBe("other-user-namespace");
      expect(reasonOf(scan)).toContain("another user, other namespace");
    });

    it("is unknown for another non-root user's process in another mount namespace or under another root, and excludes root's", async () => {
      const base = await dir();
      const closed = statsOf({ [base]: entry(1000, 50, 0o700) });
      const otherNamespace = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({ 10: { uid: 1234, namespace: "mnt:[4026532999]" } }, closed),
      );
      expect(codeOfScan(otherNamespace)).toBe("other-user-namespace");
      const otherRoot = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({ 10: { uid: 1234, root: "/srv/chroot" } }, closed),
      );
      expect(codeOfScan(otherRoot)).toBe("other-user-namespace");
      const root = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({ 10: { uid: 0, namespace: "mnt:[4026532999]" } }, closed),
      );
      expect(root).toMatchObject({ status: "clear", excludedOtherUsers: 1 });
    });

    it("is unknown when another user's process descends from a process of this user, and when that cannot be established", async () => {
      const base = await dir();
      const closed = statsOf({ [dirname(base)]: entry(1000, 50, 0o750) });
      const inherited = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux(
          {
            10: { ...stranger, parent: 20 },
            20: { uid: 0, parent: 30 },
            30: { uid: 1000 },
          },
          closed,
        ),
      );
      expect(codeOfScan(inherited)).toBe("other-user-descendant");
      const unreadable = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({ 10: { ...stranger, parent: 99 } }, closed),
      );
      expect(codeOfScan(unreadable)).toBe("other-user-descendant");
      const clean = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({ 10: { ...stranger, parent: 20 }, 20: { uid: 0 } }, closed),
      );
      expect(clean.status).toBe("clear");
    });

    it("is unknown when the mount namespace of another user's process cannot be read or is not ours, however closed the folder is", async () => {
      const base = await dir();
      const closed = statsOf({ [base]: entry(1000, 50, 0o700) });
      const unreadable = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({ 10: { ...stranger, processNamespace: denied() } }, closed),
      );
      expect(codeOfScan(unreadable)).toBe("other-user-namespace");
      expect(unreadable).toMatchObject({
        blocker: { pid: 10, uid: 1234, namespace: "unreadable" },
      });
      const different = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux(
          { 10: { ...stranger, processNamespace: "mnt:[4026532999]" } },
          closed,
        ),
      );
      expect(codeOfScan(different)).toBe("other-user-namespace");
      expect(different).toMatchObject({
        blocker: { pid: 10, uid: 1234, namespace: "mnt:[4026532999]" },
      });
      const same = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({ 10: stranger }, closed),
      );
      expect(same.status).toBe("clear");
    });

    it("is unknown for another user's process with a capability that bypasses search permission", async () => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux(
          { 10: { ...stranger, dacCapability: true } },
          statsOf({ [base]: entry(1000, 50, 0o700) }),
        ),
      );
      expect(codeOfScan(scan)).toBe("other-user-capability");
    });

    it("is unknown when the groups of another user's process cannot be read", async () => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux(
          { 10: stranger },
          {
            readCredentials: async () => {
              throw denied();
            },
          },
        ),
      );
      expect(codeOfScan(scan)).toBe("other-user-groups");
    });
  });

  describe("allow-listed session helpers", () => {
    it("are vouched for only when the command line names the same program", async () => {
      const base = await dir();
      const genuine = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({
          10: {
            fds: denied(),
            comm: "sshd",
            argv: ["sshd: alex [priv]"],
          },
          11: {
            fds: denied(),
            comm: "systemd",
            argv: ["/usr/lib/systemd/systemd", "--user"],
          },
        }),
      );
      expect(genuine).toMatchObject({
        status: "clear",
        unvouchedHelpers: [
          { pid: 10, comm: "sshd" },
          { pid: 11, comm: "systemd" },
        ],
      });
      const spoofed = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux({
          10: { fds: denied(), comm: "systemd", argv: ["/tmp/evil/miner"] },
        }),
      );
      expect(spoofed.status).toBe("unknown");
      const unreadable = await scanProcessesHoldingUnder(
        { directories: [base] },
        fakeLinux(
          { 10: { fds: denied(), comm: "sshd" } },
          {
            readCmdline: async () => {
              throw denied();
            },
          },
        ),
      );
      expect(unreadable.status).toBe("unknown");
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

describe("the code of an unknown result", () => {
  const psLine = (pid: number, uid: number, comm: string) =>
    `${String(pid).padStart(6)} ${String(uid).padStart(5)} ${comm}\n`;
  const mac = (
    lsof: { code: number; stdout: string; stderr: string },
    ps: string,
  ): HoldScanIo => ({
    ...fakeLinux({}),
    platform: "darwin",
    uid: 501,
    runPs: async () => ({ code: 0, stdout: ps, stderr: "" }),
    runLsofOpenFiles: async () => lsof,
    delay: async () => undefined,
  });
  const ok = { code: 0, stdout: "", stderr: "" };

  it.each([
    [
      "no-directory",
      async () => scanProcessesHoldingUnder({ directories: [] }, fakeLinux({})),
    ],
    [
      "unsupported-platform",
      async (base: string) =>
        scanProcessesHoldingUnder(
          { directories: [base] },
          { ...fakeLinux({}), platform: "win32" },
        ),
    ],
    [
      "symlinked-directory",
      async (base: string) => {
        await mkdir(join(base, "real"));
        await symlink(join(base, "real"), join(base, "link"));
        return scanProcessesHoldingUnder(
          { directories: [join(base, "link")] },
          fakeLinux({}),
        );
      },
    ],
    [
      "process-list-unreadable",
      async (base: string) =>
        scanProcessesHoldingUnder(
          { directories: [base] },
          fakeLinux(
            {},
            {
              listProcessIds: async () => {
                throw denied();
              },
            },
          ),
        ),
    ],
    [
      "process-list-unreadable",
      async (base: string) =>
        scanProcessesHoldingUnder(
          { directories: [base] },
          {
            ...mac(ok, ""),
            runPs: async () => ({ code: 1, stdout: "", stderr: "" }),
          },
        ),
    ],
    [
      "lsof-failed",
      async (base: string) =>
        scanProcessesHoldingUnder(
          { directories: [base] },
          mac({ code: 2, stdout: "", stderr: "" }, ""),
        ),
    ],
    [
      "mount-table",
      async (base: string) =>
        scanProcessesHoldingUnder(
          { directories: [base] },
          fakeLinux(
            {},
            {
              readMountInfo: async () => {
                throw denied();
              },
            },
          ),
        ),
    ],
    [
      "foreign-namespace",
      async (base: string) =>
        scanProcessesHoldingUnder(
          { directories: [base] },
          fakeLinux({ 10: { namespace: "mnt:[4026532999]" } }),
        ),
    ],
    [
      "main-thread-exited",
      async (base: string) =>
        scanProcessesHoldingUnder(
          { directories: [base] },
          fakeLinux({
            10: { root: gone(), tasks: ["10", "11"], threads: { "11": {} } },
          }),
        ),
    ],
    [
      "unreadable-same-user",
      async (base: string) =>
        scanProcessesHoldingUnder(
          { directories: [base] },
          fakeLinux({ 10: { fds: denied() } }),
        ),
    ],
    [
      "invisible-process",
      async (base: string) => {
        const table = psLine(20, 501, "hardened");
        return scanProcessesHoldingUnder(
          { directories: [base] },
          mac(ok, table),
        );
      },
    ],
    [
      "escaped-directory",
      async (base: string) => {
        const odd = join(base, "back\\slash");
        await mkdir(odd);
        return scanProcessesHoldingUnder({ directories: [odd] }, mac(ok, ""));
      },
    ],
    [
      "other-user-reachable",
      async (base: string) =>
        scanProcessesHoldingUnder(
          { directories: [base] },
          fakeLinux({ 10: { fds: denied(), uid: 1234 } }),
        ),
    ],
    [
      "other-user-namespace",
      async (base: string) =>
        scanProcessesHoldingUnder(
          { directories: [base] },
          fakeLinux({
            10: { fds: denied(), uid: 1234, nestedPidNamespace: true },
          }),
        ),
    ],
    [
      "other-user-descendant",
      async (base: string) =>
        scanProcessesHoldingUnder(
          { directories: [base] },
          fakeLinux({
            10: { fds: denied(), uid: 1234, parent: 20 },
            20: { uid: 1000 },
          }),
        ),
    ],
    [
      "other-user-acl",
      async (base: string) =>
        scanProcessesHoldingUnder(
          { directories: [base] },
          fakeLinux(
            { 10: { fds: denied(), uid: 1234 } },
            { readAcl: async () => "allow" },
          ),
        ),
    ],
    [
      "other-user-capability",
      async (base: string) =>
        scanProcessesHoldingUnder(
          { directories: [base] },
          fakeLinux({
            10: { fds: denied(), uid: 1234, dacCapability: true },
          }),
        ),
    ],
    [
      "other-user-groups",
      async (base: string) =>
        scanProcessesHoldingUnder(
          { directories: [base] },
          fakeLinux(
            { 10: { fds: denied(), uid: 1234 } },
            {
              readCredentials: async () => {
                throw denied();
              },
            },
          ),
        ),
    ],
  ])("is %s", async (code, run) => {
    const scan = await run(await dir());
    expect(scan.status).toBe("unknown");
    expect(scan.status === "unknown" ? scan.code : "").toBe(code);
  });
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

  describe("another user's process", () => {
    const home = (base: string) => dirname(base);
    const staffHome = (base: string) => async (path: string) =>
      path === home(base)
        ? { uid: 501, gid: 20, mode: 0o40750 }
        : { uid: 501, gid: 20, mode: 0o755 };
    const table =
      psLine(70, 501, "node") +
      psLine(71, 248, "_distnoted") +
      psLine(2, 0, "launchd");
    const lsof = record(70, { cwd: "/Users/me" });
    const strangerSetup = (
      base: string,
      overrides: Partial<HoldScanIo> = {},
      tree = "     1     0     0\n    70     1   501\n    71     1   248\n     2     1     0\n",
      groups = "248 12\n",
    ): HoldScanIo => ({
      ...fakeMac({ ps: [table], lsof }),
      statPath: staffHome(base),
      runPsTree: async () => ({ code: 0, stdout: tree, stderr: "" }),
      runIdGroups: async () => ({ code: 0, stdout: groups, stderr: "" }),
      ...overrides,
    });

    it("is clear when the home folder is closed to a user outside its group, and counts the process", async () => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        strangerSetup(base),
      );
      expect(scan).toMatchObject({ status: "clear", excludedOtherUsers: 2 });
    });

    it("is unknown when the user is in the group of the home folder, and when the folder is open to everyone", async () => {
      const base = await dir();
      const member = await scanProcessesHoldingUnder(
        { directories: [base] },
        strangerSetup(base, {}, undefined, "248 20\n"),
      );
      expect(member.status === "unknown" ? member.code : "").toBe(
        "other-user-reachable",
      );
      expect(reasonOf(member)).toContain("process 71 runs as user 248");
      const open = await scanProcessesHoldingUnder(
        { directories: [base] },
        strangerSetup(base, {
          statPath: async () => ({ uid: 501, gid: 20, mode: 0o755 }),
        }),
      );
      expect(open.status).toBe("unknown");
    });

    it("is unknown when an ancestor of the process is a process of this user", async () => {
      const base = await dir();
      const scan = await scanProcessesHoldingUnder(
        { directories: [base] },
        strangerSetup(
          base,
          {},
          "     1     0     0\n    70     1   501\n    71    70   248\n     2     1     0\n",
        ),
      );
      expect(scan.status === "unknown" ? scan.code : "").toBe(
        "other-user-descendant",
      );
    });

    it("treats a user with a negative id like any other non-root user, and finds its groups by name", async () => {
      const base = await dir();
      const withNobody =
        psLine(70, 501, "node") +
        psLine(72, -2, "dhcp6d") +
        psLine(2, 0, "launchd");
      const tree =
        "     1     0     0\n    70     1   501\n    72     1    -2\n     2     1     0\n";
      const names: string[] = [];
      const setup = (overrides: Partial<HoldScanIo> = {}): HoldScanIo => ({
        ...strangerSetup(base, {}, tree),
        ...fakeMac({ ps: [withNobody], lsof }),
        statPath: staffHome(base),
        runPsTree: async () => ({ code: 0, stdout: tree, stderr: "" }),
        runPsUser: async () => ({ code: 0, stdout: "nobody\n", stderr: "" }),
        runIdGroups: async (user) => {
          names.push(String(user));
          return { code: 0, stdout: "4294967294\n", stderr: "" };
        },
        ...overrides,
      });
      const closed = await scanProcessesHoldingUnder(
        { directories: [base] },
        setup(),
      );
      expect(closed).toMatchObject({ status: "clear", excludedOtherUsers: 2 });
      expect(names).toEqual(["nobody"]);
      const open = await scanProcessesHoldingUnder(
        { directories: [base] },
        setup({ statPath: async () => ({ uid: 501, gid: 20, mode: 0o755 }) }),
      );
      expect(open.status === "unknown" ? open.code : "").toBe(
        "other-user-reachable",
      );
      const nameless = await scanProcessesHoldingUnder(
        { directories: [base] },
        setup({ runPsUser: async () => ({ code: 1, stdout: "", stderr: "" }) }),
      );
      expect(nameless.status === "unknown" ? nameless.code : "").toBe(
        "other-user-groups",
      );
    });

    it("is unknown when a process or its parent is missing from the process tree", async () => {
      const base = await dir();
      const missingParent = await scanProcessesHoldingUnder(
        { directories: [base] },
        strangerSetup(
          base,
          {},
          "     1     0     0\n    70     1   501\n    71    99   248\n     2     1     0\n",
        ),
      );
      expect(missingParent.status === "unknown" ? missingParent.code : "").toBe(
        "other-user-descendant",
      );
      const missingSelf = await scanProcessesHoldingUnder(
        { directories: [base] },
        strangerSetup(
          base,
          {},
          "     1     0     0\n    70     1   501\n     2     1     0\n",
        ),
      );
      expect(missingSelf.status === "unknown" ? missingSelf.code : "").toBe(
        "other-user-descendant",
      );
    });

    it("is unknown when the process tree, the groups or an access control list cannot be read", async () => {
      const base = await dir();
      const codes = [];
      for (const overrides of [
        { runPsTree: async () => ({ code: 1, stdout: "", stderr: "" }) },
        { runIdGroups: async () => ({ code: 1, stdout: "", stderr: "" }) },
        {
          runIdGroups: async () => ({ code: 0, stdout: "x y", stderr: "" }),
        },
        {
          readAcl: async () => {
            throw failed();
          },
        },
        { readAcl: async () => "allow" as const },
      ] satisfies Partial<HoldScanIo>[]) {
        const scan = await scanProcessesHoldingUnder(
          { directories: [base] },
          strangerSetup(base, overrides),
        );
        codes.push(scan.status === "unknown" ? scan.code : scan.status);
      }
      expect(codes).toEqual([
        "other-user-descendant",
        "other-user-groups",
        "other-user-groups",
        "other-user-acl",
        "other-user-acl",
      ]);
    });
  });

  it("excludes root's processes on macOS without asking about the modes", async () => {
    const base = await dir();
    const scan = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeMac({
        ps: [psLine(70, 501, "node") + psLine(2, 0, "launchd")],
        lsof: record(70, { cwd: "/Users/me" }),
      }),
    );
    expect(scan).toMatchObject({ status: "clear", excludedOtherUsers: 1 });
  });

  it("needs lsof to exit 0, because the listing of the current user's own processes is never empty", async () => {
    const base = await dir();
    const others = psLine(2, 0, "launchd");
    expect(
      (
        await scanProcessesHoldingUnder(
          { directories: [base] },
          fakeMac({ ps: [others], lsof: "", code: 0 }),
        )
      ).status,
    ).toBe("clear");
    const partial = await scanProcessesHoldingUnder(
      { directories: [base] },
      fakeMac({ ps: [others], lsof: "", code: 1 }),
    );
    expect(partial.status).toBe("unknown");
    expect(reasonOf(partial)).toContain("lsof exited with code 1");
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

describe("the boundary parsers", () => {
  const status = [
    "Name:\tsleep",
    "Uid:\t100069\t100069\t100069\t100069",
    "Gid:\t100069\t100070\t100069\t100069",
    "Groups:\t100071 100072 ",
    "NSpid:\t4242\t1",
    "PPid:\t4200",
    "CapEff:\t0000000000000000",
    "",
  ].join("\n");

  it("reads the effective user, the effective group with the supplementary groups, the parent and the nesting from a status file", () => {
    expect(parseCredentials(status)).toEqual({
      uid: 100069,
      gids: [100070, 100071, 100072],
      parentPid: 4200,
      nestedPidNamespace: true,
      dacCapability: false,
    });
    expect(
      parseCredentials(
        status
          .replace("NSpid:\t4242\t1", "NSpid:\t4242")
          .replace("Groups:\t100071 100072 \n", "Groups:\t\n"),
      ),
    ).toMatchObject({ gids: [100070], nestedPidNamespace: false });
    expect(
      parseCredentials(status.replace("0000000000000000", "0000000000000004")),
    ).toMatchObject({ dacCapability: true });
    expect(
      parseCredentials(status.replace("0000000000000000", "0000000000000002")),
    ).toMatchObject({ dacCapability: true });
    expect(
      parseCredentials(status.replace("0000000000000000", "0000000000000001")),
    ).toMatchObject({ dacCapability: false });
    expect(() =>
      parseCredentials(status.replace(/Groups:.*\n/u, "")),
    ).toThrow();
    expect(() =>
      parseCredentials(status.replace(/CapEff:.*\n/u, "")),
    ).toThrow();
    expect(() => parseCredentials("Name:\tx\n")).toThrow();
    expect(() =>
      parseCredentials(status.replace("PPid:\t4200\n", "")),
    ).toThrow();
  });

  it("reads an access control list flag on Linux and the entries on macOS, and refuses a listing it cannot parse", () => {
    const plain = "drwxr-x--- 5 me staff 160 Oct 26 10:00 /x";
    const flagged = "drwxr-x---+ 5 me staff 160 Oct 26 10:00 /x";
    expect(parseAclListing(plain, "linux")).toBe("none");
    expect(parseAclListing(flagged, "linux")).toBe("allow");
    expect(
      parseAclListing("drwxr-xr-x@ 5 me staff 160 Oct 26 /x", "darwin"),
    ).toBe("none");
    expect(
      parseAclListing(`${flagged}\n 0: group:everyone deny delete`, "darwin"),
    ).toBe("deny-only");
    expect(
      parseAclListing(
        `${flagged}\n 0: group:everyone deny delete\n 1: user:bob allow search`,
        "darwin",
      ),
    ).toBe("allow");
    const xattr = "drwx------@ 5 me staff 160 Oct 26 10:00 /x";
    expect(
      parseAclListing(`${xattr}\n 0: user:nobody allow search`, "darwin"),
    ).toBe("allow");
    expect(
      parseAclListing(`${xattr}\n 0: group:everyone deny delete`, "darwin"),
    ).toBe("deny-only");
    expect(
      parseAclListing(
        `${flagged}\n 0: user:john smith inherited allow list,search`,
        "darwin",
      ),
    ).toBe("allow");
    expect(
      parseAclListing(
        `${flagged}\n 0: group:a deny b inherited deny delete`,
        "darwin",
      ),
    ).toBe("deny-only");
    expect(() => parseAclListing(flagged, "darwin")).toThrow();
    expect(() => parseAclListing(`${flagged}\n nonsense`, "darwin")).toThrow();
    expect(() => parseAclListing("total 0", "linux")).toThrow();
  });

  it.skipIf(process.platform !== "linux")(
    "the host io reads the credentials of a real process and the access control list of a real folder",
    async () => {
      const credentials = await hostHoldScanIo.readCredentials(process.pid);
      expect(credentials.uid).toBe(process.geteuid?.());
      expect(credentials.gids).toContain(process.getegid?.());
      expect(credentials.parentPid).toBe(process.ppid);
      expect(["none", "deny-only", "allow"]).toContain(
        await hostHoldScanIo.readAcl(await dir()),
      );
      const cmdline = await hostHoldScanIo.readCmdline(process.pid);
      expect(cmdline[0]).toBe(process.execPath);
    },
  );
});
