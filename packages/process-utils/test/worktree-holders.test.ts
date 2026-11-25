import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeHolderScan,
  hostProc,
  procReadIsSynchronous,
  scanLinux,
  type ProcReader,
  mapLsofError,
  scanWorktreeHolders,
} from "../src/worktree-holders.js";

const roots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
const originalNodeEnv = process.env.NODE_ENV;
const originalHolderScan = process.env.BB_TEST_WORKTREE_HOLDER_SCAN;

describe("mapLsofError", () => {
  it.each([
    [
      Object.assign(new Error("timed out"), {
        killed: true,
        signal: "SIGTERM",
      }),
      { failure: "timeout", signal: "SIGTERM" },
    ],
    [
      Object.assign(new Error("buffer exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      }),
      { failure: "maxBuffer", signal: null },
    ],
    [
      Object.assign(new Error("spawn failed"), { code: "ENOENT" }),
      { failure: "spawn", signal: null },
    ],
    [
      Object.assign(new Error("terminated"), { code: null, signal: "SIGTERM" }),
      { failure: "signal", signal: "SIGTERM" },
    ],
  ] as const)("classifies %s correctly", (error, expected) => {
    expect(
      mapLsofError(error, "stdout", "first stderr line\nsecond line"),
    ).toMatchObject({
      ...expected,
      code: null,
      stdout: "stdout",
      stderr: "first stderr line\nsecond line",
      spawnFailed: true,
    });
  });
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (child.exitCode === null && child.signalCode === null)
      await once(child, "close");
  }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalHolderScan === undefined)
    delete process.env.BB_TEST_WORKTREE_HOLDER_SCAN;
  else process.env.BB_TEST_WORKTREE_HOLDER_SCAN = originalHolderScan;
});

describe("scanWorktreeHolders", () => {
  it.skipIf(process.platform !== "linux")(
    "does not let the test environment override a live child holder",
    async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "bb-worktree-holder-env-"),
      );
      roots.push(directory);
      const child = spawn("sleep", ["30"], {
        cwd: directory,
        stdio: "ignore",
      });
      children.push(child);
      await once(child, "spawn");
      process.env.NODE_ENV = "test";
      process.env.BB_TEST_WORKTREE_HOLDER_SCAN = JSON.stringify({
        status: "clear",
      });

      const scan = await scanWorktreeHolders(directory);

      expect(scan.status).not.toBe("clear");
      expect(scan).toMatchObject({
        status: "held",
        holders: [expect.objectContaining({ pid: child.pid })],
      });
    },
  );
});

describe("foreign process mount evidence", () => {
  it.each([
    ["bind mount root", "/work/tree", "8:48", "mnt:[2]", "uncertain"],
    [
      "nested bind mount root",
      "/work/tree/sub",
      "8:48",
      "mnt:[2]",
      "uncertain",
    ],
    ["filesystem root mount", "/", "8:48", "mnt:[2]", "uncertain"],
    [
      "escaped mount root",
      "/work/tree\\040space/sub",
      "8:48",
      "mnt:[2]",
      "uncertain",
      "/work/tree space",
    ],
    ["unreadable container mounts", null, null, "mnt:[2]", "uncertain"],
    [
      "unrelated readable container mounts",
      "/data",
      "8:48",
      "mnt:[2]",
      "uncertain",
    ],
    [
      "non-canonical unrelated container",
      "/data",
      "8:48",
      "mnt:[2]",
      "uncertain",
      "/work/tree",
      "different",
    ],
    [
      "unresolvable unrelated container",
      "/data",
      "8:48",
      "mnt:[2]",
      "uncertain",
      "/work/tree",
      "throws",
    ],
    ["path prefix sibling", "/work/tree-other", "8:48", "mnt:[2]", "uncertain"],
    ["same namespace unreadable mounts", null, null, "mnt:[1]", "uncertain"],
    ["ancestor mount", "/work", "8:48", "mnt:[2]", "uncertain"],
    ["different filesystem", "/", "0:95", "mnt:[2]", "uncertain"],
    ["malformed mountinfo", "malformed", "8:48", "mnt:[2]", "uncertain"],
  ] as const)(
    "classifies %s",
    async (
      _name,
      mountRoot,
      source,
      namespace,
      expected,
      directory: string = "/work/tree",
      resolution: string = "equal",
    ) => {
      const denied = () => {
        throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
      };
      const proc: ProcReader = {
        ...hostProc,
        realpath: async () => {
          if (resolution === "throws") return denied();
          return resolution === "different" ? "/data/tree" : directory;
        },
        readdir: async () => ["101"],
        readlink: async (target) => {
          if (target === "/proc/self/ns/mnt") return "mnt:[1]";
          if (target === "/proc/self/root") return "/";
          if (target === "/proc/101/ns/mnt") return namespace;
          return denied();
        },
        readFile: async (target) => {
          if (target === "/proc/self/status")
            return "NSpid:\t4242\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n";
          if (target === "/proc/self/mountinfo")
            return "25 1 8:48 / / rw - ext4 /dev/sda rw\n26 20 0:5 / /proc rw - proc proc rw\n";
          if (target === "/proc/101/status")
            return "State:\tS (sleeping)\nPPid:\t1\nUid:\t107473\t107473\t107473\t107473\nGid:\t107473\t107473\t107473\t107473\n";
          if (target === "/proc/101/cmdline") return "java\0neo4j\0";
          if (target === "/proc/101/mountinfo" && mountRoot !== null)
            return `30 20 ${source} ${mountRoot} /container/work rw - ext4 /dev/sda rw\n`;
          return denied();
        },
      };
      expect(await scanLinux(directory, proc, 4242)).toMatchObject({
        status: expected,
      });
    },
  );
});

describe("mapped files without open descriptors", () => {
  it.each(
    [1000, 107473].flatMap((uid) =>
      [
        ["/work/tree  space/file", "held"],
        ["/work/tree/file (deleted)", "held"],
        ["/work/tree\\040space/file", "held"],
        ["/outside/file", "clear"],
        [null, uid === 1000 ? "unknown" : "uncertain"],
      ].map(([mapped, expected]) => [uid, mapped, expected] as const),
    ),
  )("checks uid %s mapping %s", async (uid, mapped, expected) => {
    const denied = (): never => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    const proc: ProcReader = {
      ...hostProc,
      subdirectories: async () => [],
      lstatId: async () => "1:100",
      statId: async () => "9:200",
      realpath: async (directory) => directory,
      readdir: async (target) =>
        target === "/proc" || target.endsWith("/task") ? ["101"] : [],
      readlink: async (target) =>
        target.endsWith("/ns/mnt")
          ? "mnt:[1]"
          : target.endsWith("/root")
            ? "/"
            : "/outside/file",
      readFile: async (target) => {
        if (target === "/proc/self/status")
          return "NSpid:\t4242\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n";
        if (target.endsWith("/status"))
          return `State:\tS\nPPid:\t1\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t1000\t1000\t1000\t1000\n`;
        if (target.endsWith("/mountinfo"))
          return "25 1 8:48 / / rw - ext4 /dev/sda rw\n";
        if (target.endsWith("/maps"))
          return mapped === null
            ? denied()
            : `1000-2000 r--p 00000000 08:30 12 ${mapped}\n`;
        if (target.endsWith("/comm")) return "java\n";
        if (target.endsWith("/cmdline")) return "java\0";
        return denied();
      },
    };
    expect(
      await scanLinux(
        mapped?.includes("040space")
          ? "/work/tree space"
          : mapped?.includes("  space")
            ? "/work/tree  space"
            : "/work/tree",
        proc,
        4242,
      ),
      String(mapped),
    ).toMatchObject({ status: expected });
  });
});

function mountAliasProc(
  directory: string,
  kind: string,
  uid: number,
): ProcReader {
  const base = "/proc/101";
  const different = kind.startsWith("different") || kind === "cwd identity";
  const namespace = different ? "mnt:[2]" : "mnt:[1]";
  const cwd =
    kind === "cwd alias" || kind === "subdirectory alias"
      ? "/alias/child"
      : kind === "ancestor alias"
        ? `/alias/${directory.split("/").at(-1)}/child`
        : different
          ? "/app"
          : "/outside";
  const denied = (): never => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  };
  const encode = (value: string) =>
    value.replaceAll("\\", "\\134").replaceAll(" ", "\\040");
  const aliasRoot =
    kind === "subdirectory alias"
      ? directory + "/sub"
      : kind === "ancestor alias"
        ? directory.slice(0, directory.lastIndexOf("/")) || "/"
        : directory;
  const fd = kind.startsWith("fd ");
  const mapped = kind.startsWith("map ");
  return {
    ...hostProc,
    realpath: async (value) => value,
    mountId: async (value) => (value === directory ? "25" : denied()),
    subdirectories: async (value) => {
      if (kind === "tree unreadable") return denied();
      return value === directory ? ["sub"] : [];
    },
    lstatId: async (value) => {
      if (value === directory + "/sub") return "1:101";
      if (
        !value.startsWith("/proc/") &&
        value.startsWith(directory.slice(0, directory.lastIndexOf("/")) + "/")
      )
        return "1:100";
      return "9:200";
    },
    statId: async (value) => {
      if (
        (kind === "cwd stat failure" && value === base + "/cwd") ||
        (kind === "fd stat failure" && value === base + "/fd/3") ||
        (kind === "map stat failure" && value === base + "/map_files/1000-2000")
      )
        return denied();
      if (
        (kind === "cwd identity" && value === base + "/cwd") ||
        (kind === "fd identity" && value === base + "/fd/3") ||
        (kind === "map identity" && value === base + "/map_files/1000-2000")
      )
        return "1:101";
      return value === directory ? "1:100" : "9:200";
    },
    readdir: async (value) => {
      if (value === "/proc" || value === base + "/task") return ["101"];
      if (value === base + "/fd") return fd ? ["3"] : [];
      if (value === base + "/map_files") return mapped ? ["1000-2000"] : [];
      return [];
    },
    readlink: async (value) => {
      if (value === "/proc/self/ns/mnt") return "mnt:[1]";
      if (value.endsWith("/ns/mnt")) return namespace;
      if (value.endsWith("/root")) return "/";
      if (value.endsWith("/cwd")) return cwd;
      if (value.endsWith("/exe"))
        return kind === "exe alias" ? "/alias/program" : "/usr/bin/java";
      if (value === base + "/fd/3")
        return kind === "fd alias" ? "/alias/file" : "/outside/file";
      if (value.includes("/map_files/"))
        return kind === "map alias" ? "/alias/file" : "/outside/file";
      return denied();
    },
    readFile: async (value) => {
      if (value === "/proc/self/status")
        return "NSpid:\t4242\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n";
      if (value === base + "/status")
        return `State:\tS\nPPid:\t1\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t1000\t1000\t1000\t1000\n`;
      if (value === "/proc/self/mountinfo") {
        if (kind === "own mounts unreadable") return denied();
        if (kind === "own mounts malformed") return "broken";
        return `25 1 8:48 / / rw - ext4 /dev/sda rw\n26 25 0:5 / /proc rw - proc proc rw\n30 25 8:48 ${encode(aliasRoot)} /alias rw - ext4 /dev/sda rw\n`;
      }
      if (value === base + "/mountinfo")
        return `40 1 8:48 ${kind === "different isolated" ? "/unrelated" : encode(directory)} /app rw - ext4 /dev/sda rw\n`;
      if (
        value === base + "/maps" ||
        /^\/proc\/101\/task\/\d+\/maps$/u.test(value)
      )
        return mapped
          ? `1000-2000 r--p 00000000 08:30 12 ${kind === "map alias" ? "/alias/file" : "/outside/file"}\n`
          : "";
      if (value.endsWith("/comm")) return "java\n";
      if (value.endsWith("/cmdline")) return "java\0";
      return denied();
    },
  };
}

