import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FILE_TIMESTAMP_LAG_MS } from "bb-environment-provider-host/remove-directory-tree";
import { hostProc,useProcReaderForTests } from "@bb/process-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFsProbesForTests } from "./bounded-fs.js";
import { moveHostPath, removeHostPath } from "./path-mutations.js";

const removalContext = {
  dataDir: "/nonexistent/bb-hang-data",
  threadStorageRootPath: "/nonexistent/bb-hang-storage",
  runtimeManager: { listLoadedWorkspacePaths: () => [] },
};
const DEADLINE_MS = 80;
const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bb-path-hang-")),
  );
  roots.push(root);
  return root;
}

function remove(target: string, rootPath?: string) {
  return removeHostPath(
    { type: "host.remove_path", path: target, rootPath, recursive: true },
    removalContext,
  );
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function hangFsCall(name: "lstat" | "realpath", hungPath: string): void {
  useFsProbesForTests({ deadlineMs: DEADLINE_MS });
  const original: (target: string) => Promise<unknown> = fs[name].bind(fs);
  vi.spyOn(fs, name).mockImplementation(((target: string) =>
    target === hungPath ? never() : original(target)) as never);
}

beforeEach(() => {
  useProcReaderForTests({
    ...hostProc,
    readdir: async (name) =>
      name === "/proc" ? [String(process.pid)] : hostProc.readdir(name),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  useProcReaderForTests(null);
  useFsProbesForTests(null);
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("host path checks against a filesystem that does not answer", () => {
  it("removes a file and a folder normally under the bounded checks", async () => {
    const root = await makeRoot();
    const file = path.join(root, "file.txt");
    const folder = path.join(root, "folder");
    await fs.writeFile(file, "x");
    await fs.mkdir(path.join(folder, "inner"), { recursive: true });
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    await expect(remove(file, root)).resolves.toEqual({ ok: true });
    await expect(remove(folder, root)).resolves.toEqual({ ok: true });
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(folder)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a removal whose first lstat never answers, within the deadline, touching nothing", async () => {
    const root = await makeRoot();
    const file = path.join(root, "file.txt");
    await fs.writeFile(file, "keep");
    useFsProbesForTests({ lstat: () => never(), deadlineMs: DEADLINE_MS });
    const started = Date.now();
    await expect(remove(file, root)).rejects.toMatchObject({
      code: "path_in_use",
      message: expect.stringContaining("nothing was changed"),
    });
    expect(Date.now() - started).toBeLessThan(DEADLINE_MS * 20);
    useFsProbesForTests(null);
    expect(await fs.readFile(file, "utf8")).toBe("keep");
  });

  it("refuses a removal whose realpath never answers, touching nothing", async () => {
    const root = await makeRoot();
    const folder = path.join(root, "folder");
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, "keep.txt"), "keep");
    hangFsCall("realpath", folder);
    await expect(remove(folder, root)).rejects.toMatchObject({
      code: "path_in_use",
    });
    useFsProbesForTests(null);
    expect(await fs.readFile(path.join(folder, "keep.txt"), "utf8")).toBe(
      "keep",
    );
  });

  it("refuses a removal whose declared root lstat never answers", async () => {
    const root = await makeRoot();
    const file = path.join(root, "file.txt");
    await fs.writeFile(file, "keep");
    hangFsCall("lstat", root);
    await expect(remove(file, root)).rejects.toMatchObject({
      code: "path_in_use",
    });
    useFsProbesForTests(null);
    expect(await fs.readFile(file, "utf8")).toBe("keep");
  });

  it("refuses a removal whose declared root realpath never answers", async () => {
    const root = await makeRoot();
    const file = path.join(root, "file.txt");
    await fs.writeFile(file, "keep");
    hangFsCall("realpath", root);
    await expect(remove(file, root)).rejects.toMatchObject({
      code: "path_in_use",
    });
    useFsProbesForTests(null);
    expect(await fs.readFile(file, "utf8")).toBe("keep");
  });

  it("refuses a removal whose second lstat never answers and never reaches rm", async () => {
    const root = await makeRoot();
    const file = path.join(root, "file.txt");
    await fs.writeFile(file, "keep");
    let calls = 0;
    useFsProbesForTests({
      lstat: (target) => {
        calls += 1;
        return calls <= 1 ? fs.lstat(target) : never();
      },
      deadlineMs: DEADLINE_MS,
    });
    await expect(remove(file)).rejects.toMatchObject({ code: "path_in_use" });
    useFsProbesForTests(null);
    expect(await fs.readFile(file, "utf8")).toBe("keep");
  });

  it("refuses a move whose source never answers and leaves the file in place", async () => {
    const root = await makeRoot();
    const source = path.join(root, "source.txt");
    await fs.writeFile(source, "keep");
    useFsProbesForTests({ lstat: () => never(), deadlineMs: DEADLINE_MS });
    await expect(
      moveHostPath({
        type: "host.move_path",
        sourcePath: source,
        destinationPath: path.join(root, "destination.txt"),
        rootPath: root,
      }),
    ).rejects.toMatchObject({ code: "path_in_use" });
    useFsProbesForTests(null);
    expect(await fs.readFile(source, "utf8")).toBe("keep");
    await expect(
      fs.stat(path.join(root, "destination.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("swallows a probe that settles after its deadline instead of raising an unhandled rejection", async () => {
    const root = await makeRoot();
    const file = path.join(root, "file.txt");
    await fs.writeFile(file, "keep");
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      useFsProbesForTests({
        lstat: async () => {
          await delay(DEADLINE_MS * 3);
          throw new Error("late failure");
        },
        deadlineMs: DEADLINE_MS,
      });
      await expect(remove(file, root)).rejects.toMatchObject({
        code: "path_in_use",
      });
      await delay(DEADLINE_MS * 6);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(await fs.readFile(file, "utf8")).toBe("keep");
  });
});

function fuseUnavailableReason(): string | null {
  if (process.platform !== "linux") return "not linux";
  if (!existsSync("/dev/fuse")) return "/dev/fuse is missing";
  if (spawnSync("fuse-overlayfs", ["--version"]).error !== undefined)
    return "fuse-overlayfs is not installed";
  if (
    spawnSync("fusermount3", ["-V"]).error !== undefined &&
    spawnSync("fusermount", ["-V"]).error !== undefined
  )
    return "fusermount is not installed";
  return null;
}

async function mounted(point: string): Promise<boolean> {
  const info = await fs.readFile("/proc/self/mountinfo", "utf8");
  return info.split("\n").some((line) => line.split(" ")[4] === point);
}

function unmount(point: string): void {
  for (const tool of ["fusermount3", "fusermount"]) {
    if (spawnSync(tool, ["-u", "-z", point]).status === 0) return;
  }
}

describe("removal beneath a real stopped FUSE mount", () => {
  const unavailable = fuseUnavailableReason();
  it.skipIf(unavailable !== null)(
    `refuses within the deadline and leaves the file in place while the FUSE daemon is stopped${unavailable === null ? "" : ` (skipped: ${unavailable})`}`,
    async () => {
      const root = await makeRoot();
      const lower = path.join(root, "lower");
      const upper = path.join(root, "upper");
      const work = path.join(root, "work");
      const merged = path.join(root, "merged");
      for (const directory of [lower, upper, work, merged])
        await fs.mkdir(directory);
      await fs.writeFile(path.join(lower, "file.txt"), "keep");
      const daemon = spawn(
        "fuse-overlayfs",
        [
          "-f",
          "-o",
          `lowerdir=${lower},upperdir=${upper},workdir=${work}`,
          merged,
        ],
        { stdio: "ignore" },
      );
      try {
        for (let waited = 0; !(await mounted(merged)); waited += 50) {
          if (waited > 10_000) throw new Error("fuse mount never appeared");
          await delay(50);
        }
        daemon.kill("SIGSTOP");
        useFsProbesForTests({ deadlineMs: 500 });
        const started = Date.now();
        await expect(
          remove(path.join(merged, "file.txt"), merged),
        ).rejects.toMatchObject({ code: "path_in_use" });
        expect(Date.now() - started).toBeLessThan(5000);
        daemon.kill("SIGCONT");
        expect(
          await fs.readFile(path.join(merged, "file.txt"), "utf8"),
        ).toBe("keep");
      } finally {
        daemon.kill("SIGCONT");
        unmount(merged);
        daemon.kill("SIGTERM");
      }
    },
    30_000,
  );
});
