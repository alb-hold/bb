import {
  execFile as execFileCallback,
  spawn,
  spawnSync,
} from "node:child_process";
import fs from "node:fs/promises";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gitModule from "bb-environment-provider-host/git";
import { hostProc, useProcReaderForTests, type ProcReader } from "./holders.js";
import { descendantsOnly } from "./descendants-only.js";
import { removeDirectoryTree } from "./remove-directory-tree.js";
import { removeWorktree } from "./worktree.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const workers: ReturnType<typeof spawn>[] = [];

function foreignUnreadableCwdProc(): ProcReader {
  return {
    ...hostProc,
    readlink: async (target) => {
      if (target === "/proc/100100/cwd")
        throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
      return hostProc.readlink(target);
    },
    readFile: async (target) => {
      if (target === "/proc/100100/status")
        return "Name:\tforeign\nState:\tS (sleeping)\nUid:\t1001\t1001\t1001\t1001\nGid:\t1001\t1001\t1001\t1001\nGroups:\t1001\n";
      return hostProc.readFile(target);
    },
    readdir: async (target) => {
      if (target === "/proc") return [String(process.pid), "100100"];
      return hostProc.readdir(target);
    },
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd });
  return result.stdout;
}

async function makeWorktree(
  existingRoot?: string,
): Promise<{ path: string; root: string }> {
  const root =
    existingRoot ??
    (await mkdtemp(path.join(os.tmpdir(), "bb-preserve-worktree-")));
  if (!roots.includes(root)) roots.push(root);
  const source = path.join(root, "source");
  const managed = path.join(root, "managed");
  const bare = path.join(root, "remote.git");
  const workspace = path.join(managed, "repo");
  await Promise.all([mkdir(source), mkdir(managed)]);
  await git(root, "init", "--bare", bare);
  await git(source, "init", "--initial-branch=main");
  await git(source, "config", "user.name", "Worktree Test");
  await git(source, "config", "user.email", "worktree-test@example.invalid");
  await writeFile(path.join(source, "README.md"), "published\n");
  await writeFile(path.join(source, ".gitignore"), ".env\n");
  await git(source, "add", "README.md");
  await git(source, "add", ".gitignore");
  await git(source, "commit", "-m", "published");
  await git(source, "remote", "add", "origin", bare);
  await git(source, "push", "--set-upstream", "origin", "main");
  await git(source, "worktree", "add", "-b", "feature", workspace);
  await git(
    source,
    "-C",
    workspace,
    "push",
    "--set-upstream",
    "origin",
    "feature",
  );
  return { path: workspace, root: managed };
}

async function remove(
  worktree: { path: string; root: string },
  force = true,
  testHooks?: {
    afterFinalCheck?: (worktreePath: string, gitDir: string) => Promise<void>;
    afterDirectoryListed?: (
      directory: string,
      entries: readonly string[],
    ) => Promise<void>;
  },
): Promise<void> {
  await Reflect.apply(removeWorktree, undefined, [
    { path: worktree.path, rootPath: worktree.root, force, testHooks },
  ]);
}

async function gitAt(
  worktreePath: string,
  gitDir: string,
  commonDir: string,
  ...args: string[]
): Promise<string> {
  const result = await execFile(
    "git",
    ["--git-dir", gitDir, "--work-tree", worktreePath, ...args],
    { cwd: worktreePath, env: { GIT_COMMON_DIR: commonDir } },
  );
  return result.stdout;
}

