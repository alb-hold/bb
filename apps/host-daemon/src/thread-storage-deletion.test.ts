import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { makeDispatchOptions } from "../test/command/dispatch-helpers.js";
import {
  dispatchCommand,
  dispatchOnlineRpcCommand,
} from "./command-dispatch.js";
import { RuntimeManager } from "./runtime-manager.js";
import { hostProc, useProcReaderForTests } from "@bb/process-utils";
import { FILE_TIMESTAMP_LAG_MS } from "bb-environment-provider-host/remove-directory-tree";

it.for(["thread deletion", "orphan removal"] as const)(
  "%s refuses live holders and uninspectable neighbors, stops nothing, and removes the folder after they exit",
  async (cleanup, { skip }) => {
    skip(
      process.platform === "win32",
      "process working directories are not enumerated on Windows",
    );
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "bb-storage-delete-")),
    );
    const storageRoot = path.join(root, "thread-storage");
    const storagePath = path.join(storageRoot, "thr_busy");
    const checkout = path.join(storagePath, "checkout", "app");
    const neighbor = path.join(storageRoot, "thr_busy-other");
    await fs.mkdir(checkout, { recursive: true });
    await fs.mkdir(neighbor, { recursive: true });
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000); process.send('ready');"],
      {
        cwd: checkout,
        detached: true,
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      },
    );
    const sibling = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000); process.send('ready');"],
      {
        cwd: neighbor,
        detached: true,
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      },
    );
    const childReady = once(child, "message");
    const siblingReady = once(sibling, "message");
    try {
      await Promise.all([childReady, siblingReady]);
      useProcReaderForTests({
        ...hostProc,
        readdir: async (name) =>
          name === "/proc"
            ? [
                String(process.pid),
                ...(child.pid === undefined ? [] : [String(child.pid)]),
                ...(sibling.pid === undefined ? [] : [String(sibling.pid)]),
              ]
            : hostProc.readdir(name),
        statId: async (name) => {
          if (name === `/proc/${sibling.pid}/cwd`)
            throw Object.assign(new Error("unreadable neighbor identity"), {
              code: "EACCES",
            });
          return hostProc.statId(name);
        },
      });
      const options = makeDispatchOptions({
        runtimeManager: new RuntimeManager(),
        threadStorageRootPath: storageRoot,
      });
      const run = () =>
        cleanup === "thread deletion"
          ? dispatchCommand(
              {
                type: "thread.storage.delete",
                threadId: "thr_busy",
                environmentId: "env_busy",
              },
              options,
            )
          : dispatchOnlineRpcCommand(
              {
                type: "host.remove_path",
                path: storagePath,
                rootPath: storageRoot,
                recursive: true,
              },
              options,
              new AbortController().signal,
            );
      await expect(run()).rejects.toThrow(
        /still working inside|still using it/,
      );
      await expect(fs.stat(checkout)).resolves.toMatchObject({});
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(sibling.exitCode).toBeNull();
      expect(sibling.signalCode).toBeNull();
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      if (process.platform === "linux") {
        await expect(run()).rejects.toThrow(/could not be established/);
        await expect(fs.stat(checkout)).resolves.toMatchObject({});
        expect(sibling.exitCode).toBeNull();
        expect(sibling.signalCode).toBeNull();
        const siblingExited = once(sibling, "exit");
        sibling.kill("SIGKILL");
        await siblingExited;
      }
      await delay(FILE_TIMESTAMP_LAG_MS + 50);
      await run();
      await expect(fs.stat(storagePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      if (process.platform !== "linux") {
        expect(sibling.exitCode).toBeNull();
        expect(sibling.signalCode).toBeNull();
      }
      await expect(fs.stat(neighbor)).resolves.toMatchObject({});
    } finally {
      useProcReaderForTests(null);
      await Promise.all(
        [child, sibling].map(async (running) => {
          if (running.exitCode !== null || running.signalCode !== null) return;
          const exited = once(running, "exit");
          running.kill("SIGKILL");
          await exited;
        }),
      );
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

async function storageFixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bb-storage-canonical-")),
  );
  const real = path.join(root, "real");
  await fs.mkdir(path.join(real, "thread-storage"), { recursive: true });
  await fs.symlink(real, path.join(root, "linked"));
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "kept.txt"), "kept\n");
  return { root, real, outside };
}

