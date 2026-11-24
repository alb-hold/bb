import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FILE_TIMESTAMP_LAG_MS } from "bb-environment-provider-host/remove-directory-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hostProc,
  scanWorktreeHolders,
  useProcReaderForTests,
} from "@bb/process-utils";
import { removeHostPath } from "./path-mutations.js";
import {
  processDoubtsIgnorableForRemoval,
  temporaryTargetOnAnotherMount,
  type TemporaryRemovalContext,
} from "./temporary-removal.js";

const roots: string[] = [];
const processes: ChildProcess[] = [];
const originalTmpdir = process.env.TMPDIR;
const noServerWorkspaces = { protectedPaths: [] };

function context(
  overrides: Partial<TemporaryRemovalContext> & { workspaces?: string[] } = {},
): TemporaryRemovalContext {
  const workspaces = overrides.workspaces ?? [];
  return {
    dataDir: overrides.dataDir ?? "/nonexistent/bb-temporary-removal-data",
    threadStorageRootPath:
      overrides.threadStorageRootPath ??
      "/nonexistent/bb-temporary-removal-storage",
    runtimeManager: { listLoadedWorkspacePaths: () => workspaces },
  };
}

async function makeRoot(): Promise<string> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bb-temporary-removal-")),
  );
  roots.push(root);
  return root;
}

async function startIdle(cwd: string): Promise<number> {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000); process.send('ready');"],
    { cwd, stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  processes.push(child);
  await once(child, "message");
  if (child.pid === undefined) throw new Error("child has no pid");
  return child.pid;
}

function fakeProc(args: { readable: number[]; unreadable: number[] }): void {
  useProcReaderForTests({
    ...hostProc,
    readdir: async (name) =>
      name === "/proc"
        ? [
            String(process.pid),
            ...[...args.readable, ...args.unreadable].map(String),
          ]
        : hostProc.readdir(name),
    statId: async (name) => {
      if (args.unreadable.some((pid) => name === `/proc/${pid}/cwd`))
        throw Object.assign(new Error("unreadable process"), {
          code: "EACCES",
        });
      return hostProc.statId(name);
    },
  });
}

async function bundle(root: string, name: string): Promise<string> {
  const target = path.join(root, name);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "evidence.txt"), "bundle");
  return target;
}

async function expectProcessDoubt(target: string, pid: number): Promise<void> {
  const scan = await scanWorktreeHolders(target);
  expect(scan.status === "uncertain" || scan.status === "unknown").toBe(true);
  expect(
    "blockingProcesses" in scan
      ? scan.blockingProcesses?.map((blocking) => blocking.pid)
      : [],
  ).toContain(pid);
}

async function leftovers(root: string): Promise<string[]> {
  return (await fs.readdir(root)).filter((name) => name.includes(".removing-"));
}

