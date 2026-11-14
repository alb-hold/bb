import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
