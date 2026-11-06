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
import type { RemoveDirectoryTreeResult } from "bb-environment-provider-host/remove-directory-tree";
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

function errorRetainedPaths(error: unknown): string[] {
  if (
    error === null ||
    typeof error !== "object" ||
    !("retainedPaths" in error)
  )
    return [];
  const paths: unknown = error.retainedPaths;
  return Array.isArray(paths)
    ? paths.filter(
        (retainedPath): retainedPath is string =>
          typeof retainedPath === "string",
      )
    : [];
}

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
    beforeCollisionMove?: (
      source: string,
      candidate: string,
      isDirectory: boolean,
    ) => Promise<void>;
    afterCollisionCandidateVerified?: (
      source: string,
      candidate: string,
      isDirectory: boolean,
    ) => Promise<void>;
    afterEntryQuarantined?: (
      entry: string,
      quarantined: string,
    ) => Promise<void>;
    afterParentVerified?: (entry: string, quarantined: string) => Promise<void>;
    afterRestoreNameCheck?: (
      source: string,
      destination: string,
      isDirectory: boolean,
    ) => Promise<void>;
    beforeQuarantineRestoreLink?: (
      source: string,
      destination: string,
    ) => Promise<void>;
    beforeGitMarkerRestoreLink?: (
      source: string,
      destination: string,
    ) => Promise<void>;
    beforeQuarantinePinLink?: (source: string, pin: string) => Promise<void>;
    recoveryLink?: (pin: string, destination: string) => Promise<void>;
    recoveryWrite?: (
      destination: Awaited<ReturnType<typeof fs.open>>,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => Promise<{ bytesWritten: number }>;
    beforePinCleanup?: (pin: string, restoredPath: string) => Promise<void>;
    createPinSuffix?: () => string;
    afterGitMarkerLinked?: (
      source: string,
      destination: string,
    ) => Promise<void>;
    readDirectoryNames?: (directory: string) => Promise<string[]>;
    onRetainedPath?: (retainedPath: string) => void;
    afterRootMarkerDetached?: (root: string) => Promise<void>;
  },
): Promise<RemoveDirectoryTreeResult> {
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

function foreignReadableOutsideCwdProc(
  pid: number,
  worktreePath: string,
  capEff = "0000000000000000",
): ProcReader {
  const foreignUid = 60_000;
  const foreignGid = 61_000;
  return {
    ...hostProc,
    readFile: async (target) => {
      if (target === "/proc/self/status")
        return `Name:\tnode\nState:\tR (running)\nNSpid:\t${process.pid}\nUid:\t2000\t2000\t2000\t2000\nGid:\t2000\t2000\t2000\t2000\nGroups:\t2000\n`;
      if (target === `/proc/${pid}/status`)
        return `Name:\tforeign\nState:\tS (sleeping)\nUid:\t${foreignUid}\t${foreignUid}\t${foreignUid}\t${foreignUid}\nGid:\t${foreignGid}\t${foreignGid}\t${foreignGid}\t${foreignGid}\nGroups:\t${foreignGid}\nCapEff:\t${capEff}\n`;
      return hostProc.readFile(target);
    },
    readdir: async (target) => {
      if (target === "/proc") return [String(process.pid), String(pid)];
      if (target === `/proc/${pid}/task`) return [String(pid)];
      if (target === `/proc/${pid}/fd`) return ["3"];
      return hostProc.readdir(target);
    },
    readlink: async (target) => {
      if (
        target === `/proc/${pid}/cwd` ||
        (target.startsWith(`/proc/${pid}/task/`) && target.endsWith("/cwd"))
      )
        return "/tmp";
      if (target === `/proc/${pid}/fd/3`)
        return path.join(worktreePath, "README.md");
      return hostProc.readlink(target);
    },
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
    beforeQuarantinePinLink?: (source: string, pin: string) => Promise<void>;
    recoveryLink?: (pin: string, destination: string) => Promise<void>;
    recoveryWrite?: (
      destination: Awaited<ReturnType<typeof fs.open>>,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => Promise<{ bytesWritten: number }>;
    beforePinCleanup?: (pin: string, restoredPath: string) => Promise<void>;
    createPinSuffix?: () => string;
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
    const retainedPaths: string[] = [];
    const result = await removeDirectoryTree(worktree.path, {
      startedAt: Number.MAX_SAFE_INTEGER,
      beforeEntryRename: async (entry) => {
        if (!entry.endsWith("late-dir/b-trigger.txt") || injected) return;
        injected = true;
        await writeFile(path.join(lateDirectory, "late-file.txt"), "kept\n");
      },
      onRetainedPath: (retainedPath) => retainedPaths.push(retainedPath),
    });

    expect(result.status).toBe("retained");
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
    const duplicateName = (await fs.readdir(lateDirectory)).find((name) =>
      name.startsWith(".bb-removing-"),
    );
    expect(duplicateName).toBeDefined();
    const duplicatePath = path.join(lateDirectory, duplicateName!);
    expect(retainedPaths).toContain(duplicatePath);
    const restoredInfo = await fs.stat(
      path.join(lateDirectory, "b-trigger.txt"),
    );
    const duplicateInfo = await fs.stat(duplicatePath);
    expect(duplicateInfo.ino).toBe(restoredInfo.ino);
    expect(duplicateInfo.dev).toBe(restoredInfo.dev);
    await expect(readFile(duplicatePath, "utf8")).resolves.toBe("trigger\n");
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
    expect(result.status, renamedEntries.join("\n")).toBe("removed");
    expect(result.retainedPaths).toEqual([]);
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

  it("retains a file modified after quarantine when its mtime is restored", async () => {
    const worktree = await makeWorktree();
    useProcReaderForTests(descendantsOnly(hostProc, -1));
    const stableMtime = Math.floor(Date.now() / 1000) - 10;
    await utimes(
      path.join(worktree.path, "README.md"),
      stableMtime,
      stableMtime,
    );
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
          afterEntryQuarantined: async (entry, quarantined) => {
            const opened = state.handle;
            if (!entry.endsWith("/README.md") || opened === undefined) return;
            await opened.writeFile("late-data\n");
            const originalTimes = state.originalTimes;
            if (originalTimes === undefined)
              throw new Error("missing original file times");
            await utimes(
              quarantined,
              originalTimes.atimeMs / 1000,
              originalTimes.mtimeMs / 1000,
            );
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
    expect(restoredStat.mtimeMs).toBeCloseTo(originalTimes.mtimeMs, 0);
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
      expect(result.status).toBe("retained");
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
    expect(result.status).toBe("retained");
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
      let duplicateMarkerPath = "";
      const result = await removeDirectoryTree(worktree.path, {
        startedAt: Date.now() + 10_000,
        afterRootMarkerDetached: async (root) => {
          injected = true;
          await writeFile(path.join(root, "late-after-marker.txt"), "late\n");
        },
        onRetainedPath: (retainedPath) => {
          if (path.basename(retainedPath).startsWith(".bb-gitfile-"))
            duplicateMarkerPath = retainedPath;
        },
      });

      expect(injected).toBe(true);
      expect(result.status).toBe("retained");
      expect(
        (await git(worktree.path, "rev-parse", "--git-dir")).trim(),
      ).not.toBe("");
      await expect(git(worktree.path, "worktree", "list")).resolves.toContain(
        worktree.path,
      );
      await expect(
        readFile(path.join(worktree.path, "late-after-marker.txt"), "utf8"),
      ).resolves.toBe("late\n");
      expect(duplicateMarkerPath).not.toBe("");
      const markerInfo = await fs.lstat(path.join(worktree.path, ".git"));
      const duplicateInfo = await fs.lstat(duplicateMarkerPath);
      expect(duplicateInfo.ino).toBe(markerInfo.ino);
      expect(duplicateInfo.dev).toBe(markerInfo.dev);
    },
  );

  removeDirectoryTreeTest(
    "retains a symlink racer and the original link when a racer takes its restore name",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "bb-preserve-symlink-"),
      );
      roots.push(root);
      const originalLink = path.join(root, "original-link");
      await fs.symlink("README.md", originalLink);
      let injected = false;
      let quarantinedLink = "";
      const quarantinedEntries: string[] = [];
      const result = await removeDirectoryTree(root, {
        startedAt: Number.MAX_SAFE_INTEGER,
        afterEntryQuarantined: async (entry, quarantined) => {
          quarantinedEntries.push(entry);
          if (path.basename(entry) !== "original-link") return;
          quarantinedLink = quarantined;
          await writeFile(path.join(root, "late-after-link-check"), "late\n");
          throw new Error("force quarantine restore");
        },
        beforeQuarantineRestoreLink: async (_source, destination) => {
          if (injected) return;
          injected = true;
          await fs.symlink("racer-target", destination);
        },
      });

      expect(result.status ?? result).toBe("retained");
      expect(quarantinedEntries).toContain(originalLink);
      expect(injected, `quarantine source: ${quarantinedLink}`).toBe(true);
      await expect(readlink(originalLink)).resolves.toBe("racer-target");
      const quarantined = (await fs.readdir(root)).find((name) =>
        name.startsWith(".bb-removing-"),
      );
      expect(quarantined).toBeDefined();
      await expect(readlink(path.join(root, quarantined!))).resolves.toBe(
        "README.md",
      );
      expect(result.retainedPaths).toContain(originalLink);
      expect(result.retainedPaths).toContain(path.join(root, quarantined!));
      expect(quarantined).toMatch(/^\.bb-removing-/u);
    },
  );

  removeDirectoryTreeTest(
    "returns recovered, duplicate, and quarantine paths for a replaced file source without a hook",
    async () => {
      const worktree = await makeWorktree();
      const originalMode =
        (await fs.stat(path.join(worktree.path, "README.md"))).mode & 0o7777;
      let replaced = false;
      let racerSource = "";
      let quarantineSource = "";
      const result = await removeDirectoryTree(worktree.path, {
        startedAt: Number.MAX_SAFE_INTEGER,
        afterEntryQuarantined: async (entry, quarantined) => {
          if (!entry.endsWith("README.md")) return;
          quarantineSource = quarantined;
          await writeFile(
            path.join(worktree.path, "late-after-check.txt"),
            "late\n",
          );
        },
        beforeQuarantineRestoreLink: async (_source, destination) => {
          if (!destination.endsWith("README.md") || replaced) return;
          replaced = true;
          racerSource = path.join(worktree.path, "README.md");
          await writeFile(destination, "racing file bytes\n");
        },
      });

      expect(result.status).toBe("retained");
      expect(replaced).toBe(true);
      await expect(
        readFile(path.join(worktree.path, "README.md"), "utf8"),
      ).resolves.toBe("racing file bytes\n");
      await expect(readFile(racerSource, "utf8")).resolves.toBe(
        "racing file bytes\n",
      );
      const recoveredPath = result.retainedPaths.find((retainedPath) =>
        path.basename(retainedPath).startsWith(".bb-recovered-"),
      );
      expect(recoveredPath).toBeDefined();
      if (recoveredPath === undefined) {
        const visibleBytes = await Promise.all([
          readFile(path.join(worktree.path, "README.md")),
          readFile(racerSource),
        ]);
        expect(
          visibleBytes.some((bytes) =>
            bytes.equals(Buffer.from("published\n")),
          ),
        ).toBe(true);
        throw new Error("Recovered original path was not reported");
      }
      await expect(readFile(recoveredPath!, "utf8")).resolves.toBe(
        "published\n",
      );
      expect((await fs.stat(recoveredPath!)).mode & 0o7777).toBe(originalMode);
      expect(result.retainedPaths).toEqual(
        expect.arrayContaining([
          recoveredPath,
          path.join(worktree.path, "README.md"),
          path.join(worktree.path, path.basename(quarantineSource)),
        ]),
      );
    },
  );

  removeDirectoryTreeTest(
    "returns duplicate Git marker paths without a hook when its source is replaced",
    async () => {
      const worktree = await makeWorktree();
      const markerPath = path.join(worktree.path, ".git");
      const originalMarker = await readFile(markerPath);
      const originalMode = (await fs.stat(markerPath)).mode & 0o7777;
      let replaced = false;
      let racerSource = "";
      const result = await removeDirectoryTree(worktree.path, {
        startedAt: Number.MAX_SAFE_INTEGER,
        afterRootMarkerDetached: async (root) => {
          await writeFile(path.join(root, "late-after-marker.txt"), "late\n");
        },
        beforeGitMarkerRestoreLink: async (_source, destination) => {
          if (replaced) return;
          replaced = true;
          racerSource = markerPath;
          await writeFile(destination, "racing git marker bytes\n");
        },
      });

      expect(result.status).toBe("retained");
      await expect(readFile(markerPath, "utf8")).resolves.toBe(
        "racing git marker bytes\n",
      );
      await expect(readFile(racerSource, "utf8")).resolves.toBe(
        "racing git marker bytes\n",
      );
      const recoveredPath = result.retainedPaths.find((retainedPath) =>
        path.basename(retainedPath).startsWith(".bb-recovered-"),
      );
      expect(recoveredPath).toBeDefined();
      await expect(readFile(recoveredPath!)).resolves.toEqual(originalMarker);
      expect((await fs.stat(recoveredPath!)).mode & 0o7777).toBe(originalMode);
      expect((await fs.stat(markerPath)).mode & 0o7777).toBe(originalMode);
      expect(result.retainedPaths).toEqual(
        expect.arrayContaining([recoveredPath, markerPath, worktree.path]),
      );
    },
  );

  removeDirectoryTreeTest(
    "keeps a file restore racer beside the quarantined original",
    async () => {
      const worktree = await makeWorktree();
      let injected = false;
      const retainedPaths: string[] = [];
      const result = await removeDirectoryTree(worktree.path, {
        startedAt: Number.MAX_SAFE_INTEGER,
        afterEntryQuarantined: async (entry) => {
          if (!entry.endsWith("README.md")) return;
          await writeFile(
            path.join(worktree.path, "late-after-check.txt"),
            "late\n",
          );
        },
        afterRestoreNameCheck: async (_source, destination, isDirectory) => {
          if (isDirectory || !destination.endsWith("README.md") || injected)
            return;
          injected = true;
          await writeFile(destination, "racing file bytes\n");
        },
        onRetainedPath: (retainedPath) => retainedPaths.push(retainedPath),
      });

      expect(result.status).toBe("retained");
      expect(injected).toBe(true);
      const quarantinePath = retainedPaths.find((retainedPath) =>
        path.basename(retainedPath).startsWith(".bb-removing-"),
      );
      expect(quarantinePath).toBeDefined();
      const absoluteQuarantinePath = path.join(
        worktree.path,
        path.basename(quarantinePath!),
      );
      await expect(
        readFile(path.join(worktree.path, "README.md"), "utf8"),
      ).resolves.toBe("racing file bytes\n");
      await expect(readFile(absoluteQuarantinePath, "utf8")).resolves.toBe(
        "published\n",
      );
      await expect(access(absoluteQuarantinePath)).resolves.toBeUndefined();
    },
  );

  removeDirectoryTreeTest(
    "keeps a git marker path racer after restoring the marker link",
    async () => {
      const worktree = await makeWorktree();
      const originalMarker = await readFile(path.join(worktree.path, ".git"));
      let heldPath = "";
      const retainedPaths: string[] = [];
      const result = await removeDirectoryTree(worktree.path, {
        startedAt: Date.now() + 10_000,
        afterRootMarkerDetached: async (root) => {
          await writeFile(path.join(root, "late-after-marker.txt"), "late\n");
        },
        afterGitMarkerLinked: async (source) => {
          heldPath = source;
          await fs.unlink(source);
          await writeFile(source, "racing marker path bytes\n");
        },
        onRetainedPath: (retainedPath) => retainedPaths.push(retainedPath),
      });

      expect(result.status).toBe("retained");
      expect(heldPath).not.toBe("");
      const absoluteHeldPath = path.join(
        path.dirname(worktree.path),
        path.basename(heldPath),
      );
      expect(retainedPaths).toContain(absoluteHeldPath);
      await expect(readFile(path.join(worktree.path, ".git"))).resolves.toEqual(
        originalMarker,
      );
      await expect(readFile(absoluteHeldPath, "utf8")).resolves.toBe(
        "racing marker path bytes\n",
      );
      await expect(
        git(worktree.path, "rev-parse", "--git-dir"),
      ).resolves.toMatch(/worktrees/u);
    },
  );

  removeDirectoryTreeTest(
    "retains a quarantined directory when a non-empty restore racer appears",
    async () => {
      const worktree = await makeWorktree();
      const directory = path.join(worktree.path, "restore-race-dir");
      await mkdir(directory);
      await writeFile(path.join(directory, "original.txt"), "original\n");
      await fs.chmod(directory, 0o750);
      const originalMode = (await fs.stat(directory)).mode & 0o7777;
      let injected = false;
      let quarantinePath = "";
      const result = await removeDirectoryTree(worktree.path, {
        startedAt: Number.MAX_SAFE_INTEGER,
        afterEntryQuarantined: async (entry) => {
          if (!entry.endsWith("restore-race-dir")) return;
          await writeFile(
            path.join(worktree.path, "late-after-directory.txt"),
            "late\n",
          );
        },
        afterRestoreNameCheck: async (_source, destination, isDirectory) => {
          if (
            !isDirectory ||
            !destination.endsWith("restore-race-dir") ||
            injected
          )
            return;
          injected = true;
          await mkdir(destination);
          await writeFile(path.join(destination, "racer.txt"), "racer\n");
        },
        onRetainedPath: (retainedPath) => {
          if (path.basename(retainedPath).startsWith(".bb-removing-"))
            quarantinePath = retainedPath;
        },
      });

      expect(result.status).toBe("retained");
      expect(injected).toBe(true);
      expect(quarantinePath).not.toBe("");
      expect(await fs.readdir(worktree.path)).toContain(
        path.basename(quarantinePath),
      );
      expect(result.retainedPaths).toContain(quarantinePath);
      await expect(fs.readdir(quarantinePath)).resolves.toEqual([]);
      await expect(
        readFile(path.join(directory, "racer.txt"), "utf8"),
      ).resolves.toBe("racer\n");
      await expect(
        readFile(path.join(worktree.path, "late-after-directory.txt"), "utf8"),
      ).resolves.toBe("late\n");
      expect((await fs.stat(quarantinePath)).mode & 0o7777).toBe(originalMode);
      await expect(
        git(worktree.path, "rev-parse", "--git-dir"),
      ).resolves.toMatch(/worktrees/u);
    },
  );

  removeDirectoryTreeTest(
    "restores the original directory over an empty restore racer",
    async () => {
      const worktree = await makeWorktree();
      const directory = path.join(worktree.path, "restore-race-empty-dir");
      await mkdir(directory);
      await fs.chmod(directory, 0o750);
      const originalInfo = await fs.stat(directory);
      const originalMode = originalInfo.mode & 0o7777;
      let injected = false;
      let racerIno = 0;
      const result = await removeDirectoryTree(worktree.path, {
        startedAt: Number.MAX_SAFE_INTEGER,
        afterEntryQuarantined: async (entry) => {
          if (!entry.endsWith("restore-race-empty-dir")) return;
          await writeFile(
            path.join(worktree.path, "late-after-empty-directory.txt"),
            "late\n",
          );
        },
        afterRestoreNameCheck: async (_source, destination, isDirectory) => {
          if (
            !isDirectory ||
            !destination.endsWith("restore-race-empty-dir") ||
            injected
          )
            return;
          injected = true;
          await mkdir(destination);
          racerIno = (await fs.stat(destination)).ino;
        },
      });

      expect(result.status).toBe("retained");
      expect(injected).toBe(true);
      const restoredInfo = await fs.stat(directory);
      expect(restoredInfo.ino).toBe(originalInfo.ino);
      expect(restoredInfo.ino).not.toBe(racerIno);
      expect(restoredInfo.mode & 0o7777).toBe(originalMode);
      await expect(fs.readdir(directory)).resolves.toEqual([]);
      await expect(
        readFile(
          path.join(worktree.path, "late-after-empty-directory.txt"),
          "utf8",
        ),
      ).resolves.toBe("late\n");
      await expect(
        git(worktree.path, "rev-parse", "--git-dir"),
      ).resolves.toMatch(/worktrees/u);
    },
  );

  removeDirectoryTreeTest(
    "retains quarantined file data when its original name is occupied",
    async () => {
      const worktree = await makeWorktree();
      const originalMode =
        (await fs.stat(path.join(worktree.path, "README.md"))).mode & 0o7777;
      const result = await removeDirectoryTree(worktree.path, {
        startedAt: Number.MAX_SAFE_INTEGER,
        afterEntryQuarantined: async (entry) => {
          if (!entry.endsWith("README.md")) return;
          await writeFile(entry, "racing bytes\n");
        },
      });
      expect(result.status).toBe("retained");
      const quarantinedPath = result.retainedPaths.find((retainedPath) =>
        path.basename(retainedPath).startsWith(".bb-removing-"),
      );
      expect(quarantinedPath).toBeDefined();
      await expect(access(quarantinedPath!)).resolves.toBeUndefined();
      await expect(
        readFile(path.join(worktree.path, "README.md"), "utf8"),
      ).resolves.toBe("racing bytes\n");
      await expect(readFile(quarantinedPath!, "utf8")).resolves.toBe(
        "published\n",
      );
      expect((await fs.stat(quarantinedPath!)).mode & 0o7777).toBe(
        originalMode,
      );
      await expect(
        git(worktree.path, "rev-parse", "--git-dir"),
      ).resolves.toMatch(/worktrees/u);
    },
  );

  removeDirectoryTreeTest(
    "preserves a racing preserved-path candidate without replacing it",
    async () => {
      const worktree = await makeWorktree();
      const entry = path.join(worktree.path, "README.md");
      const preservedPath = `${entry}.bb-preserved-11111111`;
      let actualPreservedPath = preservedPath;
      let injected = false;
      const result = await removeDirectoryTree(worktree.path, {
        startedAt: Number.MAX_SAFE_INTEGER,
        afterEntryQuarantined: async (removedEntry) => {
          if (!removedEntry.endsWith("README.md")) return;
          await writeFile(
            path.join(worktree.path, "late-d8-sibling.txt"),
            "late sibling bytes\n",
          );
        },
        afterRestoreNameCheck: async (_source, _destination, isDirectory) => {
          if (isDirectory || injected) return;
          actualPreservedPath = `${entry}.bb-preserved-11111111`;
          injected = true;
          await writeFile(entry, "restore-name racer bytes\n");
          await writeFile(actualPreservedPath, "candidate racing bytes\n");
        },
      });

      expect(injected).toBe(true);
      expect(result.status).toBe("retained");
      await expect(readFile(entry, "utf8")).resolves.toBe(
        "restore-name racer bytes\n",
      );
      await expect(readFile(actualPreservedPath, "utf8")).resolves.toBe(
        "candidate racing bytes\n",
      );
      await expect(
        readFile(path.join(worktree.path, "late-d8-sibling.txt"), "utf8"),
      ).resolves.toBe("late sibling bytes\n");
      const quarantinedPath = result.retainedPaths.find((retainedPath) =>
        path.basename(retainedPath).startsWith(".bb-removing-"),
      );
      expect(quarantinedPath).toBeDefined();
      await expect(readFile(quarantinedPath!, "utf8")).resolves.toBe(
        "published\n",
      );
    },
  );

  it("retains quarantined directory data when its original name is occupied", async () => {
    const worktree = await makeWorktree();
    const directory = path.join(worktree.path, "collision-dir");
    await mkdir(directory);
    await fs.chmod(directory, 0o750);
    const originalMode = (await fs.stat(directory)).mode & 0o7777;
    let injected = false;
    const result = await removeDirectoryTree(worktree.path, {
      startedAt: Number.MAX_SAFE_INTEGER,
      afterEntryQuarantined: async (entry) => {
        if (!entry.endsWith("collision-dir") || injected) return;
        injected = true;
        await mkdir(entry);
      },
    });

    expect(result.status).toBe("retained");
    expect(injected).toBe(true);
    const preservedPath = result.retainedPaths.find((retained) =>
      path.basename(retained).startsWith(".bb-removing-"),
    );
    expect(preservedPath).toBeDefined();
    expect(path.basename(preservedPath!)).toMatch(
      /^\.bb-removing-[0-9a-f-]+$/u,
    );
    await expect(fs.readdir(directory)).resolves.toEqual([]);
    await expect(fs.readdir(preservedPath!)).resolves.toEqual([]);
    expect((await fs.stat(preservedPath!)).mode & 0o7777).toBe(originalMode);
    await expect(git(worktree.path, "rev-parse", "--git-dir")).resolves.toMatch(
      /worktrees/u,
    );
  });

  it.each(["ascending", "descending"] as const)(
    "stops after a late sibling appears with actual %s directory traversal",
    async (direction) => {
      const worktree = await makeWorktree();
      useProcReaderForTests(descendantsOnly(hostProc, -1));
      const lateDirectory = path.join(worktree.path, "late-dir");
      await mkdir(lateDirectory);
      const children = ["first.txt", "second.txt", "third.txt"];
      for (const [index, name] of children.entries())
        await writeFile(path.join(lateDirectory, name), `original-${index}\n`, {
          mode: index === 1 ? 0o640 : 0o600,
        });
      await git(worktree.path, "add", "late-dir");
      await git(
        worktree.path,
        "commit",
        "-m",
        "published partial-removal entries",
      );
      await git(worktree.path, "push", "origin", "feature");
      const expectedChildren =
        direction === "ascending"
          ? [...children].sort()
          : [...children].sort().reverse();
      let injected = false;
      let injectionCount = 0;
      let injectionChild = "";
      const visitedChildren = new Set<string>();
      const hookOrder: Array<{ hook: string; entry: string }> = [];
      let survivorsAtInjection: Array<{
        name: string;
        contents: string;
        mode: number;
      }> = [];
      let removedBeforeInjection: string[] = [];
      const maybeInject = async (hook: string, entry: string) => {
        const current = path.basename(entry);
        if (!children.includes(current)) return;
        expect(entry).toBe(path.join(lateDirectory, current));
        hookOrder.push({ hook, entry });
        const earlierVisited = [...visitedChildren].filter(
          (name) => name !== current,
        );
        const earlierRemoved = earlierVisited.filter(
          (name) => !existsSync(path.join(lateDirectory, name)),
        );
        if (earlierRemoved.length > 0 && !injected) {
          injectionChild = current;
          removedBeforeInjection = earlierRemoved;
          survivorsAtInjection = await Promise.all(
            expectedChildren
              .filter((name) => existsSync(path.join(lateDirectory, name)))
              .map(async (name) => ({
                name,
                contents: await readFile(
                  path.join(lateDirectory, name),
                  "utf8",
                ),
                mode:
                  (await fs.stat(path.join(lateDirectory, name))).mode & 0o7777,
              })),
          );
          injected = true;
          injectionCount += 1;
          await writeFile(path.join(lateDirectory, "late-file.txt"), "kept\n");
        }
        visitedChildren.add(current);
      };
      const result = await removeDirectoryTree(worktree.path, {
        startedAt: Number.MAX_SAFE_INTEGER,
        readDirectoryNames: async (directory) => {
          const names = await fs.readdir(directory);
          if ((await fs.realpath(directory)) !== lateDirectory) return names;
          return names.sort((left, right) =>
            direction === "ascending"
              ? left.localeCompare(right)
              : right.localeCompare(left),
          );
        },
        beforeEntryRemoval: (entry) => maybeInject("removal", entry),
        beforeEntryRename: (entry) => maybeInject("rename", entry),
      });
      expect(result.status).toBe("retained");
      expect(injected).toBe(true);
      expect(injectionCount).toBe(1);
      expect(removedBeforeInjection.length).toBeGreaterThan(0);
      expect(removedBeforeInjection).not.toContain(injectionChild);
      expect(expectedChildren.indexOf(injectionChild)).toBeGreaterThan(
        expectedChildren.indexOf(removedBeforeInjection[0]!),
      );
      expect([...visitedChildren]).toEqual(
        expectedChildren.slice(0, visitedChildren.size),
      );
      const firstVisited = hookOrder[0]?.entry;
      expect(firstVisited).toBeDefined();
      expect(hookOrder[0]).toEqual({ hook: "removal", entry: firstVisited });
      expect(hookOrder[1]).toEqual({ hook: "rename", entry: firstVisited });
      expect(firstVisited).not.toBe(path.join(lateDirectory, injectionChild));
      expect(hookOrder.at(-1)).toEqual({
        hook: "removal",
        entry: path.join(lateDirectory, injectionChild),
      });
      for (const name of removedBeforeInjection)
        await expect(
          access(path.join(lateDirectory, name)),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      for (const survivor of survivorsAtInjection) {
        await expect(
          readFile(path.join(lateDirectory, survivor.name), "utf8"),
        ).resolves.toBe(survivor.contents);
        expect(
          (await fs.stat(path.join(lateDirectory, survivor.name))).mode &
            0o7777,
        ).toBe(survivor.mode);
      }
      await expect(
        access(path.join(worktree.path, ".git")),
      ).resolves.toBeUndefined();
      await expect(
        git(worktree.path, "rev-parse", "--git-dir"),
      ).resolves.toMatch(/worktrees/u);
      await expect(
        readFile(path.join(worktree.path, "README.md"), "utf8"),
      ).resolves.toBe("published\n");
      await expect(
        readFile(path.join(lateDirectory, "late-file.txt"), "utf8"),
      ).resolves.toBe("kept\n");
    },
  );

  it.each(["ascending", "descending"] as const)(
    "retains siblings injected after parent verification with %s traversal",
    async (direction) => {
      const worktree = await makeWorktree();
      useProcReaderForTests(descendantsOnly(hostProc, -1));
      const lateDirectory = path.join(worktree.path, "late-dir");
      await mkdir(lateDirectory);
      const children = ["a-old.txt", "b-trigger.txt", "c-remaining.txt"];
      for (const [index, name] of children.entries())
        await writeFile(path.join(lateDirectory, name), `original-${index}\n`, {
          mode: index === 1 ? 0o640 : 0o600,
        });
      await git(worktree.path, "add", "late-dir");
      await git(
        worktree.path,
        "commit",
        "-m",
        "published verified-child siblings",
      );
      await git(worktree.path, "push", "origin", "feature");
      const traversalOrder =
        direction === "ascending"
          ? [...children].sort()
          : [...children].sort().reverse();
      const visited: string[] = [];
      const hookCalls: Array<{ entry: string; quarantined: string }> = [];
      let injected = false;
      let quarantinedContents = "";
      let quarantinedParent = "";
      let hookError = "";
      let survivorsAtInjection: Array<{
        name: string;
        contents: string;
        mode: number;
      }> = [];
      const result = await removeDirectoryTree(worktree.path, {
        startedAt: Number.MAX_SAFE_INTEGER,
        readDirectoryNames: async (directory) => {
          const entries = await fs.readdir(directory);
          return entries.sort((left, right) =>
            direction === "ascending"
              ? left.localeCompare(right)
              : right.localeCompare(left),
          );
        },
        beforeEntryRemoval: async (entry) => {
          if (path.dirname(entry) !== lateDirectory) return;
          visited.push(path.basename(entry));
        },
        afterParentVerified: async (entry, quarantined) => {
          if (entry !== path.join(lateDirectory, "b-trigger.txt") || injected)
            return;
          injected = true;
          hookCalls.push({ entry, quarantined });
          try {
            quarantinedContents = await readFile(quarantined, "utf8");
            quarantinedParent = await fs.realpath(path.dirname(quarantined));
            const index = traversalOrder.indexOf(path.basename(entry));
            survivorsAtInjection = await Promise.all(
              traversalOrder.slice(index + 1).map(async (name) => ({
                name,
                contents: await readFile(
                  path.join(lateDirectory, name),
                  "utf8",
                ),
                mode:
                  (await fs.stat(path.join(lateDirectory, name))).mode & 0o7777,
              })),
            );
            await writeFile(
              path.join(lateDirectory, "late-after-verify.txt"),
              "kept\n",
            );
          } catch (error) {
            hookError = String(error);
          }
        },
      });
      expect(result.status).toBe("retained");
      expect(injected).toBe(true);
      expect(hookError).toBe("");
      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0]?.entry).toBe(
        path.join(lateDirectory, "b-trigger.txt"),
      );
      expect(path.basename(hookCalls[0]!.quarantined)).toMatch(
        /^\.bb-removing-/u,
      );
      expect(quarantinedParent).toBe(lateDirectory);
      expect(quarantinedContents).toBe("original-1\n");
      expect(visited).toEqual(traversalOrder.slice(0, 2));
      expect(hookCalls[0]?.entry).toBe(path.join(lateDirectory, visited[1]!));
      expect(visited[0]).toBe(traversalOrder[0]);
      const namesAfterInjection = await fs.readdir(lateDirectory);
      expect(namesAfterInjection).toContain("late-after-verify.txt");
      for (const name of traversalOrder.slice(0, 2))
        expect(namesAfterInjection, `${direction}: ${name}`).not.toContain(
          name,
        );
      for (const survivor of survivorsAtInjection) {
        await expect(
          readFile(path.join(lateDirectory, survivor.name), "utf8"),
        ).resolves.toBe(survivor.contents);
        expect(
          (await fs.stat(path.join(lateDirectory, survivor.name))).mode &
            0o7777,
        ).toBe(survivor.mode);
      }
      await expect(
        readFile(path.join(lateDirectory, "late-after-verify.txt"), "utf8"),
      ).resolves.toBe("kept\n");
      await expect(
        git(worktree.path, "rev-parse", "--git-dir"),
      ).resolves.toMatch(/worktrees/u);
    },
  );

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

    expect(result.status).toBe("retained");
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

    expect(result.status).toBe("retained");
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
    const duplicateNames = (await fs.readdir(lateDirectory)).filter((name) =>
      name.startsWith(".bb-removing-"),
    );
    expect(duplicateNames).toHaveLength(0);
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
      expect(result.status).toBe("retained");
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
      expect(result.status).toBe("retained");
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

  it.skipIf(process.platform !== "linux").each([
    ["no DAC capability", "0000000000000000"],
    ["CAP_DAC_OVERRIDE", "0000000000000002"],
    ["CAP_DAC_READ_SEARCH", "0000000000000004"],
  ])(
    "retains a non-traversable worktree for a foreign uid with a readable outside cwd and an earlier fd (%s)",
    async (_capability, capEff) => {
      const root = await mkdtemp(path.join("/tmp", "bb-preserve-worktree-"));
      const worktree = await makeWorktree(root);
      await fs.chmod(root, 0o755);
      await fs.chmod(worktree.path, 0o700);
      useProcReaderForTests(
        foreignReadableOutsideCwdProc(100102, worktree.path, capEff),
      );
      const signal = vi.spyOn(process, "kill");

      const scan = await scanWorktreeHolders(worktree.path);
      let removalError: unknown;
      try {
        await remove(worktree);
      } catch (error) {
        removalError = error;
      }
      expect(scan.status).toBe("uncertain");
      expect(scan.status === "uncertain" ? scan.reason : "").toContain(
        "foreign-user processes could not be inspected",
      );
      expect(removalError).toMatchObject({ code: "worktree_preserved" });
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

  removeDirectoryTreeTest(
    "removes a mismatched quarantine pin and recovers the held original from its file handle",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "bb-preserve-pin-race-"),
      );
      roots.push(root);
      const originalPath = path.join(root, "payload.txt");
      await writeFile(originalPath, "original bytes\n", { mode: 0o640 });
      let swapped = false;
      let copyAttempted = false;
      let racerPath = "";
      let error: unknown;
      let result: RemoveDirectoryTreeResult | undefined;
      try {
        result = await removeDirectoryTree(root, {
          startedAt: Number.MAX_SAFE_INTEGER,
          beforeQuarantinePinLink: async (source) => {
            if (swapped || path.basename(source) === "payload.txt") return;
            swapped = true;
            racerPath = source;
            await fs.unlink(source);
            await writeFile(source, "racer bytes\n");
          },
          afterEntryQuarantined: async (entry, quarantined) => {
            if (swapped || !entry.endsWith("payload.txt")) return;
            swapped = true;
            racerPath = quarantined;
            await fs.unlink(quarantined);
            await writeFile(quarantined, "racer bytes\n");
            await fs.chmod(root, 0o555);
          },
          recoveryWrite: async (
            destination,
            buffer,
            offset,
            length,
            position,
          ) => {
            copyAttempted = true;
            return destination.write(buffer, offset, length, position);
          },
        });
      } catch (caught) {
        error = caught;
      } finally {
        await fs.chmod(root, 0o755);
      }

      expect(swapped).toBe(true);
      const reportedPaths = result?.retainedPaths ?? errorRetainedPaths(error);
      const visiblePaths = await fs
        .readdir(root)
        .then((names) => names.map((name) => path.join(root, name)));
      const contents: Buffer[] = [];
      let originalIsReported = false;
      for (const candidate of new Set([...reportedPaths, ...visiblePaths])) {
        try {
          const bytes = await readFile(candidate);
          contents.push(bytes);
          if (
            reportedPaths.includes(candidate) &&
            bytes.equals(Buffer.from("original bytes\n"))
          )
            originalIsReported = true;
        } catch {}
      }
      expect(
        contents.some((bytes) => bytes.equals(Buffer.from("original bytes\n"))),
      ).toBe(true);
      expect(originalIsReported).toBe(true);
      expect(
        visiblePaths.some((candidate) =>
          path.basename(candidate).startsWith(".bb-pin-"),
        ),
      ).toBe(false);
      expect(copyAttempted).toBe(true);
      if (error !== undefined) {
        expect(error).toMatchObject({ name: "RetainedRecoveryError" });
        expect(
          reportedPaths.some((retainedPath) =>
            path.basename(retainedPath).startsWith(".bb-recovered-"),
          ),
        ).toBe(true);
      }
      await expect(
        readFile(path.join(root, path.basename(racerPath)), "utf8"),
      ).resolves.toBe("racer bytes\n");
    },
  );

  removeDirectoryTreeTest(
    "retains a stale recovery pin and its directory during a fresh teardown",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "bb-preserve-stale-pin-"),
      );
      roots.push(root);
      const target = path.join(root, "target");
      await mkdir(target);
      const stalePin = path.join(target, ".bb-pin-deadbeef");
      await writeFile(stalePin, "stale original bytes\n");
      const result = await removeDirectoryTree(target, {
        startedAt: Number.MAX_SAFE_INTEGER,
      });

      expect(result.status).toBe("retained");
      expect(result.retainedPaths).toContain(stalePin);
      await expect(readFile(stalePin, "utf8")).resolves.toBe(
        "stale original bytes\n",
      );
      await expect(access(target)).resolves.toBeUndefined();
    },
  );

  removeDirectoryTreeTest(
    "retries pin name collisions and leaves no pin after a verified clean removal",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "bb-preserve-pin-clean-"),
      );
      roots.push(root);
      await writeFile(path.join(root, "payload.txt"), "clean removal\n");
      let attempt = 0;
      const result = await removeDirectoryTree(root, {
        startedAt: Number.MAX_SAFE_INTEGER,
        createPinSuffix: () => (attempt++ === 0 ? "deadbeef" : "cafebabe"),
        beforeQuarantinePinLink: async (_source, pin) => {
          if (path.basename(pin) === ".bb-pin-deadbeef") {
            await writeFile(pin, "name collision\n");
            return;
          }
          await fs.unlink(path.join(root, ".bb-pin-deadbeef"));
        },
      });

      expect(result.status).toBe("removed");
      expect(attempt).toBeGreaterThan(1);
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  removeDirectoryTreeTest(
    "removes the verified recovery pin after a successful restore",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "bb-preserve-pin-restored-"),
      );
      roots.push(root);
      const originalPath = path.join(root, "payload.txt");
      await writeFile(originalPath, "original bytes\n", { mode: 0o640 });
      let restored = false;
      const result = await removeDirectoryTree(root, {
        startedAt: Number.MAX_SAFE_INTEGER,
        afterEntryQuarantined: async (entry) => {
          if (!entry.endsWith("payload.txt")) return;
          await writeFile(path.join(root, "late-sibling.txt"), "late\n");
        },
        afterRestoreNameCheck: async (_source, destination, isDirectory) => {
          if (isDirectory || !destination.endsWith("payload.txt") || restored)
            return;
          restored = true;
          await writeFile(destination, "racing bytes\n");
        },
      });

      expect(result.status).toBe("retained");
      expect(restored).toBe(true);
      await expect(readFile(originalPath, "utf8")).resolves.toBe(
        "racing bytes\n",
      );
      const originalPathInResult = result.retainedPaths.find((candidate) =>
        path.basename(candidate).startsWith(".bb-recovered-"),
      );
      expect(originalPathInResult).toBeDefined();
      await expect(readFile(originalPathInResult!, "utf8")).resolves.toBe(
        "original bytes\n",
      );
      await expect(
        fs
          .readdir(root)
          .then((names) => names.some((name) => name.startsWith(".bb-pin-"))),
      ).resolves.toBe(false);
    },
  );

  removeDirectoryTreeTest(
    "retains the original pin and worktree when the recovery link syscall fails",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "bb-preserve-pin-link-failed-"),
      );
      roots.push(root);
      const originalPath = path.join(root, "a-payload.txt");
      const siblingPath = path.join(root, "z-sibling.txt");
      await writeFile(originalPath, "original bytes\n");
      await writeFile(siblingPath, "sibling bytes\n");
      let injected = false;
      let linkErrno: string | undefined;
      let error: unknown;
      try {
        await removeDirectoryTree(root, {
          startedAt: Number.MAX_SAFE_INTEGER,
          afterEntryQuarantined: async (entry) => {
            if (!entry.endsWith("a-payload.txt")) return;
            await writeFile(path.join(root, "late-sibling.txt"), "late\n");
            await writeFile(entry, "racing bytes\n");
            await fs.chmod(root, 0o555);
          },
          recoveryLink: async (pin, destination) => {
            injected = true;
            try {
              await fs.link(pin, destination);
            } catch (caught) {
              if (
                typeof caught === "object" &&
                caught !== null &&
                "code" in caught &&
                typeof caught.code === "string"
              )
                linkErrno = caught.code;
              throw caught;
            }
          },
        });
      } catch (caught) {
        error = caught;
      } finally {
        await fs.chmod(root, 0o755);
      }

      expect(injected).toBe(true);
      expect(linkErrno).toBe("EACCES");
      expect(error).toMatchObject({ name: "RetainedRecoveryError" });
      const pinPath = errorRetainedPaths(error).find((retainedPath) =>
        path.basename(retainedPath).startsWith(".bb-pin-"),
      );
      expect(pinPath).toBeDefined();
      await expect(readFile(pinPath!, "utf8")).resolves.toBe(
        "original bytes\n",
      );
      expect(error instanceof Error ? error.message : "").toContain(pinPath);
      await expect(access(root)).resolves.toBeUndefined();
      await expect(readFile(siblingPath, "utf8")).resolves.toBe(
        "sibling bytes\n",
      );
      await expect(readFile(originalPath, "utf8")).resolves.toBe(
        "racing bytes\n",
      );
      await expect(
        readFile(path.join(root, "late-sibling.txt"), "utf8"),
      ).resolves.toBe("late\n");
    },
  );

  removeDirectoryTreeTest(
    "cleans a partial recovery copy when a later write syscall fails",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "bb-preserve-pin-copy-failed-"),
      );
      roots.push(root);
      const originalPath = path.join(root, "a-payload.txt");
      const siblingPath = path.join(root, "z-sibling.txt");
      const originalBytes = Buffer.alloc(160 * 1024, 0x61);
      await writeFile(originalPath, originalBytes);
      await writeFile(siblingPath, "sibling bytes\n");
      let copyAttempted = false;
      let writes = 0;
      let writeErrno: string | undefined;
      let error: unknown;
      try {
        await removeDirectoryTree(root, {
          startedAt: Number.MAX_SAFE_INTEGER,
          afterEntryQuarantined: async (entry) => {
            if (!entry.endsWith("a-payload.txt")) return;
            await writeFile(path.join(root, "late-sibling.txt"), "late\n");
            await writeFile(entry, "racing bytes\n");
          },
          recoveryLink: async (pin, destination) => {
            await fs.link(
              pin,
              path.join(
                "/dev/shm",
                `${path.basename(destination)}-${process.pid}`,
              ),
            );
          },
          recoveryWrite: async (
            destination,
            buffer,
            offset,
            length,
            position,
          ) => {
            copyAttempted = true;
            writes += 1;
            if (writes === 2) await destination.close();
            try {
              return await destination.write(buffer, offset, length, position);
            } catch (caught) {
              if (
                typeof caught === "object" &&
                caught !== null &&
                "code" in caught &&
                typeof caught.code === "string"
              )
                writeErrno = caught.code;
              throw caught;
            }
          },
        });
      } catch (caught) {
        error = caught;
      }

      expect(copyAttempted).toBe(true);
      expect(error).toMatchObject({ name: "RetainedRecoveryError" });
      const pinPath = errorRetainedPaths(error).find((retainedPath) =>
        path.basename(retainedPath).startsWith(".bb-pin-"),
      );
      expect(pinPath).toBeDefined();
      await expect(readFile(pinPath!, "utf8")).resolves.toBe(
        originalBytes.toString(),
      );
      expect(error instanceof Error ? error.message : "").toContain(pinPath);
      await expect(access(root)).resolves.toBeUndefined();
      await expect(readFile(siblingPath, "utf8")).resolves.toBe(
        "sibling bytes\n",
      );
      await expect(readFile(originalPath, "utf8")).resolves.toBe(
        "racing bytes\n",
      );
      await expect(
        readFile(path.join(root, "late-sibling.txt"), "utf8"),
      ).resolves.toBe("late\n");
      expect(writes).toBe(2);
      expect(writeErrno).toBe("EBADF");
      await expect(
        fs
          .readdir(root)
          .then((names) =>
            names.some((name) => name.startsWith(".bb-recovered-")),
          ),
      ).resolves.toBe(false);
    },
  );

  removeDirectoryTreeTest(
    "keeps a usable Git marker when marker recovery fails closed",
    async () => {
      const worktree = await makeWorktree();
      let markerCleanupAttempted = false;
      let markerDetached = false;
      let result: RemoveDirectoryTreeResult | undefined;
      let error: unknown;
      try {
        result = await removeDirectoryTree(worktree.path, {
          startedAt: Number.MAX_SAFE_INTEGER,
          afterRootMarkerDetached: async (root) => {
            markerDetached = true;
            await writeFile(path.join(root, "late-marker-data.txt"), "late\n");
          },
          beforePinCleanup: async (pin) => {
            if (markerDetached && path.basename(pin).startsWith(".bb-pin-")) {
              markerCleanupAttempted = true;
              throw new Error("injected marker pin cleanup failure");
            }
          },
        });
      } catch (caught) {
        error = caught;
      }

      expect(markerDetached).toBe(true);
      expect(markerCleanupAttempted).toBe(true);
      expect(result).toBeUndefined();
      expect(error).toMatchObject({ name: "RetainedRecoveryError" });
      const markerPin = errorRetainedPaths(error).find((retainedPath) =>
        path.basename(retainedPath).startsWith(".bb-pin-"),
      );
      expect(markerPin).toBeDefined();
      expect(error instanceof Error ? error.message : "").toContain(markerPin);
      await expect(
        git(worktree.path, "rev-parse", "--git-dir"),
      ).resolves.toMatch(/worktrees/u);
      await expect(readFile(markerPin!, "utf8")).resolves.toContain("gitdir:");
    },
  );

  removeDirectoryTreeTest(
    "keeps Git usable when a racing marker source prevents restoration",
    async () => {
      const worktree = await makeWorktree();
      let sourceReplaced = false;
      const result = await removeDirectoryTree(worktree.path, {
        startedAt: Number.MAX_SAFE_INTEGER,
        afterRootMarkerDetached: async (root) => {
          await writeFile(path.join(root, "late-marker-data.txt"), "late\n");
        },
        beforeGitMarkerRestoreLink: async (source) => {
          if (sourceReplaced) return;
          sourceReplaced = true;
          await fs.unlink(source);
          await writeFile(source, "racing marker bytes\n");
        },
      });

      expect(result.status).toBe("retained");
      expect(sourceReplaced).toBe(true);
      await expect(
        git(worktree.path, "rev-parse", "--git-dir"),
      ).resolves.toMatch(/worktrees/u);
    },
  );

  it.skipIf(
    process.platform !== "linux" ||
      (typeof process.getuid === "function" && process.getuid() === 0),
  )(
    "retains a worktree for a foreign unreadable process even when it cannot traverse group-only access",
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
      const signal = vi.spyOn(process, "kill");

      expect(await scanWorktreeHolders(worktree.path)).toMatchObject({
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
});
