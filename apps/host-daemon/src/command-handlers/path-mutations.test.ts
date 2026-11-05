import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";

import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdirHostPath,
  moveHostPath,
  removeHostPath,
} from "./path-mutations.js";
import { removeDirectoryAfterHolderRecheck } from "./remove-held-directory.js";
import type { WorktreeHolderScan } from "@bb/process-utils/worktree-holders";
import {
  hostProc,
  scanWorktreeHolders,
  useProcReaderForTests,
  type ProcReader,
} from "@bb/process-utils/worktree-holders";

const roots: string[] = [];
const hasHeldDirectoryRemoval = existsSync(
  new URL("./remove-held-directory.ts", import.meta.url),
);

async function makeRoot(): Promise<string> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bb-path-mutations-")),
  );
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("confined host path mutations", () => {
  it.skipIf(!hasHeldDirectoryRemoval || process.platform !== "linux")(
    "refuses recursive removal when the shared fd and executable scan finds a foreign holder",
    async () => {
      const root = await makeRoot();
      const target = path.join(root, "foreign-holder");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "data.txt"), "keep");
      const signal = vi.spyOn(process, "kill");
      const pid = 4_000_000_103;
      const base = `/proc/${pid}`;
      const scanHolders = async (
        directory: string,
      ): Promise<WorktreeHolderScan> => {
        let mount: string | undefined;
        const proc: ProcReader = {
          ...hostProc,
          readFile: async (name) => {
            if (name === "/proc/self/status")
              return `Name:\tnode\nState:\tR (running)\nNSpid:\t${process.pid}\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nGroups:\t0\n`;
            if (name === `${base}/status`)
              return `Name:\tforeign\nState:\tS (sleeping)\nUid:\t501\t501\t501\t501\nGid:\t501\t501\t501\t501\nGroups:\t501\nCapEff:\t0000000000000000\n`;
            if (name === `${base}/comm`) return "foreign-holder\n";
            if (name === `${base}/maps`) return "";
            return hostProc.readFile(name);
          },
          readdir: async (name) => {
            if (name === "/proc") return [String(process.pid), String(pid)];
            if (name === `${base}/task`) return [String(pid)];
            if (name === `${base}/fd`) return ["3"];
            return hostProc.readdir(name);
          },
          readlink: async (name) => {
            if (name === "/proc/self/ns/mnt" || name === `${base}/ns/mnt` || name === `${base}/task/${pid}/ns/mnt`) {
              mount ??= await hostProc.readlink("/proc/self/ns/mnt");
              return mount;
            }
            if (name === "/proc/self/root" || name === `${base}/root`) return "/";
            if (name === `${base}/cwd` || name === `${base}/task/${pid}/cwd`) return "/tmp/outside";
            if (name === `${base}/exe`) return path.join(directory, "data.txt");
            if (name === `${base}/fd/3`) return "/dev/null";
            return hostProc.readlink(name);
          },
        };
        useProcReaderForTests(proc);
        try {
          return await scanWorktreeHolders(directory);
        } finally {
          useProcReaderForTests(null);
        }
      };

      await expect(
        removeDirectoryAfterHolderRecheck({
          directory: target,
          action: "remove",
          recursive: true,
          scanHolders,
        }),
      ).rejects.toMatchObject({ code: "path_in_use" });

      expect(signal).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(target, "data.txt"), "utf8")).resolves.toBe("keep");
    },
  );

  it.skipIf(!hasHeldDirectoryRemoval)(
    "retains data written after the holder scan by a worker that fchdirs into quarantine",
    async () => {
      const root = await makeRoot();
      const target = path.join(root, "fchdir-race");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "before.txt"), "before");
      const worker = spawn(
        "python3",
        [
          "-c",
          "import os,sys; fd=os.open(sys.argv[1], os.O_RDONLY); print('ready', flush=True); sys.stdin.readline(); os.fchdir(fd); open('late.txt','w').write('late'); print('written', flush=True); sys.stdin.readline()",
          target,
        ],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
      let output = "";
      worker.stdout?.on("data", (chunk) => {
        output += chunk.toString();
      });
      const waitFor = async (value: string) => {
        while (!output.includes(value)) await once(worker.stdout!, "data");
      };
      try {
        await waitFor("ready");
        await expect(
          removeDirectoryAfterHolderRecheck({
            directory: target,
            action: "remove worktree",
            recursive: true,
            afterHolderScan: async () => {
              worker.stdin?.write("go\n");
              await waitFor("written");
              worker.stdin?.write("done\n");
            },
          }),
        ).rejects.toMatchObject({ code: "path_in_use" });
        await expect(
          fs.readFile(path.join(target, "late.txt"), "utf8"),
        ).resolves.toBe("late");
      } finally {
        worker.kill("SIGKILL");
      }
    },
  );

  it.skipIf(!hasHeldDirectoryRemoval)(
    "reports a previous removal quarantine when forced deletion finds no source path",
    async () => {
      const root = await makeRoot();
      const target = path.join(root, "recoverable");
      const quarantine = path.join(root, ".recoverable.removing-crash");
      await fs.mkdir(quarantine);
      await fs.writeFile(path.join(quarantine, "note.txt"), "recover me");
      await expect(
        removeDirectoryAfterHolderRecheck({
          directory: target,
          action: "delete thread storage",
          force: true,
          recursive: true,
        }),
      ).rejects.toMatchObject({ code: "path_in_use" });
      await expect(
        fs.readFile(path.join(quarantine, "note.txt"), "utf8"),
      ).resolves.toBe("recover me");
    },
  );

  it("creates, moves, and removes paths beneath the declared root", async () => {
    const root = await makeRoot();
    const folder = path.join(root, "projects");
    await expect(
      mkdirHostPath({
        type: "host.mkdir",
        path: folder,
        rootPath: root,
        recursive: false,
      }),
    ).resolves.toEqual({ ok: true });
    const source = path.join(folder, "draft.md");
    const destination = path.join(folder, "plan.md");
    await fs.writeFile(source, "# Plan");
    await expect(
      moveHostPath({
        type: "host.move_path",
        sourcePath: source,
        destinationPath: destination,
        rootPath: root,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("# Plan");
    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: destination,
        rootPath: root,
        recursive: false,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(fs.stat(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses Windows path removal and moves without touching either path", async () => {
    const root = await makeRoot();
    const source = path.join(root, "source.txt");
    const destination = path.join(root, "destination.txt");
    await fs.writeFile(source, "preserve");
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      await expect(
        removeHostPath({
          type: "host.remove_path",
          path: source,
          rootPath: root,
          recursive: false,
        }),
      ).rejects.toMatchObject({ code: "invalid_path" });
      await expect(
        moveHostPath({
          type: "host.move_path",
          sourcePath: source,
          destinationPath: destination,
          rootPath: root,
        }),
      ).rejects.toMatchObject({ code: "invalid_path" });
      await expect(fs.readFile(source, "utf8")).resolves.toBe("preserve");
      await expect(fs.stat(destination)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
    }
  });

  it("rechecks a recursive removal after quarantining and restores a held path", async ({
    skip,
  }) => {
    skip(process.platform === "win32", "Windows path removals are refused");
    const root = await makeRoot();
    const target = path.join(root, "busy");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "note.txt"), "kept");
    const originalRename = fs.rename.bind(fs);
    const workers: ReturnType<typeof spawn>[] = [];
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await originalRename(from, to);
      if (String(from) !== target || workers.length > 0) return;
      const worker = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000); process.send('ready')"],
        {
          cwd: String(to),
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      workers.push(worker);
      await once(worker, "message");
    });
    try {
      await expect(
        removeHostPath({
          type: "host.remove_path",
          path: target,
          rootPath: root,
          recursive: true,
        }),
      ).rejects.toMatchObject({ code: "path_in_use" });
      await expect(
        fs.readFile(path.join(target, "note.txt"), "utf8"),
      ).resolves.toBe("kept");
      expect(workers[0]?.exitCode).toBeNull();
      expect(workers[0]?.signalCode).toBeNull();
    } finally {
      vi.restoreAllMocks();
      const worker = workers[0];
      if (
        worker !== undefined &&
        worker.exitCode === null &&
        worker.signalCode === null
      ) {
        const exited = once(worker, "exit");
        worker.kill("SIGKILL");
        await exited;
      }
    }
  });

  it.skipIf(!hasHeldDirectoryRemoval)(
    "retains data created after a recursive directory is quarantined",
    async () => {
      const root = await makeRoot();
      const target = path.join(root, "late-data");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "old.txt"), "old");
      let injected = false;
      await expect(
        removeDirectoryAfterHolderRecheck({
          directory: target,
          action: "remove",
          recursive: true,
          afterHolderScan: async (quarantine) => {
            await fs.writeFile(path.join(quarantine, "late.txt"), "keep");
            injected = true;
          },
        }),
      ).rejects.toMatchObject({ code: "path_in_use" });
      expect(injected).toBe(true);
      await expect(
        fs.readFile(path.join(target, "late.txt"), "utf8"),
      ).resolves.toBe("keep");
    },
  );

  it.skipIf(!hasHeldDirectoryRemoval)(
    "does not replace a directory created at the original path before restore",
    async () => {
      const root = await makeRoot();
      const target = path.join(root, "restore-race");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "original.txt"), "original");
      const originalRename = fs.rename.bind(fs);
      let replacementInode: number | null = null;
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        await originalRename(from, to);
        if (String(from) !== target || replacementInode !== null) return;
        await fs.mkdir(target);
        replacementInode = (await fs.stat(target)).ino;
        const worker = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000); process.send('ready')"],
          { cwd: String(to), stdio: ["ignore", "ignore", "ignore", "ipc"] },
        );
        await once(worker, "message");
        workers.push(worker);
      });
      const workers: ReturnType<typeof spawn>[] = [];
      try {
        await expect(
          removeHostPath({
            type: "host.remove_path",
            path: target,
            rootPath: root,
            recursive: true,
          }),
        ).rejects.toMatchObject({ code: "path_in_use" });
        expect(replacementInode).not.toBeNull();
        expect((await fs.stat(target)).ino).toBe(replacementInode);
        await expect(fs.readdir(target)).resolves.toEqual([]);
        const quarantines = (await fs.readdir(root)).filter((name) =>
          name.startsWith(".restore-race.removing-"),
        );
        expect(quarantines).toHaveLength(1);
        await expect(
          fs.readFile(path.join(root, quarantines[0]!, "original.txt"), "utf8"),
        ).resolves.toBe("original");
      } finally {
        vi.restoreAllMocks();
        for (const worker of workers) {
          if (worker.exitCode === null && worker.signalCode === null) {
            const exited = once(worker, "exit");
            worker.kill("SIGKILL");
            await exited;
          }
        }
      }
    },
  );

  it("creates missing parent directories when recursive is enabled", async () => {
    const root = await makeRoot();
    const nested = path.join(root, "projects", "archive", "2026");
    await expect(
      mkdirHostPath({
        type: "host.mkdir",
        path: nested,
        rootPath: root,
        recursive: true,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(fs.stat(nested)).resolves.toMatchObject({});
  });

  it("removes empty directories non-recursively and requires recursive for non-empty directories", async () => {
    const root = await makeRoot();
    const empty = path.join(root, "empty");
    await fs.mkdir(empty);
    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: empty,
        rootPath: root,
        recursive: false,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(fs.stat(empty)).rejects.toMatchObject({ code: "ENOENT" });

    const nonEmpty = path.join(root, "non-empty");
    await fs.mkdir(nonEmpty);
    await fs.writeFile(path.join(nonEmpty, "note.md"), "# Note");
    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: nonEmpty,
        rootPath: root,
        recursive: false,
      }),
    ).rejects.toThrow();
    await expect(fs.stat(nonEmpty)).resolves.toMatchObject({});
    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: nonEmpty,
        rootPath: root,
        recursive: true,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(fs.stat(nonEmpty)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlink escapes and refuses to remove the declared root", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const link = path.join(root, "outside");
    await fs.symlink(outside, link);
    const escaped = path.join(link, "secret.md");
    await fs.writeFile(path.join(outside, "secret.md"), "secret");

    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: escaped,
        rootPath: root,
        recursive: false,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: root,
        rootPath: root,
        recursive: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("does not overwrite a move destination", async () => {
    const root = await makeRoot();
    const source = path.join(root, "source.md");
    const destination = path.join(root, "destination.md");
    await fs.writeFile(source, "source");
    await fs.writeFile(destination, "destination");

    await expect(
      moveHostPath({
        type: "host.move_path",
        sourcePath: source,
        destinationPath: destination,
        rootPath: root,
      }),
    ).rejects.toMatchObject({ code: "path_exists" });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("destination");
  });

  it("refuses to move a folder and leaves it and its contents in place", async () => {
    const root = await makeRoot();
    const source = path.join(root, "workspace");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "work.txt"), "keep");
    const destination = path.join(root, "moved");

    await expect(
      moveHostPath({
        type: "host.move_path",
        sourcePath: source,
        destinationPath: destination,
        rootPath: root,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      fs.readFile(path.join(source, "work.txt"), "utf8"),
    ).resolves.toBe("keep");
    await expect(fs.lstat(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to follow a symbolic link, whether it points at a file or a folder", async () => {
    const root = await makeRoot();
    const target = path.join(root, "real.txt");
    await fs.writeFile(target, "real");
    const folder = path.join(root, "folder");
    await fs.mkdir(folder);
    for (const [name, pointsTo] of [
      ["file-link", target],
      ["folder-link", folder],
    ] as const) {
      const link = path.join(root, name);
      await fs.symlink(pointsTo, link);
      await expect(
        moveHostPath({
          type: "host.move_path",
          sourcePath: link,
          destinationPath: path.join(root, `${name}-moved`),
          rootPath: root,
        }),
      ).rejects.toMatchObject({ code: "invalid_path" });
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      await expect(
        fs.lstat(path.join(root, `${name}-moved`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(fs.readFile(target, "utf8")).resolves.toBe("real");
  });

  it("moves a regular file, keeping its inode, leaving nothing at the source and no holding file behind", async () => {
    const root = await makeRoot();
    const source = path.join(root, "a.txt");
    const destination = path.join(root, "b.txt");
    await fs.writeFile(source, "content");
    const before = await fs.stat(source);

    await expect(
      moveHostPath({
        type: "host.move_path",
        sourcePath: source,
        destinationPath: destination,
        rootPath: root,
      }),
    ).resolves.toEqual({ ok: true });

    await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    const after = await fs.stat(destination);
    expect(after.ino).toBe(before.ino);
    expect(after.nlink).toBe(1);
    expect(await fs.readdir(root)).toEqual(["b.txt"]);
  });

  it("refuses a source swapped for a folder after the open and never moves the folder", async () => {
    const root = await makeRoot();
    const source = path.join(root, "a.txt");
    const destination = path.join(root, "b.txt");
    await fs.writeFile(source, "original");

    await expect(
      moveHostPath(
        {
          type: "host.move_path",
          sourcePath: source,
          destinationPath: destination,
          rootPath: root,
        },
        {
          afterOpen: async () => {
            await fs.rename(source, `${source}.orig`);
            await fs.mkdir(source);
            await fs.writeFile(path.join(source, "inside.txt"), "workspace");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_path" });

    await expect(fs.lstat(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.readFile(path.join(source, "inside.txt"), "utf8"),
    ).resolves.toBe("workspace");
  });

  it("puts a regular file swapped in after the link back where it was, and the destination holds the original", async () => {
    const root = await makeRoot();
    const source = path.join(root, "a.txt");
    const destination = path.join(root, "b.txt");
    await fs.writeFile(source, "original");
    const before = await fs.stat(source);

    await expect(
      moveHostPath(
        {
          type: "host.move_path",
          sourcePath: source,
          destinationPath: destination,
          rootPath: root,
        },
        {
          afterLink: async () => {
            await fs.rename(source, `${source}.orig`);
            await fs.writeFile(source, "swapped in");
          },
        },
      ),
    ).resolves.toEqual({ ok: true });

    expect((await fs.stat(destination)).ino).toBe(before.ino);
    await expect(fs.readFile(source, "utf8")).resolves.toBe("swapped in");
    expect(
      (await fs.readdir(root)).filter((name) => name.startsWith(".bb-moving-")),
    ).toEqual([]);
  });

  it("leaves a destination replacement untouched when it changes after link", async () => {
    const root = await makeRoot();
    const source = path.join(root, "a.txt");
    const destination = path.join(root, "b.txt");
    await fs.writeFile(source, "original");

    const failure = await moveHostPath(
      {
        type: "host.move_path",
        sourcePath: source,
        destinationPath: destination,
        rootPath: root,
      },
      {
        afterLinkBeforeCheck: async () => {
          await fs.unlink(destination);
          await fs.writeFile(destination, "replacement");
        },
      },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("destination now holds something else"),
    });
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(source, "utf8")).resolves.toBe("original");
  });

  it("restores the source and refuses when the destination changes after its post-link check", async () => {
    const root = await makeRoot();
    const source = path.join(root, "a.txt");
    const destination = path.join(root, "b.txt");
    await fs.writeFile(source, "original");

    const failure = await moveHostPath(
      {
        type: "host.move_path",
        sourcePath: source,
        destinationPath: destination,
        rootPath: root,
      },
      {
        afterLink: async () => {
          await fs.unlink(destination);
          await fs.writeFile(destination, "replacement");
        },
      },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("destination now holds something else"),
    });
    await expect(fs.readFile(source, "utf8")).resolves.toBe("original");
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("replacement");
    expect(
      (await fs.readdir(root)).filter((name) => name.startsWith(".bb-moving-")),
    ).toEqual([]);
  });

  it.each([
    [
      "a folder",
      async (source: string) => {
        await fs.rename(source, `${source}.orig`);
        await fs.mkdir(source);
        await fs.writeFile(path.join(source, "inside.txt"), "workspace");
      },
    ],
    [
      "a symbolic link",
      async (source: string) => {
        await fs.rename(source, `${source}.orig`);
        await fs.symlink(`${source}.orig`, source);
      },
    ],
  ])(
    "never moves %s swapped in after the link back, leaves it under its holding name and says so",
    async (_label, swap) => {
      const root = await makeRoot();
      const source = path.join(root, "a.txt");
      const destination = path.join(root, "b.txt");
      await fs.writeFile(source, "original");
      const before = await fs.stat(source);

      const failure = await moveHostPath(
        {
          type: "host.move_path",
          sourcePath: source,
          destinationPath: destination,
          rootPath: root,
        },
        { afterLink: () => swap(source) },
      ).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        code: "invalid_path",
        message: expect.stringContaining(".bb-moving-"),
      });
      expect((await fs.stat(destination)).ino).toBe(before.ino);
      await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await fs.readdir(root)).filter((name) =>
          name.startsWith(".bb-moving-"),
        ),
      ).toHaveLength(1);
    },
  );

  it("never overwrites something that lands at the source while a swapped-in file is being put back: the occupant survives and the moved file stays under its holding name", async () => {
    const root = await makeRoot();
    const source = path.join(root, "a.txt");
    const destination = path.join(root, "b.txt");
    await fs.writeFile(source, "original");

    const failure = await moveHostPath(
      {
        type: "host.move_path",
        sourcePath: source,
        destinationPath: destination,
        rootPath: root,
      },
      {
        afterLink: async () => {
          await fs.rename(source, `${source}.orig`);
          await fs.writeFile(source, "swapped in");
        },
        afterHold: async () => {
          await fs.writeFile(source, "occupant");
        },
      },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("could not be put back"),
    });
    await expect(fs.readFile(source, "utf8")).resolves.toBe("occupant");
    const holding = (await fs.readdir(root)).filter((name) =>
      name.startsWith(".bb-moving-"),
    );
    expect(holding).toHaveLength(1);
    await expect(
      fs.readFile(path.join(root, holding[0]!), "utf8"),
    ).resolves.toBe("swapped in");
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("original");
  });

  it("refuses a source and a destination reached through a symlinked folder, and a removal through one", async () => {
    const root = await makeRoot();
    const real = path.join(root, "real");
    await fs.mkdir(real);
    await fs.writeFile(path.join(real, "a.txt"), "keep");
    await fs.symlink(real, path.join(root, "alias"));

    await expect(
      moveHostPath({
        type: "host.move_path",
        sourcePath: path.join(root, "alias", "a.txt"),
        destinationPath: path.join(root, "b.txt"),
        rootPath: root,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      moveHostPath({
        type: "host.move_path",
        sourcePath: path.join(real, "a.txt"),
        destinationPath: path.join(root, "alias", "b.txt"),
        rootPath: root,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      removeHostPath({
        type: "host.remove_path",
        path: path.join(root, "alias", "a.txt"),
        rootPath: root,
        recursive: false,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(fs.readFile(path.join(real, "a.txt"), "utf8")).resolves.toBe(
      "keep",
    );
  });
});