describe("mount aliases and directory identities", () => {
  it.each(
    [1000, 107473].flatMap((uid) =>
      [
        ["cwd alias", "held"],
        ["fd alias", "held"],
        ["exe alias", "held"],
        ["map alias", "held"],
        ["subdirectory alias", "held"],
        ["ancestor alias", "held"],
        ["different exposing", "uncertain"],
        ["different isolated", "clear"],
        ["own mounts unreadable", "uncertain"],
        ["own mounts malformed", "uncertain"],
        ["cwd identity", "held"],
        ["fd identity", "held"],
        ["map identity", "held"],
        ["cwd stat failure", "uncertain"],
        ["fd stat failure", "uncertain"],
        ["map stat failure", "clear"],
        ["tree unreadable", "uncertain"],
        ["tree too large", "uncertain"],
      ].map(([kind, expected]) => [uid, kind!, expected!] as const),
    ),
  )("checks uid %s with %s", async (uid, kind, expected) => {
    const result = await scanLinux(
      "/work/tree",
      mountAliasProc("/work/tree", kind, uid),
      4242,
      { maxDirectories: kind === "tree too large" ? 1 : 100 },
    );
    expect(result).toMatchObject({ status: expected });
  });
});

describe("opportunistic map_files identities", () => {
  it.each(["EPERM", "EACCES", "ENOENT", "EIO"])(
    "ignores %s with readable maps outside",
    async (code) => {
      const proc = mountAliasProc("/work/tree", "map stat failure", 1000);
      const reader: ProcReader = {
        ...proc,
        statId: async (target) => {
          if (target.includes("/map_files/"))
            throw Object.assign(new Error(code), { code });
          return proc.statId(target);
        },
      };
      expect(await scanLinux("/work/tree", reader, 4242)).toMatchObject({
        status: "clear",
      });
    },
  );
  it("keeps a readable mapped worktree path despite map_files EPERM", async () => {
    const proc = mountAliasProc("/work/tree", "map stat failure", 1000);
    const reader: ProcReader = {
      ...proc,
      statId: async (target) => {
        if (target.includes("/map_files/"))
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        return proc.statId(target);
      },
      readFile: async (target) =>
        target === "/proc/101/maps"
          ? "1000-2000 r--p 00000000 08:30 12 /work/tree/file\n"
          : proc.readFile(target),
    };
    expect(await scanLinux("/work/tree", reader, 4242)).toMatchObject({
      status: "held",
    });
  });
});

describe("synchronous proc reads", () => {
  it.each([
    ["/proc", true],
    ["/proc/1/fd", true],
    ["/proc/1/task/2/fd/3", true],
    ["/proc/1/cwd", true],
    ["/proc/1/root", true],
    ["/proc/1/exe", false],
    ["/proc/1/map_files", false],
    ["/proc/1/map_files/1000-2000", false],
    ["/proc/1/root/home", false],
    ["/proc/1/cwd/sub", false],
    ["/proc/1/fd/3/sub", false],
    ["/proc/../home", false],
    ["/home/user", false],
  ] as const)("reads %s synchronously: %s", (target, expected) => {
    expect(procReadIsSynchronous(target)).toBe(expected);
  });
});

describe("mappings made while threads are scanned", () => {
  it.each([1000, 107473])(
    "keeps uid %s when a thread maps a worktree file and closes its fd during the scan",
    async (uid) => {
      const proc = mountAliasProc("/work/tree", "outside", uid);
      const task = "/proc/101/task/102";
      let mapped = false;
      const maps = () =>
        `1000-2000 r-xp 00000000 08:30 11 /usr/lib/libc.so\n${mapped ? "3000-4000 r--p 00000000 08:30 12 /work/tree/file\n" : ""}`;
      const reader: ProcReader = {
        ...proc,
        readdir: async (target) => {
          if (target === "/proc/101/task") return ["101", "102"];
          if (target === task + "/fd") {
            mapped = true;
            return ["3"];
          }
          return proc.readdir(target);
        },
        readlink: async (target) => {
          if (target === task + "/fd/3")
            throw Object.assign(new Error("closed"), { code: "ENOENT" });
          return proc.readlink(target);
        },
        readFile: async (target) =>
          target === "/proc/101/maps" || target === task + "/maps"
            ? maps()
            : proc.readFile(target),
      };
      expect(await scanLinux("/work/tree", reader, 4242)).toMatchObject({
        status: "held",
      });
    },
  );
});

