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
      "clear",
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
    ["path prefix sibling", "/work/tree-other", "8:48", "mnt:[2]", "clear"],
    ["same namespace unreadable mounts", null, null, "mnt:[1]", "uncertain"],
    ["ancestor mount", "/work", "8:48", "mnt:[2]", "uncertain"],
    ["different filesystem", "/", "0:95", "mnt:[2]", "clear"],
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
