import { constants, type Dirent, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  descriptorPath,
  sameDirectory,
} from "bb-environment-provider-host/remove-directory-tree";

export const REPOSITORY_SCAN_BUDGET_MS = 10_000;
export const REPOSITORY_SCAN_ENTRY_LIMIT = 2_000_000;
const REPOSITORY_SCAN_CONCURRENCY = 8;
const NAMED_LIMIT = 5;
const SUBMODULE_MODE = "160000 ";

export type DirectoryEntry = Pick<
  Dirent,
  | "name"
  | "isDirectory"
  | "isFile"
  | "isSymbolicLink"
  | "isFIFO"
  | "isSocket"
  | "isCharacterDevice"
  | "isBlockDevice"
>;

export interface RepositoryScanHooks {
  budgetMs?: number;
  entryLimit?: number;
  beforeDirectoryOpen?: (directory: string) => Promise<void>;
  openDirectoryEntries?: (
    directory: string,
    entry: string,
  ) => Promise<AsyncIterable<DirectoryEntry>>;
}

export interface IndexListing {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function lstatUnlessGone(target: string): Promise<Stats | null> {
  return fs.lstat(target).then(
    (info) => info,
    (error: unknown) => {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    },
  );
}

function namedPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, NAMED_LIMIT).join(", ");
  const more = paths.length - NAMED_LIMIT;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

function isSpecialFile(info: Stats): boolean {
  return (
    info.isFIFO() ||
    info.isSocket() ||
    info.isCharacterDevice() ||
    info.isBlockDevice()
  );
}

async function hasRepositoryShape(
  directory: string,
  names: readonly string[],
): Promise<boolean> {
  if (!names.includes("HEAD")) return false;
  const head = await lstatUnlessGone(path.join(directory, "HEAD"));
  if (head === null || head.isDirectory()) return false;
  if (isSpecialFile(head)) return true;
  const objects = names.includes("objects")
    ? await lstatUnlessGone(path.join(directory, "objects"))
    : null;
  const commondir = names.includes("commondir")
    ? await lstatUnlessGone(path.join(directory, "commondir"))
    : null;
  const refs = names.includes("refs")
    ? await lstatUnlessGone(path.join(directory, "refs"))
    : null;
  return (
    (objects?.isDirectory() === true || commondir !== null) &&
    refs?.isDirectory() === true
  );
}

async function openEntries(
  directory: string,
): Promise<AsyncIterable<DirectoryEntry>> {
  return fs.opendir(directory, { bufferSize: 1024 });
}

async function readFirstName(directory: string): Promise<string[]> {
  const opened = await fs.opendir(directory);
  try {
    const first = await opened.read();
    return first === null ? [] : [first.name];
  } finally {
    await opened.close();
  }
}

const TIMED_OUT = Symbol("timed out");