describe("system processes in another mount namespace", () => {
  const containerRoot = "40 39 0:77 / / rw - overlay overlay rw\n";
  const mirror =
    "50 1 8:48 / / rw - ext4 /dev/sda rw\n51 50 0:5 / /proc rw - proc proc rw\n";
  const bind = (root: string, point: string) =>
    `41 40 8:48 ${root} ${point} rw - ext4 /dev/sda rw\n`;
  const cases = [
    [
      "a bind mount of the worktree",
      containerRoot + bind("/work/tree", "/app"),
      "uncertain",
    ],
    [
      "a bind mount of a worktree subfolder",
      containerRoot + bind("/work/tree/sub", "/app"),
      "uncertain",
    ],
    [
      "a bind mount of a worktree ancestor",
      containerRoot + bind("/work", "/data"),
      "uncertain",
    ],
    [
      "a bind mount holding an fd under a mount stacked on it",
      containerRoot +
        bind("/work/tree", "/app") +
        "42 41 0:61 / /app rw - tmpfs tmpfs rw\n",
      "uncertain",
    ],
    [
      "a bind mount of a worktree subfolder hidden by a tmpfs on its parent",
      containerRoot +
        "41 40 8:48 /work/tree/sub /srv/app rw - ext4 /dev/sda rw\n42 40 0:61 / /srv rw - tmpfs tmpfs rw\n",
      "uncertain",
    ],
    ["a mirror of our mounts", mirror, "clear"],
    [
      "a mirror whose worktree is hidden by a tmpfs",
      mirror + "52 50 0:60 / /work rw - tmpfs tmpfs rw\n",
      "clear",
    ],
    [
      "a mirror of our mounts and of our alias bind",
      mirror + "53 50 8:48 /work/tree /alias rw - ext4 /dev/sda rw\n",
      "clear",
    ],
    [
      "only another device",
      containerRoot + "41 40 8:99 / /app rw - ext4 /dev/sdb rw\n",
      "clear",
    ],
    ["our own mount namespace", null, "clear"],
    ["an unreadable mount table", "denied", "clear"],
  ] as const;
  it.each(
    ["earlier", "final"].flatMap((scan) =>
      [0, 999].flatMap((uid) =>
        cases.map(
          ([kind, mountinfo, expected]) =>
            [scan, uid, kind, mountinfo, expected] as const,
        ),
      ),
    ),
  )(
    "checks on the %s scan a uid %s process that sees %s",
    async (scan, uid, kind, mountinfo, expected) => {
      const proc = mountAliasProc("/work/tree", "outside", uid);
      const holdsFd = kind.includes("holding an fd");
      const reader: ProcReader = {
        ...proc,
        readdir: async (target) =>
          holdsFd && target === "/proc/101/fd" ? ["3"] : proc.readdir(target),
        readlink: async (target) => {
          if (holdsFd && target === "/proc/101/fd/3")
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          return proc.readlink(target);
        },
        readFile: async (target) => {
          if (target !== "/proc/101/mountinfo") return proc.readFile(target);
          if (mountinfo === "denied")
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          return mountinfo ?? proc.readFile("/proc/self/mountinfo");
        },
      };
      expect(
        await scanLinux(
          "/work/tree",
          reader,
          4242,
          scan === "final"
            ? { maxDirectories: 500_000, final: true }
            : undefined,
        ),
      ).toMatchObject(
        expected === "uncertain"
          ? {
              status: "uncertain",
              reason: expect.stringContaining(`process 101 system uid ${uid}`),
            }
          : { status: "clear" },
      );
    },
  );
  const ownUnreadableReader = (
    pids: string[],
    foreign: string,
    ownRead: (armedRead: number) => "EACCES" | "unparsable" | null,
  ) => {
    const proc = mountAliasProc("/work/tree", "outside", 0);
    const local = (target: string) =>
      target.replace(/^\/proc\/1\d\d(?=\/|$)/u, "/proc/101");
    const counter = { armedReads: 0 };
    let armed = false;
    const reader: ProcReader = {
      ...proc,
      readdir: async (target) => {
        if (target !== "/proc") return proc.readdir(local(target));
        armed = true;
        return pids;
      },
      readlink: async (target) => proc.readlink(local(target)),
      readFile: async (target) => {
        if (target === "/proc/self/mountinfo" && armed) {
          counter.armedReads++;
          const outcome = ownRead(counter.armedReads);
          if (outcome === "EACCES")
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          if (outcome === "unparsable") return "not a mount table\n";
        }
        if (/^\/proc\/\d+\/mountinfo$/u.test(target)) return foreign;
        return proc.readFile(local(target));
      },
    };
    const disarm = () => {
      armed = false;
    };
    return { reader, counter, disarm };
  };
  it.each(
    ["earlier", "final"].flatMap((scan) =>
      (["EACCES", "unparsable"] as const).map(
        (outcome) => [scan, outcome] as const,
      ),
    ),
  )(
    "keeps the worktree on the %s scan when our first own mount table read after listing processes is %s and a later read would show exposure",
    async (scan, outcome) => {
      const { reader, counter } = ownUnreadableReader(
        ["101", "102"],
        containerRoot + bind("/work/tree", "/app"),
        (read) => (read === 1 ? outcome : null),
      );
      const result = await scanLinux(
        "/work/tree",
        reader,
        4242,
        scan === "final" ? { maxDirectories: 500_000, final: true } : undefined,
      );
      expect(counter.armedReads).toBeGreaterThan(0);
      expect(result).toMatchObject({
        status: "uncertain",
        reason: expect.stringContaining(
          `our own mountinfo is unreadable (${outcome})`,
        ),
      });
      expect(describeHolderScan(result)).toContain("so it was kept");
    },
  );
  it("reads a failing own mount table once per scan and again on the next scan", async () => {
    const readsPerScan = async (pids: string[]) => {
      const { reader, counter, disarm } = ownUnreadableReader(
        pids,
        mirror,
        () => "EACCES",
      );
      const reads: number[] = [];
      for (const limits of [
        undefined,
        { maxDirectories: 500_000, final: true },
      ]) {
        disarm();
        expect(
          await scanLinux("/work/tree", reader, 4242, limits),
        ).toMatchObject({
          status: "uncertain",
          reason: expect.stringContaining(
            "our own mountinfo is unreadable (EACCES)",
          ),
        });
        reads.push(counter.armedReads);
      }
      return reads;
    };
    const single = await readsPerScan(["101"]);
    expect(single[0]).toBeGreaterThan(0);
    expect(single[1]).toBe(2 * (single[0] ?? 0));
    expect(
      await readsPerScan(["101", "102", "103", "104", "105", "106"]),
    ).toEqual(single);
  });
  const ownTableReader = (
    own: string,
    mountId: () => Promise<string>,
    foreign: string,
  ) => {
    const proc = mountAliasProc("/work/tree", "outside", 0);
    const local = (target: string) =>
      target.replace(/^\/proc\/1\d\d(?=\/|$)/u, "/proc/101");
    const reader: ProcReader = {
      ...proc,
      mountId: async (target) =>
        target === "/work/tree" ? mountId() : proc.mountId(target),
      readdir: async (target) =>
        target === "/proc" ? ["101", "102"] : proc.readdir(local(target)),
      readlink: async (target) => proc.readlink(local(target)),
      readFile: async (target) => {
        if (target === "/proc/self/mountinfo") return own;
        if (/^\/proc\/\d+\/mountinfo$/u.test(target)) return foreign;
        return proc.readFile(local(target));
      },
    };
    return reader;
  };
  const rootLine = "25 1 8:1 / / rw - ext4 /dev/sdb rw\n";
  const workLine = "60 25 8:48 / /work rw - ext4 /dev/sda rw\n";
  const ownTableCases = [
    [
      "a prefix of our table without the worktree mount, its ancestor on another device",
      rootLine,
      async () => "60",
      "70 1 8:1 / / rw - ext4 /dev/sdb rw\n71 70 8:48 /tree /app rw - ext4 /dev/sda rw\n",
      "uncertain",
    ],
    [
      "a mount stacked over an older one at the worktree's mount point, the older on another device",
      rootLine +
        "60 25 8:1 /old /work rw - ext4 /dev/sdb rw\n65 25 8:48 / /work rw - ext4 /dev/sda rw\n",
      async () => "65",
      "70 1 8:1 / / rw - ext4 /dev/sdb rw\n71 70 8:48 /tree /app rw - ext4 /dev/sda rw\n",
      "uncertain",
    ],
    [
      "a complete table whose worktree mount ID matches",
      rootLine + workLine,
      async () => "60",
      "70 1 8:1 / / rw - ext4 /dev/sdb rw\n71 70 8:48 / /work rw - ext4 /dev/sda rw\n",
      "clear",
    ],
    [
      "a btrfs subvolume root whose stat device differs but whose mount ID matches",
      "25 1 0:34 /@ / rw - btrfs /dev/sdc rw\n",
      async () => "25",
      "70 1 0:34 /@ / rw - btrfs /dev/sdc rw\n",
      "clear",
    ],
    [
      "a nested btrfs subvolume whose stat device differs but whose mount ID matches",
      "25 1 0:34 /@ / rw - btrfs /dev/sdc rw\n61 25 0:34 /@work /work rw - btrfs /dev/sdc rw\n",
      async () => "61",
      "70 1 0:34 /@ / rw - btrfs /dev/sdc rw\n71 70 0:34 /@work /work rw - btrfs /dev/sdc rw\n",
      "clear",
    ],
    [
      "fdinfo without a mount ID",
      rootLine + workLine,
      async (): Promise<string> => {
        throw Object.assign(new Error("no mnt_id"), { code: "ENODATA" });
      },
      "70 1 8:1 / / rw - ext4 /dev/sdb rw\n71 70 8:48 / /work rw - ext4 /dev/sda rw\n",
      "uncertain",
    ],
    [
      "a worktree path that is not a directory",
      rootLine + workLine,
      async (): Promise<string> => {
        throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
      },
      "70 1 8:1 / / rw - ext4 /dev/sdb rw\n71 70 8:48 / /work rw - ext4 /dev/sda rw\n",
      "uncertain",
    ],
    [
      "a worktree directory we cannot open",
      rootLine + workLine,
      async (): Promise<string> => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
      "70 1 8:1 / / rw - ext4 /dev/sdb rw\n71 70 8:48 / /work rw - ext4 /dev/sda rw\n",
      "uncertain",
    ],
  ] as const;
  it.each(
    ["earlier", "final"].flatMap((scan) =>
      ownTableCases.map(
        ([kind, own, mountId, foreign, expected]) =>
          [scan, kind, own, mountId, foreign, expected] as const,
      ),
    ),
  )(
    "checks our own mount table on the %s scan against the worktree mount ID with %s",
    async (scan, _kind, own, mountId, foreign, expected) => {
      const result = await scanLinux(
        "/work/tree",
        ownTableReader(own, mountId, foreign),
        4242,
        scan === "final" ? { maxDirectories: 500_000, final: true } : undefined,
      );
      if (expected === "clear") {
        expect(result).toEqual({ status: "clear" });
        return;
      }
      expect(result).toMatchObject({
        status: "uncertain",
        reason: expect.stringContaining("our own mountinfo is unreadable ("),
      });
      expect(describeHolderScan(result)).toContain("so it was kept");
    },
  );
  const absent = async (): Promise<string> => {
    throw Object.assign(new Error("absent"), { code: "ENOENT" });
  };
  const absentCases = [
    [
      "only mirrors",
      "70 1 8:1 / / rw - ext4 /dev/sdb rw\n71 70 8:48 / /work rw - ext4 /dev/sda rw\n",
      null,
    ],
    [
      "a bind mount of the worktree",
      "70 1 8:1 / / rw - ext4 /dev/sdb rw\n71 70 8:48 /tree /app rw - ext4 /dev/sda rw\n",
      "sees the worktree at /app",
    ],
  ] as const;
  it.each(
    ["earlier", "final"].flatMap((scan) =>
      absentCases.map(
        ([kind, foreign, uncertain]) =>
          [scan, kind, foreign, uncertain] as const,
      ),
    ),
  )(
    "scans a worktree path that no longer exists on the %s scan as before when a system process sees %s",
    async (scan, _kind, foreign, uncertain) => {
      expect(
        await scanLinux(
          "/work/tree",
          ownTableReader(rootLine + workLine, absent, foreign),
          4242,
          scan === "final"
            ? { maxDirectories: 500_000, final: true }
            : undefined,
        ),
      ).toMatchObject(
        uncertain === null
          ? { status: "clear" }
          : { status: "uncertain", reason: expect.stringContaining(uncertain) },
      );
    },
  );
  const mirrorForeign =
    "70 1 8:1 / / rw - ext4 /dev/sdb rw\n71 70 8:48 / /work rw - ext4 /dev/sda rw\n";
  const stackedAtWork = "65 60 8:2 / /work rw - ext4 /dev/sdc rw\n";
  const raceCases = [
    [
      "a mount stacked at the worktree's mount point after the worktree was opened",
      rootLine + workLine,
      "60",
      rootLine + workLine + stackedAtWork,
      "uncertain",
    ],
    [
      "a mount stacked at the worktree's mount point before the worktree was opened",
      rootLine + workLine,
      "65",
      rootLine + workLine + stackedAtWork,
      "uncertain",
    ],
    [
      "a mount stacked inside the worktree after the worktree was opened",
      rootLine + workLine,
      "60",
      rootLine +
        workLine +
        "66 60 8:2 / /work/tree/sub rw - ext4 /dev/sdc rw\n",
      "uncertain",
    ],
    [
      "unrelated mounts that change between the reads",
      rootLine + workLine + "80 25 0:50 / /run/user/1000 rw - tmpfs tmpfs rw\n",
      "60",
      rootLine +
        workLine +
        "81 25 0:51 / /snap/core/1 ro - squashfs /dev/loop0 ro\n",
      "clear",
    ],
    [
      "no change between the reads",
      rootLine + workLine,
      "60",
      rootLine + workLine,
      "clear",
    ],
  ] as const;
  it.each(
    ["earlier", "final"].flatMap((scan) =>
      raceCases.map(
        ([kind, before, mountId, after, expected]) =>
          [scan, kind, before, mountId, after, expected] as const,
      ),
    ),
  )(
    "rereads our own mount table after reading the worktree mount ID on the %s scan, with %s",
    async (scan, _kind, before, mountId, after, expected) => {
      let opened = false;
      const proc = ownTableReader(
        before,
        async () => {
          opened = true;
          return mountId;
        },
        mirrorForeign,
      );
      const reader: ProcReader = {
        ...proc,
        readFile: async (target) =>
          target === "/proc/self/mountinfo"
            ? opened
              ? after
              : before
            : proc.readFile(target),
      };
      const result = await scanLinux(
        "/work/tree",
        reader,
        4242,
        scan === "final" ? { maxDirectories: 500_000, final: true } : undefined,
      );
      if (expected === "clear") {
        expect(result).toEqual({ status: "clear" });
        return;
      }
      expect(result).toMatchObject({
        status: "uncertain",
        reason: expect.stringContaining("our own mountinfo is unreadable ("),
      });
    },
  );
  it("reads our own mount table once per scan, however many system processes it checks", async () => {
    const scanWith = async (processes: number) => {
      const proc = mountAliasProc("/work/tree", "outside", 0);
      const pids = Array.from({ length: processes }, (_, index) =>
        String(101 + index),
      );
      const local = (target: string) =>
        target.replace(/^\/proc\/1\d\d(?=\/|$)/u, "/proc/101");
      let ownReads = 0;
      const foreignReads = new Map<string, number>();
      const reader: ProcReader = {
        ...proc,
        readdir: async (target) =>
          target === "/proc" ? pids : proc.readdir(local(target)),
        readlink: async (target) => proc.readlink(local(target)),
        readFile: async (target) => {
          if (target === "/proc/self/mountinfo") ownReads++;
          if (/^\/proc\/\d+\/mountinfo$/u.test(target)) {
            foreignReads.set(target, (foreignReads.get(target) ?? 0) + 1);
            return mirror;
          }
          return proc.readFile(local(target));
        },
      };
      expect(await scanLinux("/work/tree", reader, 4242)).toEqual({
        status: "clear",
      });
      expect([...foreignReads.values()]).toEqual(pids.map(() => 1));
      return ownReads;
    };
    expect(await scanWith(6)).toBe(await scanWith(1));
  });
});

