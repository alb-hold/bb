import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
    expect(mapLsofError(error, "stdout", "first stderr line\nsecond line"))
      .toMatchObject({
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