async function beforeDeadline<T>(
  work: Promise<T>,
  deadline: number,
): Promise<T | typeof TIMED_OUT> {
  void work.catch(() => undefined);
  const remaining = deadline - performance.now();
  if (remaining <= 0) return TIMED_OUT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(resolve, remaining, TIMED_OUT);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withAnchoredDirectory<T>(
  entry: string,
  before: Stats,
  beforeOpen: ((directory: string) => Promise<void>) | undefined,
  list: (anchored: string) => Promise<T>,
): Promise<{ value: T } | { failure: string }> {
  await beforeOpen?.(entry);
  const handle = await fs.open(
    entry,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if (!sameDirectory(before, await handle.stat()))
      return { failure: `${entry} was replaced while it was checked` };
    const anchored = await descriptorPath(
      handle,
      (candidate) => fs.stat(candidate),
      readFirstName,
    );
    if (anchored === null)
      return { failure: `could not open ${entry} by its descriptor` };
    return { value: await list(anchored) };
  } finally {
    await handle.close();
  }
}

function knownNotDirectory(entry: DirectoryEntry): boolean {
  return (
    !entry.isDirectory() &&
    (entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.isFIFO() ||
      entry.isSocket() ||
      entry.isCharacterDevice() ||
      entry.isBlockDevice())
  );
}

export async function findNestedRepositories(
  root: string,
  hooks: RepositoryScanHooks = {},
  deadline = performance.now() + (hooks.budgetMs ?? REPOSITORY_SCAN_BUDGET_MS),
): Promise<{ repositories: string[] } | { failure: string }> {
  const budgetMs = hooks.budgetMs ?? REPOSITORY_SCAN_BUDGET_MS;
  const openDirectoryEntries = hooks.openDirectoryEntries ?? openEntries;
  const entryLimit = hooks.entryLimit ?? REPOSITORY_SCAN_ENTRY_LIMIT;
  let read = 0;
  const repositories: string[] = [];
  const pending: string[] = [""];
  let failure: string | null = null;
  const fail = (reason: string) => {
    failure ??= reason;
  };
  const visit = async (relative: string): Promise<void> => {
    if (performance.now() > deadline) {
      fail(`it took longer than ${budgetMs} ms`);
      return;
    }
    const entry = path.join(root, relative);
    try {
      const before = await lstatUnlessGone(entry);
      if (before === null) {
        if (relative === "") fail(`${root} is gone`);
        return;
      }
      if (!before.isDirectory()) return;
      const listing = await withAnchoredDirectory(
        entry,
        before,
        hooks.beforeDirectoryOpen,
        async (anchored) => {
          const listed: DirectoryEntry[] = [];
          for await (const child of await openDirectoryEntries(
            anchored,
            entry,
          )) {
            read += 1;
            if (read > entryLimit) {
              fail(`it has more than ${entryLimit} entries`);
              return null;
            }
            if (performance.now() > deadline) {
              fail(`it took longer than ${budgetMs} ms`);
              return null;
            }
            if (failure !== null) return null;
            listed.push(child);
          }
          return listed;
        },
      );
      if ("failure" in listing) {
        fail(listing.failure);
        return;
      }
      const entries = listing.value;
      if (entries === null) return;
      const names = entries.map(({ name }) => name);
      if (
        relative !== "" &&
        (names.includes(".git") || (await hasRepositoryShape(entry, names)))
      ) {
        repositories.push(relative);
        return;
      }
      for (const child of entries) {
        if (relative === "" && child.name === ".git") continue;
        if (knownNotDirectory(child)) continue;
        pending.push(path.join(relative, child.name));
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT" && relative !== "") return;
      fail(describeError(error));
    }
  };
  let active = 0;
  const walked = new Promise<void>((resolve) => {
    const pump = () => {
      while (failure === null && active < REPOSITORY_SCAN_CONCURRENCY) {
        const relative = pending.pop();
        if (relative === undefined) break;
        active += 1;
        void visit(relative)
          .catch((error: unknown) => fail(describeError(error)))
          .then(() => {
            active -= 1;
            pump();
          });
      }
      if (active === 0 && (failure !== null || pending.length === 0)) resolve();
    };
    pump();
  });
  if ((await beforeDeadline(walked, deadline)) === TIMED_OUT)
    fail(`it took longer than ${budgetMs} ms`);
  if (failure !== null) return { failure };
  return { repositories: repositories.sort() };
}

async function moduleRepositoryReasons(
  gitDir: string,
  hooks: RepositoryScanHooks,
  abandoned: () => boolean,
): Promise<string[]> {
  const modules = path.join(gitDir, "modules");
  const openDirectoryEntries = hooks.openDirectoryEntries ?? openEntries;
  try {
    const info = await lstatUnlessGone(modules);
    if (info === null) return [];
    if (!info.isDirectory())
      return [
        `has a modules entry in its Git metadata that is a ${info.isSymbolicLink() ? "symbolic link" : "file"}, not a directory`,
      ];
    const listing = await withAnchoredDirectory(
      modules,
      info,
      hooks.beforeDirectoryOpen,
      async (anchored) => {
        const names: string[] = [];
        for await (const child of await openDirectoryEntries(
          anchored,
          modules,
        )) {
          if (abandoned()) break;
          names.push(`modules/${child.name}`);
          if (names.length > NAMED_LIMIT) break;
        }
        return names;
      },
    );
    if ("failure" in listing)
      return [
        `could not check for submodule repositories (${listing.failure})`,
      ];
    const entries = listing.value;
    if (entries.length === 0) return [];
    const shown = entries.slice(0, NAMED_LIMIT).sort().join(", ");
    const named = entries.length > NAMED_LIMIT ? `${shown} and more` : shown;
    return [
      `has submodule repositories in its Git metadata (${named}), and removing the worktree would delete them with any unpushed commits`,
    ];
  } catch (error) {
    return [
      `could not check for submodule repositories (${describeError(error)})`,
    ];
  }
}

async function gitlinkReason(
  worktree: string,
  gitlink: string,
): Promise<string | null> {
  try {
    const parts = gitlink.split("/");
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const component = await lstatUnlessGone(
        path.join(worktree, ...parts.slice(0, depth)),
      );
      if (component === null) return null;
      if (component.isSymbolicLink())
        return `has a submodule path ${gitlink} that passes through a symbolic link`;
    }
    const marker = await lstatUnlessGone(path.join(worktree, gitlink, ".git"));
    if (marker === null) return null;
    if (marker.isDirectory())
      return `has a submodule at ${gitlink} whose repository is inside the worktree (${gitlink}/.git) and would be deleted with it`;
    return `has an initialized submodule at ${gitlink}, whose files would be deleted with the worktree`;
  } catch (error) {
    return `could not check submodule ${gitlink} (${describeError(error)})`;
  }
}

export async function findRepositoryReasons(args: {
  worktree: string;
  gitDir: string;
  index: IndexListing;
  scan?: RepositoryScanHooks;
}): Promise<string[]> {
  const scan = args.scan ?? {};
  const budgetMs = scan.budgetMs ?? REPOSITORY_SCAN_BUDGET_MS;
  const deadline = performance.now() + budgetMs;
  let abandoned = false;
  const modules = await beforeDeadline(
    moduleRepositoryReasons(args.gitDir, scan, () => abandoned),
    deadline,
  );
  abandoned = true;
  const reasons =
    modules === TIMED_OUT
      ? [
          `could not check for submodule repositories (it took longer than ${budgetMs} ms)`,
        ]
      : modules;
  const reported = new Set<string>();
  if (args.index.exitCode !== 0) {
    const detail = args.index.stderr.trim();
    reasons.push(
      `could not read its index to look for submodules${detail === "" ? "" : ` (${detail})`}`,
    );
  } else {
    for (const entry of args.index.stdout.split("\0")) {
      const tab = entry.indexOf("\t");
      if (!entry.startsWith(SUBMODULE_MODE) || tab === -1) continue;
      const gitlink = entry.slice(tab + 1);
      const reason = await gitlinkReason(args.worktree, gitlink);
      if (reason === null) continue;
      reasons.push(reason);
      reported.add(gitlink);
    }
  }
  const nested = await findNestedRepositories(args.worktree, scan, deadline);
  if ("failure" in nested) {
    reasons.push(
      `could not finish checking for git repositories inside the worktree (${nested.failure})`,
    );
  } else {
    const unreported = nested.repositories.filter(
      (repository) => !reported.has(repository.split(path.sep).join("/")),
    );
    if (unreported.length > 0)
      reasons.push(
        `has a git repository inside the worktree at ${namedPaths(unreported)}`,
      );
  }
  return reasons;
}