describe("same-user processes in another mount namespace", () => {
  const mirror =
    "50 1 8:48 / / rw - ext4 /dev/sda rw\n51 50 0:5 / /proc rw - proc proc rw\n";
  const hidden = "40 1 8:48 /unrelated /app rw - ext4 /dev/sda rw\n";
  const nsfs =
    "52 50 0:4 net:[4026532364] /run/docker/netns/682a4718e917 rw - nsfs nsfs rw\n";
  const cases = [
    ["only mirrors and an nsfs bind", mirror + nsfs, {}, "clear"],
    ["only mirrors", mirror, {}, "clear"],
    [
      "a mirror hidden by a tmpfs",
      mirror + "53 50 0:60 / /work rw - tmpfs tmpfs rw\n",
      {},
      "clear",
    ],
    [
      "mirrors and a cwd inside the worktree",
      mirror + nsfs,
      { cwd: "/work/tree/sub" },
      "held",
    ],
    [
      "a hidden mirror and an fd inside the worktree",
      mirror + "53 50 0:60 / /work rw - tmpfs tmpfs rw\n",
      { fd: "/work/tree/file" },
      "held",
    ],
    [
      "a mount root that is neither a path nor nsfs",
      mirror + "54 50 0:99 weird:[1] /x rw - proc proc rw\n",
      {},
      "uncertain",
    ],
    [
      "a bind mount that remaps the worktree",
      mirror + "41 50 8:48 /work/tree /app rw - ext4 /dev/sda rw\n",
      {},
      "uncertain",
    ],
    ["an unreadable mount table", "denied", {}, "uncertain"],
    [
      "mirrors and an fd whose link cannot be read",
      mirror,
      { fdDenied: true },
      "unknown",
    ],
    ["only mirrors from one of its threads", mirror, { thread: true }, "clear"],
    [
      "mirrors and a root folder at the worktree",
      mirror,
      { root: "/work/tree" },
      "held",
    ],
    [
      "mirrors and a root folder elsewhere",
      mirror,
      { root: "/srv/jail" },
      "uncertain",
    ],
    [
      "mirrors and a root folder that cannot be read",
      mirror,
      { rootDenied: true },
      "unknown",
    ],
    [
      "mirrors and an nsfs bind inside the worktree",
      mirror +
        "52 50 0:4 net:[4026532364] /work/tree/netns rw - nsfs nsfs rw\n",
      {},
      "uncertain",
    ],
    [
      "only mirrors from a thread whose root folder is the worktree",
      mirror,
      { thread: true, root: "/work/tree" },
      "held",
    ],
    [
      "a hidden view and a detached root folder at the worktree",
      hidden,
      { root: "/", rootId: "1:100" },
      "held",
    ],
    [
      "a hidden view and a root folder elsewhere",
      hidden,
      { root: "/srv/jail" },
      "clear",
    ],
    [
      "a hidden view from a thread whose detached root folder is the worktree",
      hidden,
      { thread: true, root: "/", rootId: "1:100" },
      "held",
    ],
    [
      "a hidden view and a root folder that cannot be read",
      hidden,
      { rootDenied: true },
      "clear",
    ],
    [
      "a hidden view from a thread whose root folder cannot be read",
      hidden,
      { thread: true, rootDenied: true },
      "clear",
    ],
    [
      "mirrors from a thread whose root folder cannot be read",
      mirror,
      { thread: true, rootDenied: true },
      "uncertain",
    ],
  ] as const;
  it.each(
    ["earlier", "final"].flatMap((scan) =>
      cases.map(
        ([kind, mountinfo, links, expected]) =>
          [scan, kind, mountinfo, links, expected] as const,
      ),
    ),
  )(
    "checks on the %s scan a same-user process that sees %s",
    async (scan, _kind, mountinfo, links, expected) => {
      const extra: {
        cwd?: string;
        fd?: string;
        fdDenied?: boolean;
        thread?: boolean;
        root?: string;
        rootDenied?: boolean;
        rootId?: string;
      } = links;
      const rootLink =
        extra.thread === true ? "/proc/101/task/102/root" : "/proc/101/root";
      const proc = mountAliasProc(
        "/work/tree",
        extra.thread === true ? "same" : "different isolated",
        1000,
      );
      const reader: ProcReader = {
        ...proc,
        readdir: async (target) => {
          if (
            (extra.fd !== undefined || extra.fdDenied === true) &&
            target === "/proc/101/fd"
          )
            return ["3"];
          if (extra.thread === true && target === "/proc/101/task")
            return ["101", "102"];
          return proc.readdir(target);
        },
        readlink: async (target) => {
          if (extra.cwd !== undefined && target === "/proc/101/cwd")
            return extra.cwd;
          if (extra.fd !== undefined && target === "/proc/101/fd/3")
            return extra.fd;
          if (extra.fdDenied === true && target === "/proc/101/fd/3")
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          if (extra.thread === true && target === "/proc/101/task/102/ns/mnt")
            return "mnt:[3]";
          if (extra.root !== undefined && target === rootLink)
            return extra.root;
          if (extra.rootDenied === true && target === rootLink)
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          return proc.readlink(target);
        },
        statId: async (target) => {
          if (extra.rootId !== undefined && target === rootLink)
            return extra.rootId;
          if (extra.rootDenied === true && target === rootLink)
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          return proc.statId(target);
        },
        readFile: async (target) => {
          if (
            extra.thread === true &&
            target === "/proc/101/task/102/mountinfo"
          )
            return mountinfo;
          if (target !== "/proc/101/mountinfo") return proc.readFile(target);
          if (mountinfo === "denied")
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          return mountinfo;
        },
      };
      expect(
        await scanLinux(
          "/work/tree",
          reader,
          4242,
          scan === "final"
            ? { maxDirectories: 500_000, final: true }
            : undefined,
        ),
      ).toMatchObject({ status: expected });
    },
  );
});

describe("exited thread group leaders", () => {
  it.each(
    ["earlier", "final"].flatMap((scan) =>
      [1000, 107473].flatMap((uid) =>
        [
          ["a live thread holding a worktree fd", "held"],
          ["only zombie threads", "clear"],
          ["no other threads", "clear"],
          ["an unreadable thread list", "uncertain"],
        ].map(([kind, expected]) => [scan, uid, kind!, expected!] as const),
      ),
    ),
  )(
    "checks on the %s scan a uid %s zombie leader with %s",
    async (scan, uid, kind, expected) => {
      const proc = mountAliasProc("/work/tree", "outside", uid);
      const task = "/proc/101/task/102";
      const gone = (): never => {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      };
      const status = (state: string) =>
        `State:\t${state}\nPPid:\t1\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t1000\t1000\t1000\t1000\n`;
      const reader: ProcReader = {
        ...proc,
        readdir: async (target) => {
          if (target === "/proc/101/task") {
            if (kind === "an unreadable thread list")
              throw Object.assign(new Error("denied"), { code: "EACCES" });
            return kind === "no other threads" ? ["101"] : ["101", "102"];
          }
          if (target === task + "/fd") return ["3"];
          return proc.readdir(target);
        },
        readlink: async (target) => {
          if (
            ["/proc/101/cwd", "/proc/101/exe", "/proc/101/root"].includes(
              target,
            ) ||
            target === "/proc/101/ns/mnt"
          )
            return gone();
          if (target === task + "/fd/3") return "/work/tree/file";
          return proc.readlink(target);
        },
        readFile: async (target) => {
          if (target === "/proc/101/status") return status("Z (zombie)");
          if (target === task + "/status")
            return status(
              kind === "only zombie threads" ? "Z (zombie)" : "S (sleeping)",
            );
          return proc.readFile(target);
        },
      };
      expect(
        await scanLinux(
          "/work/tree",
          reader,
          4242,
          scan === "final"
            ? { maxDirectories: 500_000, final: true }
            : undefined,
        ),
      ).toMatchObject(
        expected === "uncertain"
          ? {
              status: expected,
              reason: expect.stringContaining("threads could not be listed"),
            }
          : { status: expected },
      );
    },
  );
});

const exitedLeaderSource = `
#include <pthread.h>
#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>
static char filename[4096];
static void *hold(void *arg) {
  int fd = open(filename, O_RDONLY);
  if (fd < 0) _exit(3);
  printf("ready\\n");
  fflush(stdout);
  for (;;) pause();
}
int main(void) {
  if (!fgets(filename, sizeof(filename), stdin)) return 4;
  for (char *p = filename; *p; p++) if (*p == '\\n') *p = 0;
  pthread_t thread;
  if (pthread_create(&thread, NULL, hold, NULL)) return 5;
  pthread_exit(NULL);
}
`;

it.skipIf(process.platform !== "linux")(
  "holds a real worktree fd of a thread whose leader called pthread_exit",
  async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "bb-exited-leader-")),
    );
    const directory = path.join(root, "worktree");
    await fs.mkdir(directory);
    const filename = path.join(directory, "held.txt");
    await fs.writeFile(filename, "held by a thread\n");
    const source = path.join(root, "helper.c");
    const executable = path.join(root, "helper");
    await fs.writeFile(source, exitedLeaderSource);
    expect(spawnSync("cc", ["-pthread", source, "-o", executable]).status).toBe(
      0,
    );
    const child = spawn(executable, [], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const ready = Promise.race([
        once(child.stdout!, "data"),
        once(child, "exit").then(() => {
          throw new Error("exited-leader helper exited");
        }),
      ]);
      child.stdin!.end(filename + "\n");
      await ready;
      const base = `/proc/${child.pid}`;
      let state = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        state = /^State:\s+(\S)/mu.exec(
          await hostProc.readFile(base + "/status"),
        )![1]!;
        if (state === "Z") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(state).toBe("Z");
      const proc: ProcReader = {
        ...hostProc,
        readdir: async (target) =>
          target === "/proc" ? [String(child.pid)] : hostProc.readdir(target),
      };
      expect(await scanLinux(directory, proc)).toMatchObject({
        status: "held",
        holders: [{ pid: child.pid, through: "open file" }],
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill();
        await closed;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

describe("non-absolute fd links", () => {
  it.each([
    ["(unreachable)/x", "held"],
    ["socket:[12345]", "clear"],
  ] as const)("checks the identity of fd link %s", async (link, expected) => {
    const proc = mountAliasProc("/work/tree", "fd identity", 1000);
    const reader: ProcReader = {
      ...proc,
      readlink: async (target) =>
        target === "/proc/101/fd/3" ? link : proc.readlink(target),
    };
    expect(await scanLinux("/work/tree", reader, 4242)).toMatchObject({
      status: expected,
    });
  });
});

describe.skipIf(process.platform !== "linux")(
  "real own-uid mapping processes",
  () => {
    it.each(
      ["sleep", "node"].flatMap((command) =>
        [false, true].map((inside) => [command, inside] as const),
      ),
    )("checks real %s with inside cwd=%s", async (command, inside) => {
      const fs = await import("node:fs/promises");
      const os = await import("node:os");
      const path = await import("node:path");
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "bb-real-map-")),
      );
      const directory = path.join(root, "worktree");
      await fs.mkdir(directory);
      const child = spawn(
        command === "node" ? process.execPath : "sleep",
        command === "node"
          ? ["-e", "setInterval(()=>{},1e3);process.send('ready')"]
          : ["30"],
        {
          cwd: inside ? directory : root,
          stdio:
            command === "node"
              ? ["ignore", "ignore", "ignore", "ipc"]
              : "ignore",
        },
      );
      try {
        await once(child, command === "node" ? "message" : "spawn");
        const proc: ProcReader = {
          ...hostProc,
          readdir: async (target) =>
            target === "/proc" ? [String(child.pid)] : hostProc.readdir(target),
        };
        const scan = await scanLinux(directory, proc);
        expect(scan).toMatchObject({ status: inside ? "held" : "clear" });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, "close");
          child.kill();
          await closed;
        }
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  },
);

const taskPrivateFdSource =
  '\n#define _GNU_SOURCE\n#include <sched.h>\n#include <pthread.h>\n#include <stdio.h>\n#include <stdlib.h>\n#include <fcntl.h>\n#include <unistd.h>\nstatic void *hold(void *arg) {\n  if (unshare(CLONE_FILES) != 0) { perror("unshare"); _exit(2); }\n  int fd = open(arg, O_RDONLY);\n  if (fd < 0) { perror("open"); _exit(3); }\n  printf("ready\\n"); fflush(stdout);\n  for (;;) pause();\n}\nint main(void) {\n  char filename[4096];\n  if (!fgets(filename, sizeof(filename), stdin)) return 4;\n  for (char *p = filename; *p; p++) if (*p == \'\\n\') *p = 0;\n  pthread_t thread;\n  if (pthread_create(&thread, NULL, hold, filename)) return 5;\n  for (;;) pause();\n}\n';

describe("task-private file tables", () => {
  it.each(
    [1000, 107473].flatMap((uid) =>
      [
        ["fd path", "held"],
        ["fd alias", "held"],
        ["fd identity", "held"],
        ["unreadable fd", "uncertain"],
        ["maps path", "held"],
        ["maps alias", "held"],
        ["unreadable maps", "uncertain"],
        ["outside", "clear"],
      ].map(([kind, expected]) => [uid, kind!, expected!] as const),
    ),
  )("checks task-private %s %s", async (uid, kind, expected) => {
    const proc = mountAliasProc("/work/tree", "outside", uid);
    const task = "/proc/101/task/102";
    const denied = (): never => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    const reader: ProcReader = {
      ...proc,
      readdir: async (target) => {
        if (target === "/proc/101/task") return ["101", "102"];
        if (target === task + "/fd")
          return kind === "unreadable fd"
            ? denied()
            : kind.startsWith("fd ")
              ? ["3"]
              : [];
        return proc.readdir(target);
      },
      readlink: async (target) =>
        target === task + "/fd/3"
          ? kind === "fd path"
            ? "/work/tree/file"
            : kind === "fd alias"
              ? "/alias/file"
              : "/outside/file"
          : proc.readlink(target),
      statId: async (target) =>
        target === task + "/fd/3" && kind === "fd identity"
          ? "1:101"
          : proc.statId(target),
      readFile: async (target) => {
        if (target === task + "/maps") {
          if (kind === "unreadable maps") return denied();
          return kind.startsWith("maps ")
            ? `1000-2000 r--p 00000000 08:30 12 ${kind === "maps alias" ? "/alias/file" : "/work/tree/file"}\n`
            : "";
        }
        return proc.readFile(target);
      },
    };
    expect(await scanLinux("/work/tree", reader, 4242)).toMatchObject({
      status: expected,
    });
  });
});

it.skipIf(process.platform !== "linux")(
  "holds a real task-private fd after unshare(CLONE_FILES)",
  async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "bb-task-private-fd-")),
    );
    const directory = path.join(root, "worktree");
    await fs.mkdir(directory);
    const filename = path.join(directory, "held.txt");
    await fs.writeFile(filename, "private fd bytes\n");
    const source = path.join(root, "helper.c");
    const executable = path.join(root, "helper");
    await fs.writeFile(source, taskPrivateFdSource);
    expect(spawnSync("cc", ["-pthread", source, "-o", executable]).status).toBe(
      0,
    );
    const child = spawn(executable, [], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const ready = Promise.race([
        once(child.stdout!, "data"),
        once(child, "exit").then(() => {
          throw new Error("private-fd helper exited");
        }),
      ]);
      child.stdin!.end(filename + "\n");
      await ready;
      const base = `/proc/${child.pid}`;
      expect(await hostProc.readlink(base + "/cwd")).toBe(root);
      expect(await hostProc.readlink(base + "/exe")).toBe(executable);
      for (const fd of await hostProc.readdir(base + "/fd"))
        expect(await hostProc.readlink(base + "/fd/" + fd)).not.toContain(
          directory,
        );
      expect(await hostProc.readFile(base + "/maps")).not.toContain(directory);
      const proc: ProcReader = {
        ...hostProc,
        readdir: async (target) =>
          target === "/proc" ? [String(child.pid)] : hostProc.readdir(target),
      };
      expect(await scanLinux(directory, proc)).toMatchObject({
        status: "held",
        holders: [{ pid: child.pid, through: "open file" }],
      });
      expect(await fs.readFile(filename, "utf8")).toBe("private fd bytes\n");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill();
        await closed;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

describe("task-private namespace doubt", () => {
  it.each(["fd", "maps"])(
    "does not use leader isolation for unreadable task %s in our namespace",
    async (leaf) => {
      const proc = mountAliasProc("/work/tree", "different isolated", 107473);
      const task = "/proc/101/task/102";
      const denied = (): never => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      };
      const reader: ProcReader = {
        ...proc,
        readdir: async (target) =>
          target === "/proc/101/task"
            ? ["101", "102"]
            : target === task + "/fd" && leaf === "fd"
              ? denied()
              : proc.readdir(target),
        readFile: async (target) =>
          target === task + "/maps" && leaf === "maps"
            ? denied()
            : proc.readFile(target),
        readlink: async (target) =>
          target === task + "/ns/mnt" ? "mnt:[1]" : proc.readlink(target),
      };
      expect(await scanLinux("/work/tree", reader, 4242)).toMatchObject({
        status: "uncertain",
      });
    },
  );
});

