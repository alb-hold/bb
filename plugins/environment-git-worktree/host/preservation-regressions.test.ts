import {
  execFile as execFileCallback,
  spawn,
  spawnSync,
} from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hostProc,
  scanWorktreeHolders,
  useProcReaderForTests,
  type ProcReader,
} from "./holders.js";
import { descendantsOnly } from "./descendants-only.js";
import { removeWorktree } from "./worktree.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const workers: ReturnType<typeof spawn>[] = [];
const hasRemoveDirectoryTree = existsSync(
  new URL("./remove-directory-tree.ts", import.meta.url),
);
const removeDirectoryTreeTest = it.skipIf(!hasRemoveDirectoryTree);

async function removeDirectoryTree(
  root: string,
  hooks: {
    startedAt?: number;
    afterStart?: (startedAt: number) => Promise<void>;
    afterDirectoryListed?: (
      directory: string,
      entries: readonly string[],
    ) => Promise<void>;
    beforeEntryRemoval?: (entry: string) => Promise<void>;
    beforeEntryRename?: (entry: string) => Promise<void>;
    afterEntryCheck?: (entry: string) => Promise<void>;
    afterEntryQuarantined?: (
      entry: string,
      quarantined: string,
    ) => Promise<void>;
    afterRootMarkerDetached?: (root: string) => Promise<void>;
  },
) {
  const moduleUrl = new URL("./remove-directory-tree.js", import.meta.url).href;
  return (await import(moduleUrl)).removeDirectoryTree(root, hooks);
}

function foreignUnreadableCwdProc(
  pid: number,
  supplementaryGroups: number[] = [],
): ProcReader {
  const daemonUid = process.getuid?.() ?? process.geteuid?.() ?? 1000;
  const daemonGid = process.getgid?.() ?? process.getegid?.() ?? 1000;
  let foreignUid = 60_000;
  while (foreignUid <= daemonUid && foreignUid + 3 >= daemonUid)
    foreignUid += 4;
  let foreignGid = 61_000;
  while (foreignGid <= daemonGid && foreignGid + 3 >= daemonGid)
    foreignGid += 4;
  return {
    ...hostProc,
    readlink: async (target) => {
      if (
        target === `/proc/${pid}/cwd` ||
        (target.startsWith(`/proc/${pid}/task/`) && target.endsWith("/cwd"))
      )
        throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
      return hostProc.readlink(target);
    },
    readFile: async (target) => {
      if (target === `/proc/${pid}/status`)
        return `Name:\tforeign\nState:\tS (sleeping)\nUid:\t${foreignUid}\t${foreignUid + 1}\t${foreignUid + 2}\t${foreignUid + 3}\nGid:\t${foreignGid}\t${foreignGid + 1}\t${foreignGid + 2}\t${foreignGid + 3}\nGroups:\t${[foreignGid + 3, ...supplementaryGroups].join(" ")}\nCapEff:\t0000000000000000\n`;
      return hostProc.readFile(target);
    },
    readdir: async (target) => {
      if (target === "/proc") return [String(process.pid), String(pid)];
      return hostProc.readdir(target);
    },
  };
}

function foreignReadableOutsideCwdProc(pid: number): ProcReader {
  const foreignUid = 60_000;
  const foreignGid = 61_000;
  return {
    ...hostProc,
    readlink: async (target) =>
      target === `/proc/${pid}/cwd` ||
      (target.startsWith(`/proc/${pid}/task/`) && target.endsWith("/cwd"))
        ? "/tmp"
        : hostProc.readlink(target),
    readFile: async (target) => {
      if (target === "/proc/self/status")
        return `Name:\tnode\nState:\tR (running)\nNSpid:\t${process.pid}\nUid:\t2000\t2000\t2000\t2000\nGid:\t2000\t2000\t2000\t2000\nGroups:\t2000\n`;
      if (target === `/proc/${pid}/status`)
        return `Name:\tforeign\nState:\tS (sleeping)\nUid:\t${foreignUid}\t${foreignUid}\t${foreignUid}\t${foreignUid}\nGid:\t${foreignGid}\t${foreignGid}\t${foreignGid}\t${foreignGid}\nGroups:\t${foreignGid}\nCapEff:\t0000000000000000\n`;
      return hostProc.readFile(target);
    },
    readdir: async (target) =>
      target === "/proc"
        ? [String(process.pid), String(pid)]
        : hostProc.readdir(target),
  };
}

function rootDaemonHolderProc(
  pid: number,
  worktreePath: string,
  holder: "fd" | "exe",
): ProcReader {
  let mount: string | undefined;
  const base = `/proc/${pid}`;
  return {
    ...hostProc,
    readFile: async (target) => {
      if (target === "/proc/self/status")
        return `Name:\tnode\nState:\tR (running)\nNSpid:\t${process.pid}\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nGroups:\t0\n`;
      if (target === `${base}/status`)
        return `Name:\tforeign\nState:\tS (sleeping)\nUid:\t501\t501\t501\t501\nGid:\t501\t501\t501\t501\nGroups:\t501\nCapEff:\t0000000000000000\n`;
      if (target === `${base}/comm`) return "foreign-holder\n";
      if (target === `${base}/maps`) return "";
      return hostProc.readFile(target);
    },
    readdir: async (target) => {
      if (target === "/proc") return [String(process.pid), String(pid)];
      if (target === `${base}/task`) return [String(pid)];
      if (target === `${base}/fd`) return holder === "fd" ? ["3"] : [];
      return hostProc.readdir(target);
    },
    readlink: async (target) => {
      if (target === "/proc/self/ns/mnt") {
        mount ??= await hostProc.readlink(target);
        return mount;
      }
      if (
        target === `${base}/ns/mnt` ||
        target === `${base}/task/${pid}/ns/mnt`
      ) {
        mount ??= await hostProc.readlink("/proc/self/ns/mnt");
        return mount;
      }
      if (target === "/proc/self/root" || target === `${base}/root`) return "/";
      if (target === `${base}/cwd` || target === `${base}/task/${pid}/cwd`)
        return "/tmp";
      if (target === `${base}/exe`)
        return holder === "exe"
          ? path.join(worktreePath, "README.md")
          : "/usr/bin/node";
      if (target === `${base}/fd/3`)
        return holder === "fd"
          ? path.join(worktreePath, "README.md")
          : "/dev/null";
      return hostProc.readlink(target);
    },
  };
}