async function injectAtBaselineRemoval(
  worktreePath: string,
  inject: (
    worktreePath: string,
    gitDir: string,
    commonDir: string,
  ) => Promise<void>,
): Promise<() => void> {
  const originalRunGit = gitModule.runGit;
  let injected = false;
  const commonDir = (
    await git(
      worktreePath,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    )
  ).trim();
  const spy = vi
    .spyOn(gitModule, "runGit")
    .mockImplementation(async (args, options) => {
      if (!injected && args.includes("worktree") && args.includes("remove")) {
        injected = true;
        const parent = path.dirname(worktreePath);
        const quarantine = (await fs.readdir(parent)).find((name) =>
          name.startsWith(`.${path.basename(worktreePath)}.removing-`),
        );
        if (quarantine === undefined)
          throw new Error("quarantine path was not created");
        const target = path.join(parent, quarantine);
        const gitDir = (
          await git(target, "rev-parse", "--absolute-git-dir")
        ).trim();
        await inject(target, gitDir, commonDir);
      }
      return originalRunGit(args, options);
    });
  return () => spy.mockRestore();
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    workers.splice(0).map(async (worker) => {
      if (worker.exitCode !== null || worker.signalCode !== null) return;
      const exited = new Promise<void>((resolve) =>
        worker.once("exit", () => resolve()),
      );
      worker.kill("SIGKILL");
      await exited;
    }),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  useProcReaderForTests(null);
});