const procChurnSource =
  '\n#define _GNU_SOURCE\n#include <pthread.h>\n#include <stdatomic.h>\n#include <fcntl.h>\n#include <stdio.h>\n#include <unistd.h>\nstatic atomic_ulong opens;\nstatic atomic_ulong threads;\nstatic char filename[4096];\nstatic void *files(void *arg) {\n  for (;;) {\n    int fd = open(filename, O_RDONLY);\n    if (fd < 0) _exit(2);\n    close(fd);\n    atomic_fetch_add(&opens, 1);\n  }\n}\nstatic void *short_task(void *arg) { usleep(100); return NULL; }\nstatic void *tasks(void *arg) {\n  for (;;) {\n    pthread_t thread;\n    if (pthread_create(&thread, NULL, short_task, NULL)) _exit(3);\n    pthread_join(thread, NULL);\n    atomic_fetch_add(&threads, 1);\n  }\n}\nint main(void) {\n  if (!fgets(filename, sizeof(filename), stdin)) return 4;\n  for (char *p=filename; *p; p++) if (*p==\'\\n\') *p=0;\n  pthread_t a,b;\n  if (pthread_create(&a,NULL,files,NULL) || pthread_create(&b,NULL,tasks,NULL)) return 5;\n  while (!atomic_load(&opens) || !atomic_load(&threads)) usleep(100);\n  printf("ready %lu %lu\\n",atomic_load(&opens),atomic_load(&threads)); fflush(stdout);\n  char input[16];\n  while (fgets(input,sizeof(input),stdin)) {\n    printf("stats %lu %lu\\n",atomic_load(&opens),atomic_load(&threads)); fflush(stdout);\n  }\n  return 0;\n}\n';

describe("vanished proc entries", () => {
  it.each(
    ["ENOENT", "ESRCH", "ENOTDIR"].flatMap((code) =>
      [
        "fd readlink",
        "fd stat",
        "task cwd",
        "task cwd stat",
        "task fd",
        "task maps",
        "task namespace",
        "process namespace",
        "process fd",
        "process maps",
        "process tasks",
      ].map((kind) => [code, kind] as const),
    ),
  )("skips %s at %s", async (code, kind) => {
    const proc = mountAliasProc("/work/tree", "outside", 107473);
    const task = "/proc/101/task/102";
    const gone = (): never => {
      throw Object.assign(new Error(code), { code });
    };
    const reader: ProcReader = {
      ...proc,
      readdir: async (target) => {
        if (target === "/proc/101/task")
          return kind === "process tasks" ? gone() : ["101", "102"];
        if (target === "/proc/101/fd")
          return kind === "process fd"
            ? gone()
            : kind.startsWith("fd ")
              ? ["3"]
              : [];
        if (target === task + "/fd" && kind === "task fd") return gone();
        return proc.readdir(target);
      },
      readlink: async (target) => {
        if (
          (target === "/proc/101/fd/3" && kind === "fd readlink") ||
          (target === task + "/cwd" && kind === "task cwd") ||
          (target === task + "/ns/mnt" && kind === "task namespace") ||
          (target === "/proc/101/ns/mnt" && kind === "process namespace")
        )
          return gone();
        if (target === "/proc/101/fd/3") return "/outside/file";
        return proc.readlink(target);
      },
      statId: async (target) =>
        (target === "/proc/101/fd/3" && kind === "fd stat") ||
        (target === task + "/cwd" && kind === "task cwd stat")
          ? gone()
          : proc.statId(target),
      readFile: async (target) =>
        (target === task + "/maps" && kind === "task maps") ||
        (target === "/proc/101/maps" && kind === "process maps")
          ? gone()
          : proc.readFile(target),
    };
    expect(await scanLinux("/work/tree", reader, 4242)).toMatchObject({
      status: "clear",
    });
  });
  it.each(["EACCES", "EPERM", "EIO"])(
    "retains real fd read failure %s",
    async (code) => {
      const proc = mountAliasProc("/work/tree", "outside", 107473);
      const reader: ProcReader = {
        ...proc,
        readdir: async (target) =>
          target === "/proc/101/fd" ? ["3"] : proc.readdir(target),
        readlink: async (target) => {
          if (target === "/proc/101/fd/3")
            throw Object.assign(new Error(code), { code });
          return proc.readlink(target);
        },
      };
      expect(await scanLinux("/work/tree", reader, 4242)).toMatchObject({
        status: "uncertain",
      });
    },
  );
  it("skips a process that exits after an earlier denied read", async () => {
    const proc = mountAliasProc("/work/tree", "outside", 107473);
    let statuses = 0;
    const reader: ProcReader = {
      ...proc,
      readlink: async (target) => {
        if (target === "/proc/101/cwd")
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        return proc.readlink(target);
      },
      readFile: async (target) => {
        if (target === "/proc/101/status" && ++statuses > 1)
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        return proc.readFile(target);
      },
    };
    expect(await scanLinux("/work/tree", reader, 4242)).toMatchObject({
      status: "clear",
    });
  });
});

it.skipIf(process.platform !== "linux")(
  "clears an idle worktree in 20 real fd and thread churn scans",
  async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "bb-proc-churn-")),
    );
    const directory = path.join(root, "worktree");
    await fs.mkdir(directory);
    const filename = path.join(root, "outside.txt");
    await fs.writeFile(filename, "outside\n");
    const source = path.join(root, "helper.c");
    const executable = path.join(root, "helper");
    await fs.writeFile(source, procChurnSource);
    expect(spawnSync("cc", ["-pthread", source, "-o", executable]).status).toBe(
      0,
    );
    const child = spawn(executable, [], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const first = Promise.race([
        once(child.stdout!, "data"),
        once(child, "exit").then(() => {
          throw new Error("churn helper exited");
        }),
      ]);
      child.stdin!.write(filename + "\n");
      const [ready] = await first;
      const before = /ready (\d+) (\d+)/u.exec(String(ready));
      expect(before).not.toBeNull();
      const proc: ProcReader = {
        ...hostProc,
        readdir: async (target) =>
          target === "/proc" ? [String(child.pid)] : hostProc.readdir(target),
      };
      const scans = [];
      for (let i = 0; i < 20; i++) scans.push(await scanLinux(directory, proc));
      const next = Promise.race([
        once(child.stdout!, "data"),
        once(child, "exit").then(() => {
          throw new Error("churn helper exited");
        }),
      ]);
      child.stdin!.write("stats\n");
      const [stats] = await next;
      const after = /stats (\d+) (\d+)/u.exec(String(stats));
      expect(after).not.toBeNull();
      expect(Number(after![1])).toBeGreaterThan(Number(before![1]));
      expect(Number(after![2])).toBeGreaterThan(Number(before![2]));
      expect(
        scans.map((scan) => scan.status),
        JSON.stringify(scans),
      ).toEqual(Array.from({ length: 20 }, () => "clear"));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill();
        await closed;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);

