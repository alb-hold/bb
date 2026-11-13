import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hostProc,
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
      if (value === base + "/maps")
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
        ["map stat failure", "uncertain"],
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