describe("real worktree teardown preservation", () => {
  it.each([
    [
      "modified",
      async (workspace: string) =>
        writeFile(path.join(workspace, "README.md"), "edited\n"),
    ],
    [
      "staged",
      async (workspace: string) => {
        await writeFile(path.join(workspace, "staged.txt"), "staged\n");
        await git(workspace, "add", "staged.txt");
      },
    ],
    [
      "untracked",
      async (workspace: string) =>
        writeFile(path.join(workspace, "draft.txt"), "draft\n"),
    ],
  ])(
    "keeps a %s worktree despite forced git removal",
    async (_kind, change) => {
      const worktree = await makeWorktree();
      await change(worktree.path);
      await remove(worktree, true).catch(() => undefined);
      await expect(access(worktree.path)).resolves.toBeUndefined();
      expect(await git(worktree.path, "status", "--porcelain")).not.toBe("");
    },
  );

  it("keeps ignored local data when force removal is requested", async () => {
    const worktree = await makeWorktree();
    const ignoredFile = path.join(worktree.path, ".env");
    await writeFile(ignoredFile, "local secret\n");
    await remove(worktree, true).catch(() => undefined);
    await expect(readFile(ignoredFile, "utf8")).resolves.toBe("local secret\n");
  });

  it("keeps data written as the worktree is quarantined for forced removal", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    let injected = false;
    let lateCommitSha = "";
    const originalRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await originalRename(from, to);
      if (String(from) === worktree.path) {
        await writeFile(path.join(String(to), ".env"), "raced write\n");
        injected = true;
      }
    });
    await expect(remove(worktree, true)).rejects.toMatchObject({
      code: "worktree_preserved",
    });
    expect(injected).toBe(true);
    await expect(
      readFile(path.join(worktree.path, ".env"), "utf8"),
    ).resolves.toBe("raced write\n");
    expect(
      await git(worktree.path, "status", "--porcelain", "--ignored=matching"),
    ).toContain(".env");
  });

  it("keeps a detached commit created after preflight", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    let injected = false;
    const originalRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await originalRename(from, to);
      if (String(from) !== worktree.path) return;
      await git(String(to), "checkout", "--detach", "HEAD");
      await writeFile(path.join(String(to), "late-commit.txt"), "local\n");
      await git(String(to), "add", "late-commit.txt");
      await git(String(to), "commit", "-m", "unpublished after preflight");
      injected = true;
    });

    await expect(remove(worktree, true)).rejects.toMatchObject({
      code: "worktree_preserved",
    });
    expect(injected).toBe(true);
    await expect(
      readFile(path.join(worktree.path, "late-commit.txt"), "utf8"),
    ).resolves.toBe("local\n");
    expect(await git(worktree.path, "status", "--porcelain")).toBe("");
  });

  it("keeps a stash created after preflight", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    let injected = false;
    const originalRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await originalRename(from, to);
      if (String(from) !== worktree.path) return;
      await writeFile(path.join(String(to), "README.md"), "late stash\n");
      await git(String(to), "stash", "push", "-m", "late stash");
      injected = true;
    });

    await expect(remove(worktree, true)).rejects.toMatchObject({
      code: "worktree_preserved",
    });
    expect(injected).toBe(true);
    expect(await git(worktree.path, "stash", "list")).toContain("late stash");
    await expect(access(worktree.path)).resolves.toBeUndefined();
  });

  it("retains an untracked file created after the final check", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    let injected = false;
    const restore = await injectAtBaselineRemoval(
      worktree.path,
      async (target) => {
        await writeFile(path.join(target, "late-untracked.txt"), "late\n");
        injected = true;
      },
    );
    let removalError: unknown;
    try {
      await remove(worktree, true, {
        afterFinalCheck: async (target) => {
          await writeFile(path.join(target, "late-untracked.txt"), "late\n");
          injected = true;
        },
      });
    } catch (error) {
      removalError = error;
    } finally {
      restore();
    }
    expect(removalError).toMatchObject({ code: "worktree_preserved" });
    expect(injected, String(removalError)).toBe(true);
    await expect(
      readFile(path.join(worktree.path, "late-untracked.txt"), "utf8"),
    ).resolves.toBe("late\n");
  });

  it("retains a detached commit created after the final check", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    let injected = false;
    const inject = async (
      target: string,
      gitDir: string,
      commonDir: string,
    ) => {
      await gitAt(target, gitDir, commonDir, "checkout", "--detach", "HEAD");
      await writeFile(path.join(target, "late-commit.txt"), "late commit\n");
      await gitAt(target, gitDir, commonDir, "add", "late-commit.txt");
      await gitAt(
        target,
        gitDir,
        commonDir,
        "-c",
        "user.name=Worktree Test",
        "-c",
        "user.email=worktree-test@example.invalid",
        "commit",
        "-m",
        "late detached commit",
      );
      lateCommitSha = (
        await gitAt(target, gitDir, commonDir, "rev-parse", "HEAD")
      ).trim();
      injected = true;
    };
    const restore = await injectAtBaselineRemoval(worktree.path, inject);
    let removalError: unknown;
    try {
      await remove(worktree, true, {
        afterFinalCheck: (target, gitDir) =>
          inject(target, gitDir, path.dirname(path.dirname(gitDir))),
      });
    } catch (error) {
      removalError = error;
    } finally {
      restore();
    }
    expect(removalError).toMatchObject({ code: "worktree_preserved" });
    expect(injected, String(removalError)).toBe(true);
    await expect(
      readFile(path.join(worktree.path, "late-commit.txt"), "utf8"),
    ).resolves.toBe("late commit\n");
    expect(await git(worktree.path, "rev-parse", "HEAD")).toBe(
      `${lateCommitSha}\n`,
    );
    await expect(
      git(worktree.path, "cat-file", "-e", `${lateCommitSha}^{commit}`),
    ).resolves.toBe("");
    expect(await git(worktree.path, "log", "-1", "--format=%s")).toContain(
      "late detached commit",
    );
  });

  it("stops directory removal when a file appears in a directory already listed", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    await mkdir(path.join(worktree.path, "late-dir"));
    await writeFile(path.join(worktree.path, "late-dir", "old.txt"), "old\n");
    await git(worktree.path, "add", "late-dir/old.txt");
    await git(worktree.path, "commit", "-m", "published directory entry");
    await git(worktree.path, "push", "origin", "feature");
    let injected = false;
    const restore = await injectAtBaselineRemoval(
      worktree.path,
      async (target) => {
        await writeFile(
          path.join(target, "late-dir", "during-delete.txt"),
          "during\n",
        );
        injected = true;
      },
    );
    let removalError: unknown;
    try {
      await remove(worktree, true, {
        afterDirectoryListed: async (directory, entries) => {
          if (
            !directory.endsWith("late-dir") ||
            injected ||
            !entries.includes("old.txt")
          )
            return;
          await writeFile(
            path.join(directory, "during-delete.txt"),
            "during\n",
          );
          injected = true;
        },
      });
    } catch (error) {
      removalError = error;
    } finally {
      restore();
    }
    expect(removalError).toMatchObject({ code: "worktree_preserved" });
    expect(injected, String(removalError)).toBe(true);
    await expect(
      readFile(
        path.join(worktree.path, "late-dir", "during-delete.txt"),
        "utf8",
      ),
    ).resolves.toBe("during\n");
  });

  it("does not follow a directory replaced by a symlink during removal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-remove-tree-race-"));
    roots.push(root);
    const target = path.join(root, "target");
    const nested = path.join(target, "nested");
    const moved = path.join(target, "moved-nested");
    const outside = path.join(root, "outside");
    await Promise.all([mkdir(nested, { recursive: true }), mkdir(outside)]);
    await Promise.all([
      writeFile(path.join(nested, "entry.txt"), "inside\n"),
      writeFile(path.join(outside, "entry.txt"), "outside\n"),
    ]);
    let swapped = false;
    const result = await removeDirectoryTree(target, {
      startedAt: Date.now() + 10_000,
      afterDirectoryListed: async (directory) => {
        if (directory !== nested || swapped) return;
        swapped = true;
        await fs.rename(nested, moved);
        await fs.symlink(outside, nested);
      },
    });
    expect(swapped).toBe(true);
    expect(result).toBe("retained");
    await expect(
      readFile(path.join(outside, "entry.txt"), "utf8"),
    ).resolves.toBe("outside\n");
  });

  it("retains a root directory changed after recursive removal starts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-remove-root-race-"));
    roots.push(root);
    const target = path.join(root, "target");
    await mkdir(target);
    await writeFile(path.join(target, "entry.txt"), "keep\n");
    const result = await removeDirectoryTree(target, {
      afterStart: async () => {
        await fs.chmod(target, 0o700);
      },
    });
    expect(result).toBe("retained");
    await expect(readFile(path.join(target, "entry.txt"), "utf8")).resolves.toBe(
      "keep\n",
    );
  });

  it("retains Git metadata created while pruning the severed admin directory", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    let injected = false;
    let severedGitDir: string | null = null;
    let removalError: unknown;
    try {
      await remove(worktree, true, {
        afterFinalCheck: async (_target, gitDir) => {
          severedGitDir = gitDir;
        },
        afterDirectoryListed: async (directory) => {
          if (injected || severedGitDir === null || directory !== severedGitDir)
            return;
          await writeFile(path.join(directory, "late-metadata"), "kept\n");
          injected = true;
        },
      });
    } catch (error) {
      removalError = error;
    }
    expect(removalError).toMatchObject({ code: "worktree_preserved" });
    expect(injected, String(removalError)).toBe(true);
    expect(severedGitDir).not.toBeNull();
    await expect(
      readFile(path.join(severedGitDir!, "late-metadata"), "utf8"),
    ).resolves.toBe("kept\n");
  });

  it("keeps a worktree used as another live process's cwd without signalling it", async () => {
    const worktree = await makeWorktree();
    const signalMarker = path.join(worktree.root, "signalled");
    const worker = spawn(
      process.execPath,
      [
        "-e",
        "const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(process.argv[1],'signal');process.exit(0)});setInterval(()=>{},1000);process.send('ready')",
        signalMarker,
      ],
      { cwd: worktree.path, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    workers.push(worker);
    await new Promise<void>((resolve, reject) => {
      worker.once("message", () => resolve());
      worker.once("error", reject);
    });
    await remove(worktree).catch(() => undefined);
    expect(() => process.kill(worker.pid!, 0)).not.toThrow();
    await expect(access(signalMarker)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(worktree.path)).resolves.toBeUndefined();
    expect(await readFile(path.join(worktree.path, "README.md"), "utf8")).toBe(
      "published\n",
    );
  });

  it.skipIf(process.platform !== "linux")(
    "keeps an uncertain foreign-user holder without signalling any process",
    async () => {
      const root = await mkdtemp(path.join("/tmp", "bb-preserve-worktree-"));
      const worktree = await makeWorktree(root);
      await fs.chmod(path.dirname(worktree.root), 0o755);
      await fs.chmod(worktree.root, 0o755);
      useProcReaderForTests(foreignUnreadableCwdProc());
      const signal = vi.spyOn(process, "kill");

      await expect(remove(worktree, true)).rejects.toMatchObject({
        code: "worktree_preserved",
      });

      expect(signal).not.toHaveBeenCalled();
      await expect(access(worktree.path)).resolves.toBeUndefined();
      expect(await git(worktree.path, "status", "--porcelain")).toBe("");
    },
  );

  it.skipIf(
    process.platform !== "linux" ||
      (typeof process.getuid === "function" && process.getuid() === 0),
  )(
    "keeps a worktree held by a non-dumpable process that predates it and spoofs an agent name",
    async ({ skip }) => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "bb-preserve-worktree-"),
      );
      roots.push(root);
      const signalMarker = path.join(root, "signalled-agent");
      skip(
        spawnSync("python3", ["--version"]).status !== 0,
        "python3 is not available",
      );
      const worker = spawn(
        "python3",
        [
          "-c",
          `import ctypes, signal, sys, time
libc = ctypes.CDLL(None)
libc.prctl(4, 0, 0, 0, 0)
libc.prctl(15, b"ssh-agent", 0, 0, 0)
signal.signal(signal.SIGTERM, lambda *_: (open(sys.argv[1], "w").write("signal"), sys.exit(0)))
print("ready", flush=True)
while not __import__("os").path.isdir(sys.argv[2]): time.sleep(0.01)
__import__("os").chdir(sys.argv[2])
print("entered", flush=True)
time.sleep(120)`,
          signalMarker,
          path.join(root, "managed", "repo"),
        ],
        { cwd: root, argv0: "ssh-agent", stdio: ["ignore", "pipe", "ignore"] },
      );
      workers.push(worker);
      const output = { value: "" };
      worker.stdout?.on("data", (chunk) => {
        output.value += chunk.toString();
      });
      const waitForOutput = async (expected: string) => {
        while (!output.value.includes(expected)) {
          await new Promise<void>((resolve, reject) => {
            worker.stdout?.once("data", () => resolve());
            worker.once("error", reject);
          });
        }
      };
      await waitForOutput("ready\n");
      const worktree = await makeWorktree(root);
      await waitForOutput("entered\n");
      const readdir = hostProc.readdir.bind(hostProc);
      useProcReaderForTests({
        ...hostProc,
        readdir: async (target) =>
          target === "/proc" ? [String(worker.pid)] : await readdir(target),
      });
      expect((await readFile(`/proc/${worker.pid}/comm`, "utf8")).trim()).toBe(
        "ssh-agent",
      );
      try {
        await readlink(`/proc/${worker.pid}/task/${worker.pid}/cwd`);
        skip(true, "the kernel lets this user read the non-dumpable process");
      } catch (error) {
        skip(
          (error as NodeJS.ErrnoException).code !== "EACCES",
          "the process cwd was not unreadable",
        );
      }
      const removalError = await remove(worktree, true).then(
        () => null,
        (error: unknown) => error,
      );
      expect(removalError).toMatchObject({ code: "worktree_preserved" });
      expect(removalError).toMatchObject({
        message: expect.stringContaining(
          "could not check which programs are using it",
        ),
      });
      expect(removalError).toMatchObject({
        message: expect.stringContaining(`process ${worker.pid}`),
      });
      expect(() => process.kill(worker.pid!, 0)).not.toThrow();
      await expect(access(signalMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(worktree.path)).resolves.toBeUndefined();
      expect(
        await readFile(path.join(worktree.path, "README.md"), "utf8"),
      ).toBe("published\n");
    },
  );
});