describe("final scan fd replacement", () => {
  it.each(["worktree", "outside", "churning"])(
    "rechecks a gone task fd replaced by %s",
    async (kind) => {
      const proc = mountAliasProc("/work/tree", "outside", 107473);
      const task = "/proc/101/task/102";
      let links = 0;
      let lists = 0;
      const reader: ProcReader = {
        ...proc,
        readdir: async (target) => {
          if (target === "/proc/101/task") return ["101", "102"];
          if (target === task + "/fd") {
            lists++;
            return ["79"];
          }
          return proc.readdir(target);
        },
        readlink: async (target) => {
          if (target !== task + "/fd/79") return proc.readlink(target);
          links++;
          if (links === 1 || kind === "churning")
            throw Object.assign(new Error("closed"), { code: "ENOENT" });
          return kind === "worktree" ? "/work/tree/README.md" : "/outside/file";
        },
      };
      expect(
        await scanLinux("/work/tree", reader, 4242, {
          maxDirectories: 500_000,
          final: true,
        }),
      ).toMatchObject({
        status:
          kind === "worktree"
            ? "held"
            : kind === "churning"
              ? "uncertain"
              : "clear",
      });
      expect(lists).toBe(kind === "churning" ? 4 : 2);
      expect(links).toBe(kind === "churning" ? 4 : 2);
    },
  );
  it("does not recheck a gone task fd on an earlier scan", async () => {
    const proc = mountAliasProc("/work/tree", "outside", 107473);
    const task = "/proc/101/task/102";
    let links = 0;
    const reader: ProcReader = {
      ...proc,
      readdir: async (target) =>
        target === "/proc/101/task"
          ? ["101", "102"]
          : target === task + "/fd"
            ? ["79"]
            : proc.readdir(target),
      readlink: async (target) => {
        if (target !== task + "/fd/79") return proc.readlink(target);
        if (++links === 1)
          throw Object.assign(new Error("closed"), { code: "ENOENT" });
        return "/work/tree/README.md";
      },
    };
    expect(await scanLinux("/work/tree", reader, 4242)).toMatchObject({
      status: "clear",
    });
    expect(links).toBe(1);
  });
});