function rootUnreadableForeignProc(pid: number): ProcReader {
  const base = `/proc/${pid}`;
  const proc = rootDaemonHolderProc(pid, "/tmp/outside", "fd");
  return {
    ...proc,
    readFile: async (target) => {
      if (target === "/proc/self/status")
        return `Name:\tnode\nState:\tR (running)\nNSpid:\t${process.pid}\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nGroups:\t0\n`;
      if (target === `${base}/status`)
        return `Name:\tssh-agent\nState:\tS (sleeping)\nUid:\t501\t501\t501\t501\nGid:\t501\t501\t501\t501\nGroups:\t501\nCapEff:\t0000000000000000\n`;
      if (target === `${base}/comm`) return "ssh-agent\n";
      return proc.readFile(target);
    },
    readdir: async (target) => {
      if (target === `${base}/fd`)
        throw Object.assign(new Error("Permission denied"), {
          code: "EACCES",
        });
      return proc.readdir(target);
    },
    readlink: async (target) => {
      if (target === `${base}/exe`)
        throw Object.assign(new Error("Permission denied"), {
          code: "EACCES",
        });
      return proc.readlink(target);
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
  testHooks?: {
    afterFinalCheck?: (worktreePath: string, gitDir: string) => Promise<void>;
    afterDirectoryListed?: (
      directory: string,
      entries: readonly string[],
    ) => Promise<void>;
    beforeEntryRemoval?: (entry: string) => Promise<void>;
    beforeEntryRename?: (entry: string) => Promise<void>;
    afterEntryCheck?: (entry: string) => Promise<void>;
    afterEntryQuarantined?: (
      entry: string,
      quarantined: string,
    ) => Promise<void>;
  },
): Promise<void> {
  await Reflect.apply(removeWorktree, undefined, [
    { path: worktree.path, rootPath: worktree.root, testHooks },
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
  const holders = await import("./holders.js");
  holders.useLsofRunnerForTests?.(null);
});

describe("real worktree teardown preservation", () => {
  it("retains for a foreign uid with unreadable fd and exe paths even when comm is allowlisted", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(rootUnreadableForeignProc(4_000_000_102));
    const signal = vi.spyOn(process, "kill");
    const scan = await scanWorktreeHolders(worktree.path);
    expect(scan.status).toBe("unknown");
    await expect(remove(worktree)).rejects.toMatchObject({
      code: "worktree_preserved",
    });
    expect(signal).not.toHaveBeenCalled();
    await expect(access(worktree.path)).resolves.toBeUndefined();
    await expect(
      readFile(path.join(worktree.path, "README.md"), "utf8"),
    ).resolves.toBe("published\n");
  });

  it.each(["fd", "exe"] as const)(
    "retains a clean worktree for a foreign root-visible process with its %s inside",
    async (holder) => {
      const worktree = await makeWorktree();
      const pid = 4_000_000_101;
      useProcReaderForTests(rootDaemonHolderProc(pid, worktree.path, holder));
      const signal = vi.spyOn(process, "kill");
      const scan = await scanWorktreeHolders(worktree.path);
      expect(scan).toMatchObject({
        status: "held",
        holders: [{ pid, through: "open file" }],
      });
      await expect(remove(worktree)).rejects.toMatchObject({
        code: "worktree_preserved",
      });
      expect(signal).not.toHaveBeenCalled();
      await expect(access(worktree.path)).resolves.toBeUndefined();
      await expect(
        readFile(path.join(worktree.path, "README.md"), "utf8"),
      ).resolves.toBe("published\n");
    },
  );

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
      await remove(worktree).catch(() => undefined);
      await expect(access(worktree.path)).resolves.toBeUndefined();
      expect(await git(worktree.path, "status", "--porcelain")).not.toBe("");
    },
  );

  it("keeps ignored local data when force removal is requested", async () => {
    const worktree = await makeWorktree();
    const ignoredFile = path.join(worktree.path, ".env");
    await writeFile(ignoredFile, "local secret\n");
    await remove(worktree).catch(() => undefined);
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
    await expect(remove(worktree)).rejects.toMatchObject({
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

    await expect(remove(worktree)).rejects.toMatchObject({
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

    await expect(remove(worktree)).rejects.toMatchObject({
      code: "worktree_preserved",
    });
    expect(injected).toBe(true);
    expect(await git(worktree.path, "stash", "list")).toContain("late stash");
    await expect(access(worktree.path)).resolves.toBeUndefined();
  });

  it("retains a clean published worktree during a real bisect", async () => {
    const worktree = await makeWorktree();
    await writeFile(path.join(worktree.path, "bisect.txt"), "bisect\n");
    await git(worktree.path, "add", "bisect.txt");
    await git(
      worktree.path,
      "-c",
      "user.name=Worktree Test",
      "-c",
      "user.email=worktree@example.test",
      "commit",
      "-m",
      "bisect point",
    );
    await git(worktree.path, "push", "origin", "feature");
    await git(worktree.path, "bisect", "start", "HEAD", "HEAD^");
    useProcReaderForTests(descendantsOnly(hostProc, -1));

    await expect(remove(worktree)).rejects.toMatchObject({
      code: "worktree_preserved",
    });
    await expect(access(worktree.path)).resolves.toBeUndefined();
    expect(await git(worktree.path, "status", "--porcelain")).toBe("");
  });

  it("retains an untracked file created after the final check", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    let injected = false;
    let removalError: unknown;
    try {
      await remove(worktree, {
        afterFinalCheck: async (target) => {
          await writeFile(path.join(target, "late-untracked.txt"), "late\n");
          injected = true;
        },
      });
    } catch (error) {
      removalError = error;
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
    let lateCommitSha = "";
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
    let removalError: unknown;
    try {
      await remove(worktree, {
        afterFinalCheck: (target, gitDir) =>
          inject(target, gitDir, path.dirname(path.dirname(gitDir))),
      });
    } catch (error) {
      removalError = error;
    }
    expect(removalError).toMatchObject({ code: "worktree_preserved" });
    expect(injected, String(removalError)).toBe(true);
    expect(lateCommitSha).not.toBe("");
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

  it("retains a detached commit that is reachable only from the worktree reflog", async () => {
    const worktree = await makeWorktree();
    await git(worktree.path, "checkout", "--detach");
    await writeFile(path.join(worktree.path, "reflog-only.txt"), "commit\n");
    await git(worktree.path, "add", "reflog-only.txt");
    await git(worktree.path, "commit", "-m", "reflog-only commit");
    const commit = (await git(worktree.path, "rev-parse", "HEAD")).trim();
    await git(worktree.path, "checkout", "feature");
    await expect(remove(worktree)).rejects.toMatchObject({
      code: "worktree_preserved",
    });
    const reachable = await git(worktree.path, "rev-list", "--all", "--reflog");
    expect(reachable.split("\n")).toContain(commit);
  });

  it("retains a commit reachable only from a worktree ref after HEAD moves away", async () => {
    const worktree = await makeWorktree();
    await git(worktree.path, "checkout", "--detach");
    await writeFile(path.join(worktree.path, "worktree-ref.txt"), "commit\n");
    await git(worktree.path, "add", "worktree-ref.txt");
    await git(worktree.path, "commit", "-m", "worktree ref commit");
    const commit = (await git(worktree.path, "rev-parse", "HEAD")).trim();
    await git(worktree.path, "update-ref", "refs/worktree/recovery", commit);
    await git(worktree.path, "checkout", "feature");
    await expect(remove(worktree)).rejects.toMatchObject({
      code: "worktree_preserved",
    });
    const ref = await git(worktree.path, "rev-parse", "refs/worktree/recovery");
    expect(ref.trim()).toBe(commit);
  });

  it("retains an edited tracked file marked skip-worktree", async () => {
    const worktree = await makeWorktree();
    await git(worktree.path, "update-index", "--skip-worktree", "README.md");
    await writeFile(path.join(worktree.path, "README.md"), "hidden edit\n");
    expect(await git(worktree.path, "status", "--porcelain")).toBe("");
    await expect(remove(worktree)).rejects.toMatchObject({
      code: "worktree_preserved",
    });
    await expect(
      readFile(path.join(worktree.path, "README.md"), "utf8"),
    ).resolves.toBe("hidden edit\n");
  });

  it("reports an interrupted quarantine as retained instead of removable", async () => {
    const worktree = await makeWorktree();
    const quarantined = path.join(
      path.dirname(worktree.path),
      `.${path.basename(worktree.path)}.removing-crash`,
    );
    await fs.rename(worktree.path, quarantined);
    await expect(remove(worktree)).rejects.toMatchObject({
      code: "worktree_preserved",
    });
    await expect(access(quarantined)).resolves.toBeUndefined();
    await expect(
      readFile(path.join(quarantined, "README.md"), "utf8"),
    ).resolves.toBe("published\n");
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
    let removalError: unknown;
    try {
      await remove(worktree, {
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

  it("retains a same-size edit made after entry check and before rename", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    const entryPath = path.join(worktree.path, ".gitignore");
    const originalStat = await fs.stat(entryPath);
    await expect(
      remove(worktree, {
        beforeEntryRename: async (entry) => {
          if (path.basename(entry) !== ".gitignore") return;
          expect((await fs.stat(entry)).mode & 0o222).toBe(0);
          await expect(fs.open(entry, "r+")).rejects.toMatchObject({
            code: "EACCES",
          });
          await fs.chmod(entry, originalStat.mode & 0o7777);
          const handle = await fs.open(entry, "r+");
          try {
            await handle.writeFile(".xxx\n");
          } finally {
            await handle.close();
          }
          await utimes(
            entry,
            originalStat.atimeMs / 1000,
            originalStat.mtimeMs / 1000,
          );
          await fs.chmod(entry, originalStat.mode & ~0o222);
        },
      }),
    ).rejects.toMatchObject({ code: "worktree_preserved" });
    await expect(
      access(path.join(worktree.path, ".git")),
    ).resolves.toBeUndefined();
    await expect(readFile(entryPath, "utf8")).resolves.toBe(".xxx\n");
    expect((await fs.stat(entryPath)).mode & 0o7777).toBe(
      originalStat.mode & 0o7777,
    );
    await expect(git(worktree.path, "rev-parse", "--git-dir")).resolves.toMatch(
      /worktrees/u,
    );
  });

  it("restores the selected file and modes when a sibling appears before quarantine", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    const lateDirectory = path.join(worktree.path, "late-dir");
    await mkdir(lateDirectory);
    await writeFile(path.join(lateDirectory, "a-old.txt"), "old\n");
    await writeFile(path.join(lateDirectory, "b-trigger.txt"), "trigger\n");
    await writeFile(path.join(lateDirectory, "c-remaining.txt"), "remaining\n");
    await fs.chmod(path.join(lateDirectory, "a-old.txt"), 0o600);
    await fs.chmod(path.join(lateDirectory, "b-trigger.txt"), 0o640);
    await fs.chmod(path.join(lateDirectory, "c-remaining.txt"), 0o604);
    await git(worktree.path, "add", "late-dir");
    await git(worktree.path, "commit", "-m", "published quarantine siblings");
    await git(worktree.path, "push", "origin", "feature");
    let injected = false;
    const result = await removeDirectoryTree(worktree.path, {
      startedAt: Number.MAX_SAFE_INTEGER,
      beforeEntryRename: async (entry) => {
        if (!entry.endsWith("late-dir/b-trigger.txt") || injected) return;
        injected = true;
        await writeFile(path.join(lateDirectory, "late-file.txt"), "kept\n");
      },
    });

    expect(result).toBe("retained");
    expect(injected).toBe(true);
    await expect(
      access(path.join(lateDirectory, "a-old.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(lateDirectory, "b-trigger.txt"), "utf8"),
    ).resolves.toBe("trigger\n");
    await expect(
      readFile(path.join(lateDirectory, "c-remaining.txt"), "utf8"),
    ).resolves.toBe("remaining\n");
    await expect(
      readFile(path.join(lateDirectory, "late-file.txt"), "utf8"),
    ).resolves.toBe("kept\n");
    expect(
      await fs
        .stat(path.join(lateDirectory, "b-trigger.txt"))
        .then((s) => s.mode & 0o7777),
    ).toBe(0o640);
    expect(
      await fs
        .stat(path.join(lateDirectory, "c-remaining.txt"))
        .then((s) => s.mode & 0o7777),
    ).toBe(0o604);
    expect(
      (await fs.readdir(lateDirectory)).filter((name) =>
        name.startsWith(".bb-removing-"),
      ),
    ).toEqual([]);
    await expect(git(worktree.path, "rev-parse", "--git-dir")).resolves.toMatch(
      /worktrees/u,
    );
  });

  it("leaves no quarantine entries after clean removal", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    const parent = path.dirname(worktree.path);
    const renamedEntries: string[] = [];
    const result = await removeDirectoryTree(worktree.path, {
      startedAt: Number.MAX_SAFE_INTEGER,
      afterEntryCheck: async (entry) => {
        renamedEntries.push(`checked:${path.basename(entry)}`);
      },
      beforeEntryRename: async (entry) => {
        renamedEntries.push(`rename:${path.basename(entry)}`);
      },
      afterEntryQuarantined: async (entry) => {
        renamedEntries.push(`quarantined:${path.basename(entry)}`);
      },
    });
    expect(result, renamedEntries.join("\n")).toBe("removed");
    await expect(access(worktree.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const siblings = await fs.readdir(parent);
    expect(siblings.filter((name) => name.startsWith(".bb-removing-"))).toEqual(
      [],
    );
    expect(siblings.filter((name) => name.startsWith(".bb-gitfile-"))).toEqual(
      [],
    );
  });

  it("retains a file modified after quarantine when its mtime changes", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    const state: {
      handle?: Awaited<ReturnType<typeof fs.open>>;
      originalTimes?: { atimeMs: number; mtimeMs: number; mode: number };
    } = {};
    try {
      await expect(
        remove(worktree, {
          afterEntryCheck: async (entry) => {
            if (!entry.endsWith("/README.md")) return;
            const opened = await fs.open(entry, "r+");
            state.handle = opened;
            state.originalTimes = await opened.stat();
          },
          afterEntryQuarantined: async (entry) => {
            const opened = state.handle;
            if (!entry.endsWith("/README.md") || opened === undefined) return;
            await opened.writeFile("late-data\n");
          },
        }),
      ).rejects.toMatchObject({ code: "worktree_preserved" });
    } finally {
      await state.handle?.close();
    }
    await expect(
      readFile(path.join(worktree.path, "README.md"), "utf8"),
    ).resolves.toBe("late-data\n");
    const originalTimes = state.originalTimes;
    if (originalTimes === undefined) throw new Error("missing file stat");
    const restoredStat = await fs.stat(path.join(worktree.path, "README.md"));
    expect(restoredStat.mtimeMs).not.toBe(originalTimes.mtimeMs);
    expect(restoredStat.mode & 0o7777).toBe(originalTimes.mode & 0o7777);
  });

  it("retains an in-place edit made after entry check even when its mtime is restored", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    const stableMtime = Math.floor(Date.now() / 1000) - 10;
    await utimes(
      path.join(worktree.path, ".gitignore"),
      stableMtime,
      stableMtime,
    );
    let originalTimes: { atimeMs: number; mtimeMs: number } | undefined;
    let injected = false;
    const checkedEntries: string[] = [];

    await expect(
      remove(worktree, {
        afterEntryCheck: async (entry) => {
          checkedEntries.push(entry);
          if (path.basename(entry) !== ".gitignore" || injected) return;
          injected = true;
          const opened = await fs.open(entry, "r+");
          try {
            const before = await opened.stat();
            originalTimes = before;
            await opened.writeFile(".xxx\n");
            let changed = await opened.stat();
            const deadline = Date.now() + 1_000;
            while (
              changed.ctimeMs === before.ctimeMs &&
              Date.now() < deadline
            ) {
              await delay(5);
              changed = await opened.stat();
            }
            expect(changed.ctimeMs).not.toBe(before.ctimeMs);
            await utimes(entry, before.atimeMs / 1000, before.mtimeMs / 1000);
            expect((await opened.stat()).mtimeMs).toBe(before.mtimeMs);
          } finally {
            await opened.close();
          }
        },
      }),
    ).rejects.toMatchObject({ code: "worktree_preserved" });

    expect(injected).toBe(true);
    await expect(
      readFile(path.join(worktree.path, ".gitignore"), "utf8"),
    ).resolves.toBe(".xxx\n");
    await expect(git(worktree.path, "rev-parse", "--git-dir")).resolves.toMatch(
      /worktrees/u,
    );
    if (originalTimes === undefined) throw new Error("missing original times");
    const after = await fs.stat(path.join(worktree.path, ".gitignore"));
    expect(after.mtimeMs).toBeCloseTo(originalTimes.mtimeMs, 0);
  });

  removeDirectoryTreeTest(
    "retains a same-size edit with restored mtime between precise entry snapshots",
    async () => {
      const worktree = await makeWorktree();
      const entry = path.join(worktree.path, ".gitignore");
      const original = await fs.stat(entry);
      let injected = false;
      const edited = ".xxx\n";
      const result = await removeDirectoryTree(worktree.path, {
        startedAt: Number.MAX_SAFE_INTEGER,
        afterEntryCheck: async (checkedEntry) => {
          if (!checkedEntry.endsWith("/.gitignore")) return;
          injected = true;
          const before = await fs.stat(entry, { bigint: true });
          expect(Buffer.byteLength(edited)).toBe(Number(before.size));
          await writeFile(entry, edited);
          await utimes(entry, original.atimeMs / 1000, original.mtimeMs / 1000);
        },
      });

      expect(injected).toBe(true);
      expect(result).toBe("retained");
      await expect(readFile(entry, "utf8")).resolves.toBe(edited);
      await expect(
        git(worktree.path, "rev-parse", "--git-dir"),
      ).resolves.toMatch(/worktrees/u);
    },
  );

  it("retains a replacement directory created before directory removal", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    const initialDirectory = path.join(worktree.path, "replace-me");
    await mkdir(initialDirectory);
    await writeFile(path.join(initialDirectory, "original.txt"), "original\n");
    await git(worktree.path, "add", "replace-me");
    await git(worktree.path, "commit", "-m", "published replacement directory");
    await git(worktree.path, "push", "origin", "feature");
    let replaced = false;
    await expect(
      remove(worktree, {
        afterEntryCheck: async (entry) => {
          if (!entry.endsWith("/replace-me") || replaced) return;
          replaced = true;
          const saved = path.join(path.dirname(entry), "saved-directory");
          await fs.rename(entry, saved);
          await mkdir(entry);
          await writeFile(path.join(entry, "replacement.txt"), "replacement\n");
        },
      }),
    ).rejects.toMatchObject({ code: "worktree_preserved" });
    expect(replaced).toBe(true);
    await expect(
      access(path.join(worktree.path, "saved-directory")),
    ).resolves.toBeUndefined();
    await expect(
      readFile(
        path.join(worktree.path, "replace-me", "replacement.txt"),
        "utf8",
      ),
    ).resolves.toBe("replacement\n");
    await expect(
      access(path.join(worktree.path, ".git")),
    ).resolves.toBeUndefined();
  });

  it("retains an entry left in quarantine by an interrupted removal", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "bb-removal-quarantine-"),
    );
    roots.push(root);
    const quarantined = path.join(root, ".bb-removing-interrupted");
    await writeFile(quarantined, "recoverable\n");
    const result = await removeDirectoryTree(root, {
      startedAt: Date.now() + 10_000,
    });
    expect(result).toBe("retained");
    await expect(readFile(quarantined, "utf8")).resolves.toBe("recoverable\n");
  });

  it("keeps the worktree root marker and siblings after partial removal meets late data", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    await mkdir(path.join(worktree.path, "late-dir"));
    await writeFile(path.join(worktree.path, "late-dir", "old.txt"), "old\n");
    await git(worktree.path, "add", "late-dir/old.txt");
    await git(
      worktree.path,
      "commit",
      "-m",
      "published partial-removal directory",
    );
    await git(worktree.path, "push", "origin", "feature");
    let injected = false;
    await expect(
      remove(worktree, {
        afterDirectoryListed: async (directory) => {
          if (!directory.endsWith("late-dir") || injected) return;
          injected = true;
          await writeFile(path.join(directory, "late-file"), "kept\n");
        },
      }),
    ).rejects.toMatchObject({
      code: "worktree_preserved",
      message: expect.stringContaining("may be partially removed"),
    });
    expect(injected).toBe(true);
    await expect(
      access(path.join(worktree.path, ".git")),
    ).resolves.toBeUndefined();
    await expect(
      readFile(path.join(worktree.path, "README.md"), "utf8"),
    ).resolves.toBe("published\n");
    await expect(
      readFile(path.join(worktree.path, "late-dir", "late-file"), "utf8"),
    ).resolves.toBe("kept\n");
    await expect(
      readFile(path.join(worktree.path, "late-dir", "old.txt"), "utf8"),
    ).resolves.toBe("old\n");
  });

  removeDirectoryTreeTest(
    "restores the git marker when late data appears after it is detached",
    async () => {
      const worktree = await makeWorktree();
      let injected = false;
      const result = await removeDirectoryTree(worktree.path, {
        startedAt: Date.now() + 10_000,
        afterRootMarkerDetached: async (root) => {
          injected = true;
          await writeFile(path.join(root, "late-after-marker.txt"), "late\n");
        },
      });

      expect(injected).toBe(true);
      expect(result).toBe("retained");
      expect(
        (await git(worktree.path, "rev-parse", "--git-dir")).trim(),
      ).not.toBe("");
      await expect(git(worktree.path, "worktree", "list")).resolves.toContain(
        worktree.path,
      );
      await expect(
        readFile(path.join(worktree.path, "late-after-marker.txt"), "utf8"),
      ).resolves.toBe("late\n");
      expect(
        (await fs.readdir(path.dirname(worktree.path))).filter((name) =>
          name.startsWith(".bb-gitfile-"),
        ),
      ).toEqual([]);
    },
  );

  it("retains a new sibling after an earlier child is removed and keeps the git marker usable", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    const lateDirectory = path.join(worktree.path, "late-dir");
    await mkdir(lateDirectory);
    await writeFile(path.join(lateDirectory, "a-old.txt"), "old\n");
    await writeFile(path.join(lateDirectory, "b-trigger.txt"), "trigger\n");
    await writeFile(path.join(lateDirectory, "c-remaining.txt"), "remaining\n");
    await git(worktree.path, "add", "late-dir");
    await git(
      worktree.path,
      "commit",
      "-m",
      "published partial-removal entries",
    );
    await git(worktree.path, "push", "origin", "feature");
    let injected = false;
    const result = await removeDirectoryTree(worktree.path, {
      startedAt: Number.MAX_SAFE_INTEGER,
      beforeEntryRemoval: async (entry) => {
        if (!entry.endsWith("late-dir/b-trigger.txt") || injected) return;
        expect(existsSync(path.join(lateDirectory, "a-old.txt"))).toBe(false);
        injected = true;
        await writeFile(
          path.join(path.dirname(entry), "late-file.txt"),
          "kept\n",
        );
      },
    });
    expect(result).toBe("retained");
    expect(injected).toBe(true);
    await expect(
      access(path.join(worktree.path, ".git")),
    ).resolves.toBeUndefined();
    await expect(git(worktree.path, "rev-parse", "--git-dir")).resolves.toMatch(
      /worktrees/u,
    );
    await expect(
      readFile(path.join(worktree.path, "README.md"), "utf8"),
    ).resolves.toBe("published\n");
    await expect(
      readFile(path.join(lateDirectory, "late-file.txt"), "utf8"),
    ).resolves.toBe("kept\n");
    await expect(
      readFile(path.join(lateDirectory, "b-trigger.txt"), "utf8"),
    ).resolves.toBe("trigger\n");
    await expect(
      readFile(path.join(lateDirectory, "c-remaining.txt"), "utf8"),
    ).resolves.toBe("remaining\n");
    await expect(
      access(path.join(lateDirectory, "a-old.txt")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retains a directory child when a late sibling appears during its removal", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    const lateDirectory = path.join(worktree.path, "late-dir");
    await mkdir(lateDirectory);
    await mkdir(path.join(lateDirectory, "a-old-dir"));
    await writeFile(path.join(lateDirectory, "a-old-dir", "old.txt"), "old\n");
    await mkdir(path.join(lateDirectory, "b-dir"));
    await writeFile(
      path.join(lateDirectory, "b-dir", "inside.txt"),
      "inside\n",
    );
    await writeFile(path.join(lateDirectory, "c-remaining.txt"), "remaining\n");
    await git(worktree.path, "add", "late-dir");
    await git(worktree.path, "commit", "-m", "published directory children");
    await git(worktree.path, "push", "origin", "feature");
    let injected = false;
    const result = await removeDirectoryTree(worktree.path, {
      startedAt: Number.MAX_SAFE_INTEGER,
      beforeEntryRemoval: async (entry) => {
        if (!entry.endsWith("late-dir/b-dir") || injected) return;
        injected = true;
        await writeFile(path.join(lateDirectory, "late-file.txt"), "kept\n");
      },
    });

    expect(result).toBe("retained");
    expect(injected).toBe(true);
    await expect(
      readFile(path.join(lateDirectory, "late-file.txt"), "utf8"),
    ).resolves.toBe("kept\n");
    await expect(
      readFile(path.join(lateDirectory, "b-dir", "inside.txt"), "utf8"),
    ).resolves.toBe("inside\n");
    await expect(
      readFile(path.join(lateDirectory, "c-remaining.txt"), "utf8"),
    ).resolves.toBe("remaining\n");
    await expect(
      access(path.join(lateDirectory, "a-old-dir")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(git(worktree.path, "rev-parse", "--git-dir")).resolves.toMatch(
      /worktrees/u,
    );
  });

  it("restores a directory child's mode when a sibling appears at quarantine", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    const lateDirectory = path.join(worktree.path, "late-dir");
    await mkdir(lateDirectory);
    await mkdir(path.join(lateDirectory, "a-old-dir"));
    await writeFile(path.join(lateDirectory, "a-old-dir", "old.txt"), "old\n");
    await mkdir(path.join(lateDirectory, "b-dir"));
    await fs.chmod(path.join(lateDirectory, "b-dir"), 0o750);
    await git(worktree.path, "add", "late-dir");
    await git(worktree.path, "commit", "-m", "published directory quarantine");
    await git(worktree.path, "push", "origin", "feature");
    let injected = false;
    const result = await removeDirectoryTree(worktree.path, {
      startedAt: Number.MAX_SAFE_INTEGER,
      beforeEntryRename: async (entry) => {
        if (!entry.endsWith("late-dir/b-dir") || injected) return;
        injected = true;
        await writeFile(path.join(lateDirectory, "late-file.txt"), "kept\n");
      },
    });

    expect(result).toBe("retained");
    expect(injected).toBe(true);
    await expect(
      access(path.join(lateDirectory, "a-old-dir")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(path.join(lateDirectory, "b-dir")),
    ).resolves.toBeUndefined();
    expect(
      (await fs.stat(path.join(lateDirectory, "b-dir"))).mode & 0o7777,
    ).toBe(0o750);
    await expect(
      readFile(path.join(lateDirectory, "late-file.txt"), "utf8"),
    ).resolves.toBe("kept\n");
    expect(
      (await fs.readdir(lateDirectory)).filter((name) =>
        name.startsWith(".bb-removing-"),
      ),
    ).toEqual([]);
  });

  it("removes a clean worktree on macOS when lsof reports no open paths", async () => {
    const worktree = await makeWorktree();
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    const holders = await import("./holders.js");
    holders.useLsofRunnerForTests?.(async () => ({
      code: 1,
      stdout: "",
      stderr: "",
      spawnFailed: false,
    }));
    try {
      await remove(worktree);
      await expect(access(worktree.path)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (platform !== undefined)
        Object.defineProperty(process, "platform", platform);
    }
  });

  it("refuses Windows teardown without touching the worktree", async () => {
    const worktree = await makeWorktree();
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    try {
      await expect(remove(worktree)).rejects.toMatchObject({
        code: "worktree_preserved",
      });
      await expect(access(worktree.path)).resolves.toBeUndefined();
      await expect(
        access(path.join(worktree.path, ".git")),
      ).resolves.toBeUndefined();
      await expect(
        readFile(path.join(worktree.path, "README.md"), "utf8"),
      ).resolves.toBe("published\n");
    } finally {
      if (platform !== undefined)
        Object.defineProperty(process, "platform", platform);
    }
  });

  removeDirectoryTreeTest(
    "does not follow a directory replaced by a symlink during removal",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "bb-remove-tree-race-"),
      );
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
    },
  );

  removeDirectoryTreeTest(
    "retains a root directory changed after recursive removal starts",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "bb-remove-root-race-"),
      );
      roots.push(root);
      const target = path.join(root, "target");
      await mkdir(target);
      await writeFile(path.join(target, "entry.txt"), "keep\n");
      const result = await removeDirectoryTree(target, {
        afterStart: async (startedAt) => {
          await fs.chmod(target, 0o700);
          await fs.utimes(
            target,
            new Date(startedAt + 10_000),
            new Date(startedAt + 10_000),
          );
        },
      });
      expect(result).toBe("retained");
      await expect(
        readFile(path.join(target, "entry.txt"), "utf8"),
      ).resolves.toBe("keep\n");
    },
  );

  it("retains Git metadata created while pruning the severed admin directory", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    let injected = false;
    let severedGitDir: string | null = null;
    let removalError: unknown;
    try {
      await remove(worktree, {
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
    "retains a worktree when an unreadable same-user process is not an allowlisted session agent",
    async () => {
      const worktree = await makeWorktree();
      const uid = process.getuid?.() ?? process.geteuid?.() ?? 1000;
      const gid = process.getgid?.() ?? process.getegid?.() ?? 1000;
      const base = descendantsOnly(hostProc, -1);
      useProcReaderForTests({
        ...base,
        readdir: async (target) =>
          target === "/proc"
            ? [String(process.pid), "100100"]
            : base.readdir(target),
        readFile: async (target) =>
          target === "/proc/100100/status"
            ? `Name:\tunrelated\nState:\tS (sleeping)\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${gid}\t${gid}\t${gid}\t${gid}\nNSpid:\t100100\n`
            : base.readFile(target),
        readlink: async (target) => {
          if (target === "/proc/100100/ns/mnt")
            throw Object.assign(new Error("Permission denied"), {
              code: "EACCES",
            });
          return base.readlink(target);
        },
      });
      await expect(remove(worktree)).rejects.toMatchObject({
        code: "worktree_preserved",
      });
      await expect(access(worktree.path)).resolves.toBeUndefined();
      await expect(
        readFile(path.join(worktree.path, "README.md"), "utf8"),
      ).resolves.toBe("published\n");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "removes a worktree inaccessible to a foreign uid with a readable outside cwd",
    async () => {
      const root = await mkdtemp(path.join("/tmp", "bb-preserve-worktree-"));
      const worktree = await makeWorktree(root);
      await fs.chmod(root, 0o755);
      await fs.chmod(worktree.path, 0o700);
      useProcReaderForTests(foreignReadableOutsideCwdProc(100102));
      const signal = vi.spyOn(process, "kill");

      await remove(worktree);
      expect(signal).not.toHaveBeenCalled();
      await expect(access(worktree.path)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.skipIf(process.platform !== "linux")(
    "retains a worktree reachable by a foreign uid with a readable outside cwd without signalling a process",
    async () => {
      const root = await mkdtemp(path.join("/tmp", "bb-preserve-worktree-"));
      const worktree = await makeWorktree(root);
      await fs.chmod(root, 0o755);
      useProcReaderForTests(foreignReadableOutsideCwdProc(100101));
      const signal = vi.spyOn(process, "kill");

      await expect(remove(worktree)).rejects.toMatchObject({
        code: "worktree_preserved",
      });
      expect(signal).not.toHaveBeenCalled();
      await expect(access(worktree.path)).resolves.toBeUndefined();
      await expect(
        readFile(path.join(worktree.path, "README.md"), "utf8"),
      ).resolves.toBe("published\n");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "keeps an uncertain foreign-user holder without signalling any process",
    async () => {
      const root = await mkdtemp(path.join("/tmp", "bb-preserve-worktree-"));
      const worktree = await makeWorktree(root);
      await fs.chmod(path.dirname(worktree.root), 0o755);
      const worker = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          cwd: worktree.path,
          stdio: "ignore",
        },
      );
      workers.push(worker);
      await new Promise<void>((resolve, reject) => {
        worker.once("spawn", resolve);
        worker.once("error", reject);
      });
      await fs.chmod(worktree.root, 0o711);
      useProcReaderForTests(foreignUnreadableCwdProc(worker.pid ?? -1));
      const signal = vi.spyOn(process, "kill");

      await expect(remove(worktree)).rejects.toMatchObject({
        code: "worktree_preserved",
      });

      expect(signal).not.toHaveBeenCalled();
      expect(() => process.kill(worker.pid!, 0)).not.toThrow();
      await expect(access(worktree.path)).resolves.toBeUndefined();
      expect(await git(worktree.path, "status", "--porcelain")).toBe("");
    },
  );

  it.skipIf(
    process.platform !== "linux" ||
      (typeof process.getuid === "function" && process.getuid() === 0),
  )(
    "retains the worktree without signalling when an unreadable foreign cwd can traverse a group-execute-only ancestor",
    async () => {
      const root = await mkdtemp(
        path.join("/tmp", "bb-preserve-worktree-group-"),
      );
      const worktree = await makeWorktree(root);
      await fs.chmod(worktree.path, 0o710);
      const worker = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { cwd: worktree.path, stdio: "ignore" },
      );
      workers.push(worker);
      await new Promise<void>((resolve, reject) => {
        worker.once("spawn", resolve);
        worker.once("error", reject);
      });
      await fs.chmod(root, 0o710);
      const processGroup = process.getgid?.() ?? process.getegid?.() ?? 1000;
      const proc = foreignUnreadableCwdProc(worker.pid ?? -1, [processGroup]);
      useProcReaderForTests(proc);
      const status = await proc.readFile(`/proc/${worker.pid}/status`);
      const worktreeInfo = await fs.stat(worktree.path);
      const statusGroups = /^Groups:\s*(.*)$/mu
        .exec(status)?.[1]
        ?.split(/\s+/u)
        .map(Number);
      expect(statusGroups).toContain(processGroup);
      expect(worktreeInfo.mode & 0o777).toBe(0o710);
      expect(worktreeInfo.gid).toBe(processGroup);
      const signal = vi.spyOn(process, "kill");

      const scan = await scanWorktreeHolders(worktree.path);
      expect(scan).toMatchObject({
        status: "uncertain",
      });

      await expect(remove(worktree)).rejects.toMatchObject({
        code: "worktree_preserved",
      });

      expect(signal).not.toHaveBeenCalled();
      expect(() => process.kill(worker.pid!, 0)).not.toThrow();
      await expect(access(worktree.path)).resolves.toBeUndefined();
      expect(
        await readFile(path.join(worktree.path, "README.md"), "utf8"),
      ).toBe("published\n");
    },
  );

  it.skipIf(
    process.platform !== "linux" ||
      (typeof process.getuid === "function" && process.getuid() === 0),
  )(
    "removes a clean worktree when a genuinely foreign unreadable process cannot traverse group-only access",
    async () => {
      const root = await mkdtemp(
        path.join("/tmp", "bb-preserve-worktree-foreign-group-"),
      );
      const worktree = await makeWorktree(root);
      await fs.chmod(worktree.path, 0o710);
      const worker = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { cwd: worktree.path, stdio: "ignore" },
      );
      workers.push(worker);
      await new Promise<void>((resolve, reject) => {
        worker.once("spawn", resolve);
        worker.once("error", reject);
      });
      await fs.chmod(root, 0o710);
      const proc = foreignUnreadableCwdProc(worker.pid ?? -1);
      const status = await proc.readFile(`/proc/${worker.pid}/status`);
      const daemonUid = process.getuid?.() ?? process.geteuid?.() ?? 1000;
      const daemonGid = process.getgid?.() ?? process.getegid?.() ?? 1000;
      const uidValues = /^Uid:\s*(.*)$/mu
        .exec(status)?.[1]
        ?.split(/\s+/u)
        .map(Number);
      const gidValues = /^Gid:\s*(.*)$/mu
        .exec(status)?.[1]
        ?.split(/\s+/u)
        .map(Number);
      expect(uidValues).toHaveLength(4);
      expect(gidValues).toHaveLength(4);
      expect(uidValues?.every((uid) => uid !== daemonUid)).toBe(true);
      expect(gidValues?.every((gid) => gid !== daemonGid)).toBe(true);
      useProcReaderForTests(proc);

      await expect(remove(worktree)).resolves.toBeUndefined();
      await expect(access(worktree.path)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(() => process.kill(worker.pid!, 0)).not.toThrow();
    },
  );
});
