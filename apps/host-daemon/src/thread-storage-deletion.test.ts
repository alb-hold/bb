import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { makeDispatchOptions } from "../test/command/dispatch-helpers.js";
import {
  dispatchCommand,
  dispatchOnlineRpcCommand,
} from "./command-dispatch.js";
import { RuntimeManager } from "./runtime-manager.js";
import { hostProc, useProcReaderForTests } from "@bb/process-utils";

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