describe.skipIf(
  process.platform !== "linux" ||
    (typeof process.getuid === "function" && process.getuid() === 0),
)("a real non-dumpable sshd-session", () => {
  const python = spawnSync("python3", ["--version"]);
  const parentPid = 4_194_305;
  const uid = process.getuid?.() ?? 0;

  async function start(name: string): Promise<number> {
    const child = spawn(
      "python3",
      [
        "-c",
        `import ctypes, time
libc = ctypes.CDLL(None)
libc.prctl(4, 0, 0, 0, 0)
libc.prctl(15, ${JSON.stringify(name)}.encode(), 0, 0, 0)
print("ready", flush=True)
time.sleep(120)`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    children.push(child);
    if (child.stdout !== null) await once(child.stdout, "data");
    return child.pid ?? 0;
  }

  async function nonDumpable(pid: number): Promise<boolean> {
    try {
      await readlink(`/proc/${pid}/ns/mnt`);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EACCES";
    }
  }

  async function worktree(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-sshd-session-"));
    roots.push(root);
    const directory = path.join(root, "wt");
    await mkdir(directory);
    return directory;
  }

  function reader(
    pid: number,
    options: {
      parent?: { comm: string; uids: string } | null;
      uids?: string;
      fdOwner?: number;
    },
  ): ProcReader {
    const parent =
      options.parent === undefined
        ? { comm: "sshd-session", uids: "0\t0\t0\t0" }
        : options.parent;
    return {
      ...hostProc,
      readdir: async (target) =>
        target === "/proc" ? ["self", String(pid)] : hostProc.readdir(target),
      readFile: async (target) => {
        if (target === `/proc/${pid}/status`) {
          const text = (await hostProc.readFile(target)).replace(
            /^PPid:.*$/mu,
            `PPid:\t${parentPid}`,
          );
          return options.uids === undefined
            ? text
            : text.replace(/^Uid:.*$/mu, `Uid:\t${options.uids}`);
        }
        if (parent !== null && target === `/proc/${parentPid}/status`)
          return `Name:\t${parent.comm}\nState:\tS (sleeping)\nPPid:\t1\nUid:\t${parent.uids}\n`;
        if (parent !== null && target === `/proc/${parentPid}/comm`)
          return `${parent.comm}\n`;
        return hostProc.readFile(target);
      },
      statAccess: async (target) => {
        const access = await hostProc.statAccess(target);
        return options.fdOwner !== undefined && target === `/proc/${pid}/fd`
          ? { ...access, uid: options.fdOwner }
          : access;
      },
    };
  }

  it("clears one whose parent is a root-owned sshd-session", async ({
    skip,
  }) => {
    skip(python.status !== 0, "python3 is not available");
    const directory = await worktree();
    const pid = await start("sshd-session");
    skip(!(await nonDumpable(pid)), "the kernel lets this user read it");
    expect(await scanLinux(directory, reader(pid, {}))).toMatchObject({
      status: "clear",
    });
  });

  it("keeps the worktree when its real parent is this test runner", async ({
    skip,
  }) => {
    skip(python.status !== 0, "python3 is not available");
    const directory = await worktree();
    const pid = await start("sshd-session");
    skip(!(await nonDumpable(pid)), "the kernel lets this user read it");
    const only: ProcReader = {
      ...hostProc,
      readdir: async (target) =>
        target === "/proc" ? ["self", String(pid)] : hostProc.readdir(target),
    };
    expect(await scanLinux(directory, only)).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining(
        `process ${pid} (sshd-session) has an unreadable holder path`,
      ),
    });
  });

  it.for([
    [
      "its parent is owned by our uid",
      "sshd-session",
      {
        parent: {
          comm: "sshd-session",
          uids: `${uid}\t${uid}\t${uid}\t${uid}`,
        },
      },
    ],
    [
      "its parent is only partly root-owned",
      "sshd-session",
      { parent: { comm: "sshd-session", uids: `0\t0\t0\t${uid}` } },
    ],
    [
      "its parent is not an sshd-session",
      "sshd-session",
      { parent: { comm: "bash", uids: "0\t0\t0\t0" } },
    ],
    [
      "its parent's comm only starts with sshd-session",
      "sshd-session",
      { parent: { comm: "sshd-sessionx", uids: "0\t0\t0\t0" } },
    ],
    ["its parent cannot be read", "sshd-session", { parent: null }],
    ["its comm only starts with sshd-session", "sshd-sessionx", {}],
    ["its comm is a prefix of sshd-session", "sshd-sessio", {}],
    [
      "its saved uid is root",
      "sshd-session",
      { uids: `${uid}\t${uid}\t0\t${uid}` },
    ],
    [
      "it is unreadable without being non-dumpable",
      "sshd-session",
      { fdOwner: uid },
    ],
  ] as const)(
    "keeps the worktree when %s",
    async ([, name, options], { skip }) => {
      skip(python.status !== 0, "python3 is not available");
      const directory = await worktree();
      const pid = await start(name);
      skip(!(await nonDumpable(pid)), "the kernel lets this user read it");
      expect(await scanLinux(directory, reader(pid, options))).toMatchObject({
        status: "unknown",
        reason: expect.stringContaining(
          `process ${pid} (${name}) has an unreadable holder path`,
        ),
      });
    },
  );

  it("keeps the worktree when a renamed child of a same-user sshd-session holds it", async ({
    skip,
  }) => {
    skip(python.status !== 0, "python3 is not available");
    const directory = await worktree();
    const parent = spawn(
      "python3",
      [
        "-c",
        `import ctypes, os, time
libc = ctypes.CDLL(None)
libc.prctl(4, 0, 0, 0, 0)
libc.prctl(15, b"sshd-session", 0, 0, 0)
child = os.fork()
if child == 0:
    libc.prctl(1, 9, 0, 0, 0)
    os.chdir(${JSON.stringify(directory)})
    held = open("held", "w")
    libc.prctl(4, 0, 0, 0, 0)
    libc.prctl(15, b"sshd-session", 0, 0, 0)
    time.sleep(120)
    os._exit(0)
print(child, flush=True)
time.sleep(120)`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    children.push(parent);
    const [line] =
      parent.stdout === null ? [""] : await once(parent.stdout, "data");
    const child = Number.parseInt(String(line), 10);
    try {
      skip(
        !(await nonDumpable(parent.pid ?? 0)) || !(await nonDumpable(child)),
        "the kernel lets this user read it",
      );
      const chain: ProcReader = {
        ...hostProc,
        readdir: async (target) =>
          target === "/proc"
            ? ["self", String(parent.pid), String(child)]
            : hostProc.readdir(target),
      };
      expect(await scanLinux(directory, chain)).toMatchObject({
        status: "unknown",
        blockingProcesses: expect.arrayContaining([
          expect.objectContaining({ pid: child }),
        ]),
        reason: expect.stringContaining(
          `process ${child} (sshd-session) has an unreadable holder path`,
        ),
      });
    } finally {
      process.kill(child, "SIGKILL");
    }
  });

  it("keeps the worktree when a forged non-dumpable orphaned ssh-agent holds a file open", async ({
    skip,
  }) => {
    skip(python.status !== 0, "python3 is not available");
    const directory = await worktree();
    const launcher = spawn(
      "python3",
      [
        "-c",
        `import ctypes, os, sys, time
libc = ctypes.CDLL(None)
r, w = os.pipe()
pid1 = os.fork()
if pid1 == 0:
    os.close(r)
    fork1 = os.getpid()
    pid2 = os.fork()
    if pid2 == 0:
        devnull = os.open(os.devnull, os.O_RDWR)
        os.dup2(devnull, 1)
        os.dup2(devnull, 2)
        os.close(devnull)
        held = open(os.path.join(${JSON.stringify(directory)}, "held"), "w")
        libc.prctl(4, 0, 0, 0, 0)
        libc.prctl(15, b"ssh-agent", 0, 0, 0)
        deadline = time.monotonic() + 5.0
        while os.getppid() == fork1:
            if time.monotonic() >= deadline:
                os.write(w, f"timeout {os.getpid()} {fork1} {os.getppid()}".encode())
                os.close(w)
                held.close()
                os._exit(2)
            time.sleep(0.01)
        os.write(w, f"{os.getpid()} {fork1}".encode())
        os.close(w)
        time.sleep(120)
        held.close()
        os._exit(0)
    os._exit(0)
os.close(w)
os.waitpid(pid1, 0)
data = os.read(r, 64).decode().strip()
os.close(r)
if not data or data.startswith("timeout"):
    print(data or "empty", file=sys.stderr, flush=True)
    sys.exit(2)
print(data, flush=True)`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(launcher);
    const [exitCode, stdout, stderr] = await new Promise<
      [number | null, string, string]
    >((resolve, reject) => {
      let out = "";
      let err = "";
      launcher.stdout?.on("data", (chunk) => {
        out += String(chunk);
      });
      launcher.stderr?.on("data", (chunk) => {
        err += String(chunk);
      });
      launcher.once("error", reject);
      launcher.once("close", (code) => {
        resolve([code, out.trim(), err.trim()]);
      });
    });
    const [forgedRaw, fork1Raw] = stdout.split(/\s+/u);
    const forged = Number.parseInt(forgedRaw ?? "", 10);
    const fork1 = Number.parseInt(fork1Raw ?? "", 10);
    try {
      expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
      expect(Number.isInteger(forged) && forged > 1).toBe(true);
      expect(Number.isInteger(fork1) && fork1 > 1).toBe(true);
      skip(
        !(await nonDumpable(forged)),
        "the kernel lets this user read it",
      );
      const status = await hostProc.readFile(`/proc/${forged}/status`);
      const ppidMatch = /^PPid:\s+(\d+)$/mu.exec(status);
      expect(ppidMatch).not.toBeNull();
      const ppid = Number.parseInt(ppidMatch?.[1] ?? "", 10);
      expect(ppid).toBeGreaterThan(0);
      expect(ppid).not.toBe(fork1);
      const only: ProcReader = {
        ...hostProc,
        readdir: async (target) =>
          target === "/proc" ? ["self", String(forged)] : hostProc.readdir(target),
      };
      const scan = await scanLinux(directory, only);
      expect(scan.status).not.toBe("clear");
      expect(scan).toMatchObject({
        status: "unknown",
        blockingProcesses: expect.arrayContaining([
          expect.objectContaining({ pid: forged }),
        ]),
        reason: expect.stringContaining(
          `process ${forged} (ssh-agent) has an unreadable holder path`,
        ),
      });
    } finally {
      if (Number.isInteger(forged) && forged > 1) {
        try {
          process.kill(forged, "SIGKILL");
        } catch {
        }
      }
    }
  });
});

describe("a faked non-dumpable sshd-session", () => {
  const denied = (): never => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  };

  function sessionProc(options: {
    aliasCwd?: string;
    parentUids?: string;
  }): ProcReader {
    const base = mountAliasProc("/work/tree", "plain", 1000);
    const own = (target: string) => target.startsWith("/proc/101/");
    return {
      ...base,
      readlink: async (target) => {
        if (options.aliasCwd !== undefined && target === "/proc/101/cwd")
          return options.aliasCwd;
        return own(target) ? denied() : base.readlink(target);
      },
      readdir: async (target) =>
        own(target) ? denied() : base.readdir(target),
      statId: async (target) => (own(target) ? denied() : base.statId(target)),
      statAccess: async (target) =>
        target === "/proc/101/fd"
          ? { uid: 0, gid: 0, mode: 0o40500 }
          : base.statAccess(target),
      readFile: async (target) => {
        if (target === "/proc/101/status")
          return "Name:\tsshd-session\nState:\tS (sleeping)\nPPid:\t200\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n";
        if (target === "/proc/200/status")
          return `Name:\tsshd-session\nState:\tS (sleeping)\nPPid:\t1\nUid:\t${options.parentUids ?? "0\t0\t0\t0"}\nGid:\t0\t0\t0\t0\n`;
        if (target === "/proc/101/comm" || target === "/proc/200/comm")
          return "sshd-session\n";
        return own(target) ? denied() : base.readFile(target);
      },
    };
  }

  it("clears one whose parent is a root-owned sshd-session", async () => {
    expect(await scanLinux("/work/tree", sessionProc({}), 4242)).toMatchObject({
      status: "clear",
    });
  });

  it("keeps the worktree when its parent is owned by our uid", async () => {
    expect(
      await scanLinux(
        "/work/tree",
        sessionProc({ parentUids: "1000\t1000\t1000\t1000" }),
        4242,
      ),
    ).toMatchObject({
      status: "unknown",
      blockingProcesses: [{ pid: 101 }],
      reason: expect.stringContaining(
        "process 101 (sshd-session) has an unreadable holder path",
      ),
    });
  });

  it("reports it as held when the mount alias scan finds its working folder in the worktree", async () => {
    expect(
      await scanLinux(
        "/work/tree",
        sessionProc({ aliasCwd: "/work/tree" }),
        4242,
      ),
    ).toMatchObject({
      status: "held",
      holders: [{ pid: 101, through: "working folder" }],
    });
  });
});

describe("faked session processes (systemd, (sd-pam), ssh-agent)", () => {
  const denied = (): never => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  };

  interface AncestorSpec {
    pid: number;
    comm: string;
    ppid: number;
    uids: string;
    gids?: string;
    capPrm?: string;
    startTicks?: number | null;
  }

  interface SessionCase {
    comm: string;
    ppid: number;
    uids?: string;
    gids?: string;
    ownGroups?: string;
    capPrm?: string;
    ownCapPrm?: string | null;
    fdOwner?: number;
    startTicks?: number | null;
    sshAgentBinary?:
      | { uid: number; gid: number; mode: number }
      | "missing"
      | "error";
    ancestors?: readonly AncestorSpec[];
    aliasCwd?: string;
  }

  function fakeStat(pid: number, comm: string, ppid: number, startTicks: number): string {
    return `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194624 0 0 0 0 0 0 0 0 20 0 1 0 ${startTicks} 0 0 0`;
  }

  const validSystemdParent: AncestorSpec = {
    pid: 200,
    comm: "systemd",
    ppid: 1,
    uids: "1000\t1000\t1000\t1000",
    capPrm: "0000000800000000",
    startTicks: 174,
  };

  const validSshdUserParent: AncestorSpec = {
    pid: 200,
    comm: "sshd-session",
    ppid: 201,
    uids: "1000\t1000\t1000\t1000",
    capPrm: "0000000000000000",
  };

  const validSshdRootParent: AncestorSpec = {
    pid: 201,
    comm: "sshd-session",
    ppid: 1,
    uids: "0\t0\t0\t0",
    capPrm: "000001ffffffffff",
  };

  function buildProc(spec: SessionCase): ProcReader {
    const base = mountAliasProc("/work/tree", "plain", 1000);
    const own = (target: string) => target.startsWith("/proc/101/");
    const ancestors = new Map(
      (spec.ancestors ?? []).map((entry) => [entry.pid, entry]),
    );
    return {
      ...base,
      readlink: async (target) => {
        if (spec.aliasCwd !== undefined && target === "/proc/101/cwd")
          return spec.aliasCwd;
        return own(target) ? denied() : base.readlink(target);
      },
      readdir: async (target) =>
        own(target) ? denied() : base.readdir(target),
      statId: async (target) => (own(target) ? denied() : base.statId(target)),
      statAccess: async (target) => {
        if (target === "/proc/101/fd")
          return { uid: spec.fdOwner ?? 0, gid: 0, mode: 0o40500 };
        if (target === "/usr/bin/ssh-agent") {
          const binary = spec.sshAgentBinary ?? {
            uid: 0,
            gid: 102,
            mode: 0o102755,
          };
          if (binary === "missing")
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          if (binary === "error")
            throw Object.assign(new Error("io error"), { code: "EIO" });
          return binary;
        }
        return base.statAccess(target);
      },
      readFile: async (target) => {
        if (target === "/proc/self/status") {
          const cap =
            spec.ownCapPrm === null
              ? ""
              : `CapPrm:\t${spec.ownCapPrm ?? "0000000000000000"}\n`;
          const groups = spec.ownGroups ?? "4 24 27 30 46 100 1000";
          return `NSpid:\t4242\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t${groups}\n${cap}`;
        }
        if (target === "/proc/101/status") {
          const uids = spec.uids ?? "1000\t1000\t1000\t1000";
          const gids = spec.gids ?? "1000\t1000\t1000\t1000";
          const cap = spec.capPrm ?? "0000000000000000";
          return `Name:\t${spec.comm}\nState:\tS (sleeping)\nPPid:\t${spec.ppid}\nUid:\t${uids}\nGid:\t${gids}\nCapPrm:\t${cap}\n`;
        }
        if (target === "/proc/101/comm") return `${spec.comm}\n`;
        if (target === "/proc/101/stat") {
          if (spec.startTicks === null) return denied();
          return fakeStat(101, spec.comm, spec.ppid, spec.startTicks ?? 176);
        }
        const match = /^\/proc\/(\d+)\/(status|comm|stat)$/u.exec(target);
        if (match !== null) {
          const entry = ancestors.get(Number(match[1]));
          if (entry !== undefined) {
            if (match[2] === "comm") return `${entry.comm}\n`;
            if (match[2] === "stat") {
              if (entry.startTicks === null) return denied();
              return fakeStat(
                entry.pid,
                entry.comm,
                entry.ppid,
                entry.startTicks ?? 174,
              );
            }
            const cap = entry.capPrm ?? "0000000000000000";
            const gids = entry.gids ?? "1000\t1000\t1000\t1000";
            return `Name:\t${entry.comm}\nState:\tS (sleeping)\nPPid:\t${entry.ppid}\nUid:\t${entry.uids}\nGid:\t${gids}\nCapPrm:\t${cap}\n`;
          }
        }
        return own(target) ? denied() : base.readFile(target);
      },
    };
  }

  it.for([
    [
      "systemd with wake-alarm only and parent pid 1",
      "clear",
      {
        comm: "systemd",
        ppid: 1,
        capPrm: "0000000800000000",
        fdOwner: 1000,
      },
    ],
    [
      "systemd lookalike name systemdx",
      "unknown",
      {
        comm: "systemdx",
        ppid: 1,
        capPrm: "0000000800000000",
        fdOwner: 1000,
      },
    ],
    [
      "systemd prefix name system",
      "unknown",
      {
        comm: "system",
        ppid: 1,
        capPrm: "0000000800000000",
        fdOwner: 1000,
      },
    ],
    [
      "systemd with saved uid root",
      "unknown",
      {
        comm: "systemd",
        ppid: 1,
        uids: "1000\t1000\t0\t1000",
        capPrm: "0000000800000000",
        fdOwner: 1000,
      },
    ],
    [
      "systemd with non-1 parent",
      "unknown",
      {
        comm: "systemd",
        ppid: 200,
        capPrm: "0000000800000000",
        fdOwner: 1000,
      },
    ],
    [
      "systemd with an extra capability bit beyond wake-alarm",
      "unknown",
      {
        comm: "systemd",
        ppid: 1,
        capPrm: "0000000800000001",
        fdOwner: 1000,
      },
    ],
    [
      "systemd with a non-wake-alarm capability bit",
      "unknown",
      {
        comm: "systemd",
        ppid: 1,
        capPrm: "0000000000000002",
        fdOwner: 1000,
      },
    ],
    [
      "systemd that is dumpable without exceeding capabilities",
      "unknown",
      {
        comm: "systemd",
        ppid: 1,
        capPrm: "0000000000000000",
        fdOwner: 1000,
      },
    ],
    [
      "systemd that is non-dumpable without wake-alarm",
      "unknown",
      {
        comm: "systemd",
        ppid: 1,
        capPrm: "0000000000000000",
        fdOwner: 0,
      },
    ],
    [
      "systemd when daemon capabilities are unreadable",
      "unknown",
      {
        comm: "systemd",
        ppid: 1,
        capPrm: "0000000800000000",
        ownCapPrm: null,
        fdOwner: 1000,
      },
    ],
    [
      "(sd-pam) non-dumpable under user systemd",
      "clear",
      {
        comm: "(sd-pam)",
        ppid: 200,
        fdOwner: 0,
        startTicks: 176,
        ancestors: [validSystemdParent],
      },
    ],
    [
      "(sd-pam) at lower start window edge (0 ticks after systemd)",
      "clear",
      {
        comm: "(sd-pam)",
        ppid: 200,
        fdOwner: 0,
        startTicks: 174,
        ancestors: [validSystemdParent],
      },
    ],
    [
      "(sd-pam) before lower start window edge (-1 tick before systemd)",
      "unknown",
      {
        comm: "(sd-pam)",
        ppid: 200,
        fdOwner: 0,
        startTicks: 173,
        ancestors: [validSystemdParent],
      },
    ],
    [
      "(sd-pam) at upper start window edge (200 ticks after systemd)",
      "clear",
      {
        comm: "(sd-pam)",
        ppid: 200,
        fdOwner: 0,
        startTicks: 374,
        ancestors: [validSystemdParent],
      },
    ],
    [
      "(sd-pam) past upper start window edge (201 ticks after systemd)",
      "unknown",
      {
        comm: "(sd-pam)",
        ppid: 200,
        fdOwner: 0,
        startTicks: 375,
        ancestors: [validSystemdParent],
      },
    ],
    [
      "forged (sd-pam) under user systemd started 5 seconds later",
      "unknown",
      {
        comm: "(sd-pam)",
        ppid: 200,
        fdOwner: 0,
        startTicks: 674,
        ancestors: [validSystemdParent],
      },
    ],
    [
      "(sd-pam) with unreadable stat",
      "unknown",
      {
        comm: "(sd-pam)",
        ppid: 200,
        fdOwner: 0,
        startTicks: null,
        ancestors: [validSystemdParent],
      },
    ],
    [
      "(sd-pam) whose systemd parent has unreadable stat",
      "unknown",
      {
        comm: "(sd-pam)",
        ppid: 200,
        fdOwner: 0,
        startTicks: 176,
        ancestors: [{ ...validSystemdParent, startTicks: null }],
      },
    ],
    [
      "(sd-pam) lookalike name (sd-pam)x",
      "unknown",
      {
        comm: "(sd-pam)x",
        ppid: 200,
        fdOwner: 0,
        startTicks: 176,
        ancestors: [validSystemdParent],
      },
    ],
    [
      "(sd-pam) with saved uid root",
      "unknown",
      {
        comm: "(sd-pam)",
        ppid: 200,
        uids: "1000\t1000\t0\t1000",
        fdOwner: 0,
        startTicks: 176,
        ancestors: [validSystemdParent],
      },
    ],
    [
      "(sd-pam) whose parent is a lookalike systemd",
      "unknown",
      {
        comm: "(sd-pam)",
        ppid: 200,
        fdOwner: 0,
        startTicks: 176,
        ancestors: [{ ...validSystemdParent, comm: "systemdx" }],
      },
    ],
    [
      "(sd-pam) whose systemd parent has a non-1 parent",
      "unknown",
      {
        comm: "(sd-pam)",
        ppid: 200,
        fdOwner: 0,
        startTicks: 176,
        ancestors: [{ ...validSystemdParent, ppid: 300 }],
      },
    ],
    [
      "(sd-pam) whose systemd parent has wrong uid",
      "unknown",
      {
        comm: "(sd-pam)",
        ppid: 200,
        fdOwner: 0,
        startTicks: 176,
        ancestors: [{ ...validSystemdParent, uids: "0\t0\t0\t0" }],
      },
    ],
    [
      "(sd-pam) whose systemd parent lacks wake-alarm",
      "unknown",
      {
        comm: "(sd-pam)",
        ppid: 200,
        fdOwner: 0,
        startTicks: 176,
        ancestors: [{ ...validSystemdParent, capPrm: "0000000000000000" }],
      },
    ],
    [
      "(sd-pam) whose systemd parent has an extra capability bit",
      "unknown",
      {
        comm: "(sd-pam)",
        ppid: 200,
        fdOwner: 0,
        startTicks: 176,
        ancestors: [{ ...validSystemdParent, capPrm: "0000000800000001" }],
      },
    ],
    [
      "(sd-pam) whose parent cannot be read",
      "unknown",
      {
        comm: "(sd-pam)",
        ppid: 200,
        fdOwner: 0,
        startTicks: 176,
      },
    ],
    [
      "(sd-pam) that is dumpable",
      "unknown",
      {
        comm: "(sd-pam)",
        ppid: 200,
        fdOwner: 1000,
        startTicks: 176,
        ancestors: [validSystemdParent],
      },
    ],
    [
      "(sd-pam) whose capabilities exceed the daemon",
      "unknown",
      {
        comm: "(sd-pam)",
        ppid: 200,
        capPrm: "0000000800000000",
        fdOwner: 0,
        startTicks: 176,
        ancestors: [validSystemdParent],
      },
    ],
    [
      "ssh-agent non-dumpable with parent pid 1 and saved gid _ssh",
      "clear",
      {
        comm: "ssh-agent",
        ppid: 1,
        gids: "1000\t1000\t102\t1000",
        fdOwner: 0,
      },
    ],
    [
      "ssh-agent non-dumpable under user systemd",
      "clear",
      {
        comm: "ssh-agent",
        ppid: 200,
        gids: "1000\t1000\t102\t1000",
        fdOwner: 0,
        ancestors: [validSystemdParent],
      },
    ],
    [
      "ssh-agent non-dumpable under valid sshd-session",
      "clear",
      {
        comm: "ssh-agent",
        ppid: 200,
        gids: "1000\t1000\t102\t1000",
        fdOwner: 0,
        ancestors: [validSshdUserParent, validSshdRootParent],
      },
    ],
    [
      "forged ssh-agent (saved GID = real GID) with parent 1",
      "unknown",
      {
        comm: "ssh-agent",
        ppid: 1,
        gids: "1000\t1000\t1000\t1000",
        fdOwner: 0,
      },
    ],
    [
      "forged ssh-agent (saved GID = real GID) under user systemd",
      "unknown",
      {
        comm: "ssh-agent",
        ppid: 200,
        gids: "1000\t1000\t1000\t1000",
        fdOwner: 0,
        ancestors: [validSystemdParent],
      },
    ],
    [
      "forged ssh-agent (saved GID = real GID) under valid sshd-session",
      "unknown",
      {
        comm: "ssh-agent",
        ppid: 200,
        gids: "1000\t1000\t1000\t1000",
        fdOwner: 0,
        ancestors: [validSshdUserParent, validSshdRootParent],
      },
    ],
    [
      "forged ssh-agent (different foreign saved GID 103 != binary gid 102) with parent 1",
      "unknown",
      {
        comm: "ssh-agent",
        ppid: 1,
        gids: "1000\t1000\t103\t1000",
        fdOwner: 0,
      },
    ],
    [
      "forged ssh-agent (different foreign saved GID 103 != binary gid 102) under user systemd",
      "unknown",
      {
        comm: "ssh-agent",
        ppid: 200,
        gids: "1000\t1000\t103\t1000",
        fdOwner: 0,
        ancestors: [validSystemdParent],
      },
    ],
    [
      "forged ssh-agent (different foreign saved GID 103 != binary gid 102) under valid sshd-session",
      "unknown",
      {
        comm: "ssh-agent",
        ppid: 200,
        gids: "1000\t1000\t103\t1000",
        fdOwner: 0,
        ancestors: [validSshdUserParent, validSshdRootParent],
      },
    ],
    [
      "ssh-agent when /usr/bin/ssh-agent is missing",
      "unknown",
      {
        comm: "ssh-agent",
        ppid: 1,
        gids: "1000\t1000\t102\t1000",
        fdOwner: 0,
        sshAgentBinary: "missing",
      },
    ],
    [
      "ssh-agent when /usr/bin/ssh-agent is not setgid",
      "unknown",
      {
        comm: "ssh-agent",
        ppid: 1,
        gids: "1000\t1000\t102\t1000",
        fdOwner: 0,
        sshAgentBinary: { uid: 0, gid: 102, mode: 0o100755 },
      },
    ],
    [
      "ssh-agent when /usr/bin/ssh-agent is not root-owned",
      "unknown",
      {
        comm: "ssh-agent",
        ppid: 1,
        gids: "1000\t1000\t102\t1000",
        fdOwner: 0,
        sshAgentBinary: { uid: 1000, gid: 102, mode: 0o102755 },
      },
    ],
    [
      "ssh-agent when /usr/bin/ssh-agent is not a regular file",
      "unknown",
      {
        comm: "ssh-agent",
        ppid: 1,
        gids: "1000\t1000\t102\t1000",
        fdOwner: 0,
        sshAgentBinary: { uid: 0, gid: 102, mode: 0o042755 },
      },
    ],
    [
      "ssh-agent when stat on /usr/bin/ssh-agent fails",
      "unknown",
      {
        comm: "ssh-agent",
        ppid: 1,
        gids: "1000\t1000\t102\t1000",
        fdOwner: 0,
        sshAgentBinary: "error",
      },
    ],
    [
      "ssh-agent whose saved GID is in the daemon's groups",
      "unknown",
      {
        comm: "ssh-agent",
        ppid: 1,
        gids: "1000\t1000\t27\t1000",
        ownGroups: "4 24 27 30 46 100 1000",
        fdOwner: 0,
        sshAgentBinary: { uid: 0, gid: 27, mode: 0o102755 },
      },
    ],
    [
      "ssh-agent lookalike name ssh-agent-fake",
      "unknown",
      {
        comm: "ssh-agent-fake",
        ppid: 1,
        gids: "1000\t1000\t102\t1000",
        fdOwner: 0,
      },
    ],
    [
      "ssh-agent with saved uid root",
      "unknown",
      {
        comm: "ssh-agent",
        ppid: 1,
        uids: "1000\t1000\t0\t1000",
        gids: "1000\t1000\t102\t1000",
        fdOwner: 0,
      },
    ],
    [
      "ssh-agent with bash parent",
      "unknown",
      {
        comm: "ssh-agent",
        ppid: 200,
        gids: "1000\t1000\t102\t1000",
        fdOwner: 0,
        ancestors: [
          {
            pid: 200,
            comm: "bash",
            ppid: 1,
            uids: "1000\t1000\t1000\t1000",
          },
        ],
      },
    ],
    [
      "ssh-agent with lookalike systemd parent",
      "unknown",
      {
        comm: "ssh-agent",
        ppid: 200,
        gids: "1000\t1000\t102\t1000",
        fdOwner: 0,
        ancestors: [{ ...validSystemdParent, comm: "systemdx" }],
      },
    ],
    [
      "ssh-agent whose sshd-session parent has a non-root parent",
      "unknown",
      {
        comm: "ssh-agent",
        ppid: 200,
        gids: "1000\t1000\t102\t1000",
        fdOwner: 0,
        ancestors: [
          validSshdUserParent,
          { ...validSshdRootParent, uids: "1000\t1000\t1000\t1000" },
        ],
      },
    ],
    [
      "ssh-agent whose parent cannot be read",
      "unknown",
      {
        comm: "ssh-agent",
        ppid: 200,
        gids: "1000\t1000\t102\t1000",
        fdOwner: 0,
      },
    ],
    [
      "ssh-agent that is dumpable",
      "unknown",
      {
        comm: "ssh-agent",
        ppid: 1,
        gids: "1000\t1000\t102\t1000",
        fdOwner: 1000,
      },
    ],
    [
      "ssh-agent whose capabilities exceed the daemon",
      "unknown",
      {
        comm: "ssh-agent",
        ppid: 1,
        gids: "1000\t1000\t102\t1000",
        capPrm: "0000000800000000",
        fdOwner: 0,
      },
    ],
  ] as const)("%s -> %s", async ([, expected, spec]) => {
    const scan = await scanLinux("/work/tree", buildProc(spec), 4242);
    if (expected === "clear") {
      expect(scan).toMatchObject({ status: "clear" });
      return;
    }
    expect(scan).toMatchObject({
      status: "unknown",
      blockingProcesses: [{ pid: 101 }],
      reason: expect.stringContaining(
        `process 101 (${spec.comm}) has an unreadable holder path`,
      ),
    });
  });

  it.for([
    [
      "systemd",
      {
        comm: "systemd",
        ppid: 1,
        capPrm: "0000000800000000",
        fdOwner: 1000,
        aliasCwd: "/work/tree",
      },
    ],
    [
      "(sd-pam)",
      {
        comm: "(sd-pam)",
        ppid: 200,
        fdOwner: 0,
        startTicks: 176,
        ancestors: [validSystemdParent],
        aliasCwd: "/work/tree",
      },
    ],
    [
      "ssh-agent",
      {
        comm: "ssh-agent",
        ppid: 1,
        gids: "1000\t1000\t102\t1000",
        fdOwner: 0,
        aliasCwd: "/work/tree",
      },
    ],
  ] as const)(
    "reports %s as held when the mount alias scan finds its working folder in the worktree",
    async ([, spec]) => {
      expect(
        await scanLinux("/work/tree", buildProc(spec), 4242),
      ).toMatchObject({
        status: "held",
        holders: [{ pid: 101, through: "working folder" }],
      });
    },
  );
});