async function deleteStorage(threadId: string, threadStorageRootPath: string) {
  return await dispatchCommand(
    { type: "thread.storage.delete", threadId, environmentId: "env_link" },
    makeDispatchOptions({
      runtimeManager: new RuntimeManager(),
      threadStorageRootPath,
    }),
  );
}

function useOnlyTheseProcessesForTests(
  pids: number[] = [],
  isolatedMounts: string | null = null,
) {
  useProcReaderForTests({
    ...hostProc,
    readdir: async (name) =>
      name === "/proc"
        ? [String(process.pid), ...pids.map(String)]
        : hostProc.readdir(name),
    readFile: async (name) =>
      isolatedMounts !== null &&
      pids.some((pid) => name === `/proc/${pid}/mountinfo`)
        ? isolatedMounts
        : hostProc.readFile(name),
  });
}

function mountNamespacesAvailable(): boolean {
  if (process.platform !== "linux") return false;
  try {
    execFileSync("unshare", ["--user", "--map-root-user", "--mount", "true"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

it("deletes a thread's storage when the storage root is reached through a symbolic link, with a process in another mount namespace that cannot see it", async ({
  skip,
}) => {
  skip(
    !mountNamespacesAvailable(),
    "the scan checks the worktree's path against other mount namespaces on Linux only",
  );
  const { root, real } = await storageFixture();
  const storagePath = path.join(real, "thread-storage", "thr_linked");
  await fs.mkdir(path.join(storagePath, "checkout"), { recursive: true });
  await fs.writeFile(path.join(storagePath, "checkout", "a.txt"), "a\n");
  await delay(FILE_TIMESTAMP_LAG_MS + 50);
  const isolated = spawn(
    "unshare",
    ["--user", "--map-current-user", "--mount", "sleep", "60"],
    { cwd: root, stdio: "ignore" },
  );
  for (let wait = 0; wait < 100; wait++) {
    const own = await fs.readlink("/proc/self/ns/mnt");
    const theirs = await fs
      .readlink(`/proc/${isolated.pid}/ns/mnt`)
      .catch(() => own);
    if (theirs !== own) break;
    await delay(20);
  }
  useOnlyTheseProcessesForTests(
    isolated.pid === undefined ? [] : [isolated.pid],
    "900 1 0:900 / / rw - tmpfs tmpfs rw\n",
  );
  try {
    await deleteStorage(
      "thr_linked",
      path.join(root, "linked", "thread-storage"),
    );
    await expect(fs.lstat(storagePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.readdir(path.join(real, "thread-storage")),
    ).resolves.toEqual([]);
  } finally {
    useProcReaderForTests(null);
    const exited = once(isolated, "exit");
    isolated.kill("SIGKILL");
    await exited;
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.for([
  ["a directory outside the storage root", "outside"],
  ["another thread's directory", "sibling"],
] as const)(
  "refuses a thread's storage path that is a symbolic link to %s, and removes nothing",
  async ([_label, kind]) => {
    const { root, real, outside } = await storageFixture();
    const storageRoot = path.join(real, "thread-storage");
    const sibling = path.join(storageRoot, "thr_other");
    await fs.mkdir(sibling);
    await fs.writeFile(path.join(sibling, "kept.txt"), "kept\n");
    const target = kind === "outside" ? outside : sibling;
    const link = path.join(storageRoot, "thr_link");
    await fs.symlink(target, link);
    await delay(FILE_TIMESTAMP_LAG_MS + 50);
    useOnlyTheseProcessesForTests();
    try {
      await expect(
        deleteStorage("thr_link", storageRoot),
      ).rejects.toMatchObject({ code: "invalid_path" });
      await expect(fs.readlink(link)).resolves.toBe(target);
      await expect(
        fs.readFile(path.join(target, "kept.txt"), "utf8"),
      ).resolves.toBe("kept\n");
      await expect(fs.readdir(storageRoot)).resolves.toEqual(
        ["thr_link", "thr_other"].sort(),
      );
    } finally {
      useProcReaderForTests(null);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it("treats a storage root that does not exist as already deleted", async () => {
  const { root } = await storageFixture();
  try {
    await expect(
      deleteStorage("thr_gone", path.join(root, "missing", "thread-storage")),
    ).resolves.toBeDefined();
    await expect(fs.readdir(root)).resolves.toEqual(
      ["linked", "outside", "real"].sort(),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