afterEach(async () => {
  vi.restoreAllMocks();
  useProcReaderForTests(null);
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  await Promise.all(
    processes.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }),
  );
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform !== "linux")(
  "removing temporary directories while an unrelated process cannot be inspected",
  () => {
    it("removes a temporary directory when the only doubt is an unreadable process", async () => {
      const root = await makeRoot();
      const target = await bundle(root, "fleet-evidence-stamp");
      const neighbor = await bundle(root, "neighbor");
      const unreadable = await startIdle(neighbor);
      fakeProc({ readable: [], unreadable: [unreadable] });
      await expectProcessDoubt(target, unreadable);
      await delay(FILE_TIMESTAMP_LAG_MS + 50);

      await expect(
        removeHostPath(
          {
            type: "host.remove_path",
            path: target,
            recursive: true,
            temporaryRemoval: noServerWorkspaces,
          },
          context(),
        ),
      ).resolves.toEqual({ ok: true });

      await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(leftovers(root)).resolves.toEqual([]);
      await expect(fs.stat(neighbor)).resolves.toMatchObject({});
      expect(processes[0]?.exitCode).toBeNull();
    });

    it.for([
      "loaded workspace",
      "workspace the server knows",
      "workspace inside the target that the server knows",
      "workspace inside the target",
      "data dir",
      "thread storage",
      "git checkout",
      "git tree below the target",
      "git tree above the target",
      "temporary directory that is a git checkout",
      "temporary directory inside a git checkout",
      "outside the temporary directory",
    ] as const)(
      "still refuses the same doubt for a %s and names the requested path",
      async (kind) => {
        const tmp = await makeRoot();
        const root =
          kind === "outside the temporary directory"
            ? path.join(tmp, "outside")
            : path.join(tmp, "tmp");
        process.env.TMPDIR = path.join(tmp, "tmp");
        await fs.mkdir(process.env.TMPDIR, { recursive: true });
        const parent =
          kind === "git tree above the target" ? path.join(root, "repo") : root;
        const target = await bundle(parent, "bundle");
        if (kind === "git checkout") await fs.mkdir(path.join(target, ".git"));
        if (kind === "git tree below the target")
          await fs.mkdir(path.join(target, "nested", "repo", ".git"), {
            recursive: true,
          });
        if (kind === "git tree above the target")
          await fs.writeFile(path.join(parent, ".git"), "gitdir: elsewhere\n");
        if (kind === "temporary directory that is a git checkout")
          await fs.mkdir(path.join(process.env.TMPDIR, ".git"));
        if (kind === "temporary directory inside a git checkout")
          await fs.writeFile(path.join(tmp, ".git"), "gitdir: elsewhere\n");
        const removal = context(
          kind === "loaded workspace"
            ? { workspaces: [root] }
            : kind === "workspace inside the target"
              ? { workspaces: [path.join(target, "checkout")] }
              : kind === "data dir"
                ? { dataDir: root }
                : kind === "thread storage"
                  ? { threadStorageRootPath: root }
                  : {},
        );
        const temporaryRemoval = {
          protectedPaths:
            kind === "workspace the server knows"
              ? [target]
              : kind === "workspace inside the target that the server knows"
                ? [path.join(target, "checkout")]
                : [],
        };
        const neighbor = await bundle(tmp, "neighbor");
        const unreadable = await startIdle(neighbor);
        fakeProc({ readable: [], unreadable: [unreadable] });
        await expectProcessDoubt(target, unreadable);
        await expect(
          processDoubtsIgnorableForRemoval(
            target,
            removal,
            temporaryRemoval.protectedPaths,
          ),
        ).resolves.toBe(false);

        const refused = removeHostPath(
          {
            type: "host.remove_path",
            path: target,
            recursive: true,
            temporaryRemoval,
          },
          removal,
        );
        await expect(refused).rejects.toMatchObject({ code: "path_in_use" });
        const message = await refused.catch((error: Error) => error.message);
        expect(message).toContain(`Refusing to remove ${target}:`);
        expect(message).toContain("could not be established");
        expect(message).not.toContain(".removing-");
        await expect(
          fs.readFile(path.join(target, "evidence.txt"), "utf8"),
        ).resolves.toBe("bundle");
        await expect(leftovers(parent)).resolves.toEqual([]);
      },
    );

    it("still refuses an unloaded workspace in the temporary directory when the server did not name the removal temporary", async () => {
      const root = await makeRoot();
      const workspace = await bundle(root, "unloaded-workspace");
      await fs.writeFile(path.join(workspace, "notes.md"), "work");
      const neighbor = await bundle(root, "neighbor");
      const unreadable = await startIdle(neighbor);
      fakeProc({ readable: [], unreadable: [unreadable] });
      await expectProcessDoubt(workspace, unreadable);
      await delay(FILE_TIMESTAMP_LAG_MS + 50);
      await expect(
        processDoubtsIgnorableForRemoval(workspace, context(), undefined),
      ).resolves.toBe(false);

      const refused = removeHostPath(
        { type: "host.remove_path", path: workspace, recursive: true },
        context(),
      );
      await expect(refused).rejects.toMatchObject({ code: "path_in_use" });
      expect(await refused.catch((error: Error) => error.message)).toContain(
        `Refusing to remove ${workspace}:`,
      );
      await expect(
        fs.readFile(path.join(workspace, "notes.md"), "utf8"),
      ).resolves.toBe("work");
      await expect(
        fs.readFile(path.join(workspace, "evidence.txt"), "utf8"),
      ).resolves.toBe("bundle");
      await expect(leftovers(root)).resolves.toEqual([]);
    });

    it("still refuses a link inside the temporary directory that resolves outside it", async () => {
      const tmp = await makeRoot();
      const temporaryRoot = path.join(tmp, "tmp");
      await fs.mkdir(temporaryRoot);
      process.env.TMPDIR = temporaryRoot;
      const outside = await bundle(tmp, "outside");
      const target = await bundle(outside, "bundle");
      const link = path.join(temporaryRoot, "link");
      await fs.symlink(outside, link);
      const neighbor = await bundle(tmp, "neighbor");
      const unreadable = await startIdle(neighbor);
      fakeProc({ readable: [], unreadable: [unreadable] });
      await expectProcessDoubt(target, unreadable);

      await expect(
        processDoubtsIgnorableForRemoval(
          path.join(link, "bundle"),
          context(),
          [],
        ),
      ).resolves.toBe(false);
      await expect(
        processDoubtsIgnorableForRemoval(link, context(), []),
      ).resolves.toBe(false);
      await expect(
        removeHostPath(
          {
            type: "host.remove_path",
            path: path.join(link, "bundle"),
            recursive: true,
            temporaryRemoval: noServerWorkspaces,
          },
          context(),
        ),
      ).rejects.toMatchObject({ code: "invalid_path" });
      await expect(
        fs.readFile(path.join(target, "evidence.txt"), "utf8"),
      ).resolves.toBe("bundle");
    });

    it("still refuses a temporary directory that a readable process is using", async () => {
      const root = await makeRoot();
      const target = await bundle(root, "fleet-evidence-held");
      const neighbor = await bundle(root, "neighbor");
      const unreadable = await startIdle(neighbor);
      const holder = await startIdle(target);
      fakeProc({ readable: [holder], unreadable: [unreadable] });
      await expect(scanWorktreeHolders(target)).resolves.toMatchObject({
        status: "held",
      });
      const refused = removeHostPath(
        {
          type: "host.remove_path",
          path: target,
          recursive: true,
          temporaryRemoval: noServerWorkspaces,
        },
        context(),
      );
      await expect(refused).rejects.toMatchObject({ code: "path_in_use" });
      const message = await refused.catch((error: Error) => error.message);
      expect(message).toContain(`Refusing to remove ${target}:`);
      expect(message).toContain("still using it");
      expect(message).not.toContain(".removing-");
      await expect(
        fs.readFile(path.join(target, "evidence.txt"), "utf8"),
      ).resolves.toBe("bundle");
      await expect(leftovers(root)).resolves.toEqual([]);
      expect(processes[1]?.exitCode).toBeNull();
      await expect(
        processDoubtsIgnorableForRemoval(target, context(), []),
      ).resolves.toBe(true);
    });

    it("still refuses when the process list itself cannot be read", async () => {
      const root = await makeRoot();
      const target = await bundle(root, "fleet-evidence-hidden");
      useProcReaderForTests({
        ...hostProc,
        readdir: async (name) => {
          if (name === "/proc")
            throw Object.assign(new Error("hidden"), { code: "EACCES" });
          return hostProc.readdir(name);
        },
      });
      const scan = await scanWorktreeHolders(target);
      expect(scan.status === "unknown" || scan.status === "uncertain").toBe(
        true,
      );
      expect("blockingProcesses" in scan).toBe(false);

      await expect(
        removeHostPath(
          {
            type: "host.remove_path",
            path: target,
            recursive: true,
            temporaryRemoval: noServerWorkspaces,
          },
          context(),
        ),
      ).rejects.toMatchObject({ code: "path_in_use" });
      await expect(
        fs.readFile(path.join(target, "evidence.txt"), "utf8"),
      ).resolves.toBe("bundle");
    });

    it("refuses temporary removal before touching the target when mountinfo is unreadable", async () => {
      const root = await makeRoot();
      const target = await bundle(root, "fleet-evidence-mount-state-unknown");
      const readFile = fs.readFile.bind(fs);
      vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
        if (file === "/proc/self/mountinfo")
          throw new Error("mountinfo unavailable");
        return readFile(file, options);
      });
      const lstat = vi.spyOn(fs, "lstat");
      const realpath = vi.spyOn(fs, "realpath");
      const started = performance.now();
      const outcome = await Promise.race([
        removeHostPath(
          {
            type: "host.remove_path",
            path: target,
            recursive: true,
            temporaryRemoval: noServerWorkspaces,
          },
          context(),
        ).then(
          () => ({ removed: true as const }),
          (error: unknown) => ({ removed: false as const, error }),
        ),
        delay(1_000).then(() => "still waiting" as const),
      ]);

      expect(outcome).not.toBe("still waiting");
      expect(outcome).toMatchObject({ removed: false });
      if (outcome === "still waiting" || outcome.removed) return;
      expect(outcome.error).toMatchObject({ code: "path_in_use" });
      expect((outcome.error as Error).message).toContain(
        `Refusing to remove ${target}:`,
      );
      expect((outcome.error as Error).message).toContain(
        "filesystem mount state could not be established",
      );
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(lstat).not.toHaveBeenCalledWith(target);
      expect(realpath).not.toHaveBeenCalledWith(target);
      await expect(
        fs.readFile(path.join(target, "evidence.txt"), "utf8"),
      ).resolves.toBe("bundle");
    });

    it.each([
      ["unparseable mountinfo", "not mountinfo"],
      ["missing temporary directory mount", "1 0 0:1 / /unrelated rw - tmpfs tmpfs rw"],
    ] as const)("treats %s as unknown mount state", async (_name, mountInfo) => {
      const target = await makeRoot();
      const readFile = fs.readFile.bind(fs);
      vi.spyOn(fs, "readFile").mockImplementation(async (file, options) =>
        file === "/proc/self/mountinfo"
          ? mountInfo
          : readFile(file, options),
      );

      await expect(
        temporaryTargetOnAnotherMount(target),
      ).resolves.toBe(null);
    });

    it("does not relax the temporary directory root itself", async () => {
      await expect(
        processDoubtsIgnorableForRemoval(os.tmpdir(), context(), []),
      ).resolves.toBe(false);
    });
  },
);
