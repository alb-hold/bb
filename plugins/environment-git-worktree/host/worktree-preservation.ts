import { hasPreservableStatus } from "./regenerable-output.js";
import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runGit,
  WorkspaceError,
  type GitCommandResult,
} from "bb-environment-provider-host/git";
import {
  describeHolderScan,
  scanWorktreeHolders,
  type WorktreeHolderScan,
} from "./holders.js";
import { parseWorktreeListPorcelain } from "./worktree-list.js";

export const KEEP_WORKTREE_MARKER = ".keep-worktree";
export const WORKTREE_PRESERVED_CODE = "worktree_preserved";
export const NON_ROOT_LINUX_HOLDER_SCOPE_NOTICE =
  "Root and system-UID (<1000) processes are not inspected by this non-root daemon.";

export function worktreeHolderScopeNotice(): string | null {
  return process.platform === "linux" && process.getuid?.() !== 0
    ? NON_ROOT_LINUX_HOLDER_SCOPE_NOTICE
    : null;
}

let testWorktreeHolderScan: WorktreeHolderScan | undefined;

export function setTestWorktreeHolderScan(
  scan: WorktreeHolderScan | undefined,
): void {
  testWorktreeHolderScan = scan;
}

const IN_PROGRESS_OPERATION_PATHS = [
  "MERGE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "BISECT_START",
];

export interface WorktreeIdentity {
  path: string;
  gitDir: string;
  commonDir: string;
  locked: boolean;
}

export type WorktreeIdentityResult =
  | { status: "missing" }
  | { status: "identified"; identity: WorktreeIdentity }
  | { status: "preserve"; reasons: string[] };

export function worktreePreservedError(
  worktreePath: string,
  reasons: readonly string[],
): WorkspaceError {
  const scopeNotice = worktreeHolderScopeNotice();
  return new WorkspaceError(
    WORKTREE_PRESERVED_CODE,
    `Kept ${worktreePath}: ${reasons.join("; ")}. Commit and push the work, or remove the worktree yourself; bb retries the removal automatically.${scopeNotice === null ? "" : ` ${scopeNotice}`}`,
  );
}

export function isWorktreePreservedError(
  error: unknown,
): error is WorkspaceError {
  return (
    error instanceof WorkspaceError && error.code === WORKTREE_PRESERVED_CODE
  );
}

function errorCode(error: unknown): string | null {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function signalOptions(signal: AbortSignal | undefined): {
  signal?: AbortSignal;
} {
  return signal !== undefined ? { signal } : {};
}

function isStrictlyInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export async function entryExists(target: string): Promise<boolean | null> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT" ? false : null;
  }
}

export function gitEnvironment(
  worktreePath: string,
  gitDir?: string,
  commonDir?: string,
): NodeJS.ProcessEnv {
  return {
    GIT_CEILING_DIRECTORIES: path.dirname(worktreePath),
    ...(gitDir !== undefined ? { GIT_DIR: gitDir } : {}),
    ...(commonDir !== undefined ? { GIT_COMMON_DIR: commonDir } : {}),
    ...(gitDir !== undefined ? { GIT_WORK_TREE: worktreePath } : {}),
  };
}

export async function identifyWorktree(args: {
  path: string;
  rootPath: string;
  signal?: AbortSignal | undefined;
}): Promise<WorktreeIdentityResult> {
  const target = path.resolve(args.path);
  let info;
  try {
    info = await fs.lstat(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { status: "missing" };
    }
    return {
      status: "preserve",
      reasons: [`could not be inspected (${describeError(error)})`],
    };
  }
  if (info.isSymbolicLink()) {
    return { status: "preserve", reasons: ["is a symbolic link"] };
  }
  if (!info.isDirectory()) {
    return { status: "preserve", reasons: ["is not a directory"] };
  }

  let real: string;
  let rootReal: string;
  try {
    real = await fs.realpath(target);
    rootReal = await fs.realpath(args.rootPath);
  } catch (error) {
    return {
      status: "preserve",
      reasons: [`could not be resolved (${describeError(error)})`],
    };
  }
  if (!isStrictlyInside(rootReal, real)) {
    return {
      status: "preserve",
      reasons: [`is outside the managed worktree directory ${rootReal}`],
    };
  }

  const revParse = await runGit(
    [
      "--no-optional-locks",
      "rev-parse",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
    ],
    {
      cwd: real,
      env: gitEnvironment(real),
      allowFailure: true,
      ...signalOptions(args.signal),
    },
  );
  const [toplevel, gitDir, commonDir, ...extra] = revParse.stdout
    .trimEnd()
    .split("\n");
  if (
    revParse.exitCode !== 0 ||
    !toplevel ||
    !gitDir ||
    !commonDir ||
    extra.length > 0
  ) {
    return {
      status: "preserve",
      reasons: [
        `is not a Git worktree root${revParse.stderr.trim() ? ` (${revParse.stderr.trim()})` : ""}`,
      ],
    };
  }

  let toplevelReal: string;
  let gitDirReal: string;
  let commonDirReal: string;
  try {
    toplevelReal = await fs.realpath(path.resolve(real, toplevel));
    gitDirReal = await fs.realpath(path.resolve(real, gitDir));
    commonDirReal = await fs.realpath(path.resolve(real, commonDir));
  } catch (error) {
    return {
      status: "preserve",
      reasons: [`has unresolvable Git metadata (${describeError(error)})`],
    };
  }
  if (toplevelReal !== real) {
    return {
      status: "preserve",
      reasons: [`is not the root of its Git checkout (${toplevelReal})`],
    };
  }
  if (gitDirReal === commonDirReal) {
    return {
      status: "preserve",
      reasons: ["is a main checkout, not a linked worktree"],
    };
  }

  const list = await runGit(
    ["--git-dir", commonDirReal, "worktree", "list", "--porcelain", "-z"],
    {
      cwd: real,
      env: gitEnvironment(real),
      allowFailure: true,
      ...signalOptions(args.signal),
    },
  );
  if (list.exitCode !== 0) {
    return {
      status: "preserve",
      reasons: [
        `could not be matched to its repository's worktree list${list.stderr.trim() ? ` (${list.stderr.trim()})` : ""}`,
      ],
    };
  }
  for (const entry of parseWorktreeListPorcelain(list.stdout)) {
    let entryReal: string;
    try {
      entryReal = await fs.realpath(entry.path);
    } catch {
      continue;
    }
    if (entryReal !== real) continue;
    if (entry.isMain || entry.isBare) {
      return {
        status: "preserve",
        reasons: ["is the repository's main checkout"],
      };
    }
    return {
      status: "identified",
      identity: {
        path: real,
        gitDir: gitDirReal,
        commonDir: commonDirReal,
        locked: entry.locked,
      },
    };
  }
  return {
    status: "preserve",
    reasons: [`is not registered in the worktree list of ${commonDirReal}`],
  };
}

export async function findStructuralReasons(
  identity: WorktreeIdentity,
): Promise<string[]> {
  const reasons: string[] = [];
  if (identity.locked) {
    reasons.push("is locked (git worktree lock)");
  }

  const marker = await entryExists(
    path.join(identity.path, KEEP_WORKTREE_MARKER),
  );
  if (marker === true) {
    reasons.push(`contains ${KEEP_WORKTREE_MARKER}`);
  } else if (marker === null) {
    reasons.push(`could not check for ${KEEP_WORKTREE_MARKER}`);
  }

  for (const name of IN_PROGRESS_OPERATION_PATHS) {
    const present = await entryExists(path.join(identity.gitDir, name));
    if (present === true) {
      reasons.push(`has a Git operation in progress (${name})`);
    } else if (present === null) {
      reasons.push(`could not check for a Git operation in progress (${name})`);
    }
  }
  const bisectRefs = await runGit(
    ["for-each-ref", "--format=%(refname)", "refs/bisect"],
    {
      cwd: identity.path,
      env: gitEnvironment(identity.path, identity.gitDir, identity.commonDir),
      allowFailure: true,
    },
  );
  if (bisectRefs.exitCode !== 0) {
    reasons.push(
      `could not check for refs/bisect state${bisectRefs.stderr.trim() ? ` (${bisectRefs.stderr.trim()})` : ""}`,
    );
  } else if (bisectRefs.stdout.trim() !== "") {
    reasons.push("has refs/bisect state");
  }
  return reasons;
}

const FETCH_TIMEOUT_MS = 60_000;
const FETCH_MEMO_MS = 30_000;
const EVIDENCE_REPOSITORY_PREFIX = "bb-teardown-fetch-";
const ABANDONED_EVIDENCE_AGE_MS = 60 * 60_000;
const FETCH_FAILED =
  "could not fetch its remotes to verify its commits are published";

export interface RemoteEvidence {
  readonly reason: string | null;
  readonly repository: string | null;
  readonly published: readonly string[];
  readonly bytes: number | null;
  readonly ignoredConfig: readonly string[];
}

export interface RemoteEvidenceLease {
  readonly evidence: RemoteEvidence;
  release(): Promise<void>;
}

interface EvidenceEntry {
  settledAt: number | null;
  outcome: Promise<RemoteEvidence>;
  holders: number;
  retired: boolean;
  timer: NodeJS.Timeout | null;
}

const NO_REMOTE_EVIDENCE: RemoteEvidence = {
  reason: null,
  repository: null,
  published: [],
  bytes: null,
  ignoredConfig: [],
};
const fetchMemo = new Map<string, EvidenceEntry>();
const liveEvidenceRepositories = new Set<string>();
const watchedLifecycles = new WeakSet<AbortSignal>();
let exitCleanupRegistered = false;
let abandonedEvidenceSweep: Promise<void> | null = null;

function failedEvidence(reason: string): RemoteEvidence {
  return { ...NO_REMOTE_EVIDENCE, reason };
}

async function removeEvidenceRepository(repository: string): Promise<void> {
  try {
    await fs.rm(repository, { recursive: true, force: true });
    liveEvidenceRepositories.delete(repository);
  } catch {
    return;
  }
}

async function discardEvidence(entry: EvidenceEntry): Promise<void> {
  if (!entry.retired || entry.holders > 0) return;
  const { repository } = await entry.outcome;
  if (repository !== null) await removeEvidenceRepository(repository);
}

async function retireEvidence(
  commonDir: string,
  entry: EvidenceEntry,
): Promise<void> {
  entry.retired = true;
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (fetchMemo.get(commonDir) === entry) fetchMemo.delete(commonDir);
  await discardEvidence(entry);
}

export async function clearFetchMemo(): Promise<void> {
  const entries = [...fetchMemo.entries()];
  fetchMemo.clear();
  await Promise.all(
    entries.map(([commonDir, entry]) => retireEvidence(commonDir, entry)),
  );
}

export function clearFetchMemoWhenAborted(signal: AbortSignal): void {
  if (watchedLifecycles.has(signal)) return;
  watchedLifecycles.add(signal);
  if (signal.aborted) {
    void clearFetchMemo();
    return;
  }
  signal.addEventListener("abort", () => void clearFetchMemo(), {
    once: true,
  });
}

function registerExitCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.once("exit", () => {
    for (const repository of liveEvidenceRepositories) {
      try {
        rmSync(repository, { recursive: true, force: true });
      } catch {
        continue;
      }
    }
  });
}

async function sweepAbandonedEvidence(): Promise<void> {
  const root = os.tmpdir();
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return;
  }
  const uid = process.getuid?.();
  await Promise.all(
    names
      .filter((name) => name.startsWith(EVIDENCE_REPOSITORY_PREFIX))
      .map(async (name) => {
        const target = path.join(root, name);
        if (liveEvidenceRepositories.has(target)) return;
        try {
          const info = await fs.lstat(target);
          if (!info.isDirectory()) return;
          if (uid !== undefined && info.uid !== uid) return;
          if (Date.now() - info.mtimeMs < ABANDONED_EVIDENCE_AGE_MS) return;
          await fs.rm(target, { recursive: true, force: true });
        } catch {
          return;
        }
      }),
  );
}

export async function acquireRemoteEvidence(
  identity: WorktreeIdentity,
  signal: AbortSignal | undefined,
  options: {
    fetchTimeoutMs?: number;
    fetchMemoMs?: number;
    untrustedRoots?: readonly string[];
  } = {},
): Promise<RemoteEvidenceLease> {
  abandonedEvidenceSweep ??= sweepAbandonedEvidence();
  const memoMs = options.fetchMemoMs ?? FETCH_MEMO_MS;
  const known = fetchMemo.get(identity.commonDir);
  if (
    known !== undefined &&
    known.settledAt !== null &&
    Date.now() - known.settledAt >= memoMs
  )
    await retireEvidence(identity.commonDir, known);
  let entry = fetchMemo.get(identity.commonDir);
  if (entry === undefined) {
    const created: EvidenceEntry = {
      settledAt: null,
      outcome: Promise.resolve(NO_REMOTE_EVIDENCE),
      holders: 0,
      retired: false,
      timer: null,
    };
    created.outcome = gatherRemoteEvidence(
      identity,
      signal,
      options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS,
      options.untrustedRoots ?? [],
    ).finally(() => {
      created.settledAt = Date.now();
      if (created.retired) return;
      created.timer = setTimeout(
        () => void retireEvidence(identity.commonDir, created),
        memoMs,
      );
      created.timer.unref();
    });
    fetchMemo.set(identity.commonDir, created);
    entry = created;
  }
  const held = entry;
  held.holders += 1;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    held.holders -= 1;
    await discardEvidence(held);
  };
  try {
    return { evidence: await held.outcome, release };
  } catch (error) {
    await release();
    throw error;
  }
}

function isolatedGitEnvironment(repository: string): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_GLOBAL: path.join(repository, FETCH_CONFIG_FILE),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: path.dirname(repository),
    GIT_DIR: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_NAMESPACE: undefined,
  };
}

function isolatedGitOptions(
  repository: string,
  signal: AbortSignal | undefined,
) {
  return {
    cwd: repository,
    env: isolatedGitEnvironment(repository),
    allowFailure: true,
    ...signalOptions(signal),
  };
}

function isEmptyConfigMatch(result: GitCommandResult): boolean {
  return result.exitCode === 1 && result.stderr.trim() === "";
}

function withDetail(text: string, detail: string): string {
  const trimmed = detail.trim();
  return trimmed === "" ? text : `${text} (${trimmed})`;
}

interface ConfiguredRemote {
  name: string;
  url: string | null;
}

function resolveRemoteUrl(url: string, worktreePath: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(url)) return url;
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  if (colon !== -1 && (slash === -1 || colon < slash)) return url;
  return path.resolve(worktreePath, url);
}

function configEntries(
  stdout: string,
): Array<{ key: string; value: string | null }> {
  return stdout
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => {
      const newline = entry.indexOf("\n");
      return newline === -1
        ? { key: entry, value: null }
        : { key: entry.slice(0, newline), value: entry.slice(newline + 1) };
    });
}

function remoteNameOf(key: string): string {
  return key.slice("remote.".length, key.lastIndexOf("."));
}

async function configuredRemotes(
  worktreePath: string,
  gitOptions: Parameters<typeof runGit>[1],
): Promise<ConfiguredRemote[] | string> {
  const listed = await runGit(
    [
      "--no-optional-locks",
      "config",
      "--null",
      "--get-regexp",
      "^remote\\..+\\.(url|pushurl|fetch)$",
    ],
    gitOptions,
  );
  if (listed.exitCode !== 0 && !isEmptyConfigMatch(listed))
    return withDetail(FETCH_FAILED, listed.stderr);
  const skipped = await runGit(
    [
      "--no-optional-locks",
      "config",
      "--null",
      "--type=bool",
      "--get-regexp",
      "^remote\\..+\\.skipfetchall$",
    ],
    gitOptions,
  );
  if (skipped.exitCode !== 0 && !isEmptyConfigMatch(skipped))
    return withDetail(FETCH_FAILED, skipped.stderr);
  const urls = new Map<string, string | null>();
  for (const { key, value } of configEntries(listed.stdout)) {
    const name = remoteNameOf(key);
    if (!urls.has(name)) urls.set(name, null);
    if (key.endsWith(".url") && urls.get(name) === null && value)
      urls.set(name, resolveRemoteUrl(value, worktreePath));
  }
  for (const { key, value } of configEntries(skipped.stdout))
    if (value === "true") urls.delete(remoteNameOf(key));
  return [...urls].map(([name, url]) => ({ name, url }));
}

async function copyShallowBoundary(
  commonDir: string,
  repository: string,
): Promise<void> {
  let boundary: string;
  try {
    boundary = await fs.readFile(path.join(commonDir, "shallow"), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  await fs.writeFile(path.join(repository, "shallow"), boundary);
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile()) total += (await fs.lstat(target)).size;
  }
  return total;
}

function outputLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line !== "");
}

const FETCH_CONFIG_FILE = "bb-fetch.gitconfig";
const FETCH_CONFIG_KEYS =
  "^(core\\.sshcommand|url\\..*\\.insteadof|credential\\.(.*\\.)?usehttppath)$";
const REMOTE_HELPER_PREFIX = /^[a-z][a-z0-9+.-]*::/iu;
const DOS_DRIVE_PREFIX = /^[a-z]:/iu;

function isEnabledFlag(value: string | undefined): boolean {
  return value !== undefined && /^(?:true|yes|on|[1-9]\d*)$/iu.test(value);
}

function hostIsSafe(hostPart: string): boolean {
  const host = hostPart.slice(hostPart.lastIndexOf("@") + 1);
  return host !== "" && !host.startsWith("-") && !hostPart.startsWith("-");
}

export function isAcceptedRewriteTarget(target: string): boolean {
  const scheme = /^(ssh|https):\/\/([^/]*)/iu.exec(target);
  if (scheme !== null)
    return scheme[1]?.toLowerCase() === "https" || hostIsSafe(scheme[2] ?? "");
  if (target.includes("://") || REMOTE_HELPER_PREFIX.test(target)) return false;
  const colon = target.indexOf(":");
  if (colon === -1) return false;
  const slash = target.indexOf("/");
  if (slash !== -1 && slash < colon) return false;
  if (DOS_DRIVE_PREFIX.test(target)) return false;
  return hostIsSafe(target.slice(0, colon));
}

async function realOrResolved(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function untrustedConfigRoots(
  identity: WorktreeIdentity,
  extra: readonly string[],
): Promise<string[]> {
  const roots = [
    identity.path,
    identity.commonDir,
    path.basename(identity.commonDir) === ".git"
      ? path.dirname(identity.commonDir)
      : identity.commonDir,
    path.join(os.homedir(), ".bb"),
    ...extra,
  ];
  const registered = path.join(identity.commonDir, "worktrees");
  for (const name of await fs.readdir(registered).catch(() => [])) {
    const gitdir = await fs
      .readFile(path.join(registered, name, "gitdir"), "utf8")
      .catch(() => null);
    if (gitdir !== null && gitdir.trim() !== "")
      roots.push(path.dirname(gitdir.trim()));
  }
  return await Promise.all(roots.map(realOrResolved));
}

interface FetchConfig {
  entries: Array<{ key: string; value: string }>;
  sshCommand: string | null;
  ignored: string[];
}

async function trustedFetchConfig(
  identity: WorktreeIdentity,
  signal: AbortSignal | undefined,
  extraRoots: readonly string[],
): Promise<FetchConfig | string> {
  const untrusted = await untrustedConfigRoots(identity, extraRoots);
  const scopes = isEnabledFlag(process.env.GIT_CONFIG_NOSYSTEM)
    ? ["--global"]
    : ["--system", "--global"];
  const config: FetchConfig = { entries: [], sshCommand: null, ignored: [] };
  for (const scope of scopes) {
    const read = await runGit(
      [
        "--no-optional-locks",
        "config",
        scope,
        "--includes",
        "--show-origin",
        "--null",
        "--get-regexp",
        FETCH_CONFIG_KEYS,
      ],
      {
        cwd: identity.commonDir,
        env: {
          GIT_DIR: identity.commonDir,
          GIT_COMMON_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_INDEX_FILE: undefined,
          GIT_NAMESPACE: undefined,
        },
        allowFailure: true,
        ...signalOptions(signal),
      },
    );
    if (read.exitCode !== 0 && !isEmptyConfigMatch(read))
      return withDetail(FETCH_FAILED, read.stderr);
    const fields = read.stdout.split("\0");
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const origin = fields[index] ?? "";
      const entry = fields[index + 1] ?? "";
      const newline = entry.indexOf("\n");
      if (newline === -1) continue;
      const key = entry.slice(0, newline);
      const value = entry.slice(newline + 1);
      const file = origin.startsWith(FILE_ORIGIN)
        ? origin.slice(FILE_ORIGIN.length)
        : null;
      const ignore = (why: string) =>
        config.ignored.push(`${key} from ${origin} (${why})`);
      if (file === null || !path.isAbsolute(file)) {
        ignore("not read from a config file");
        continue;
      }
      const real = await fs.realpath(file).catch(() => null);
      const info = real === null ? null : await fs.stat(real).catch(() => null);
      if (real === null || info === null || !info.isFile()) {
        ignore("its file could not be resolved");
        continue;
      }
      if (untrusted.some((root) => isWithin(root, real))) {
        ignore("its file is inside a repository or workspace");
        continue;
      }
      if (key === "core.sshcommand") {
        config.sshCommand = value.trim() === "" ? null : value;
        continue;
      }
      if (key.startsWith("credential.")) {
        config.entries.push({ key, value });
        continue;
      }
      const target = key.slice("url.".length, -".insteadof".length);
      if (!isAcceptedRewriteTarget(target)) {
        ignore("its target is not an ssh or https URL");
        continue;
      }
      config.entries.push({ key, value });
    }
  }
  return config;
}

async function gatherRemoteEvidence(
  identity: WorktreeIdentity,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  untrustedRoots: readonly string[],
): Promise<RemoteEvidence> {
  const deadline = Date.now() + timeoutMs;
  const gitOptions = {
    cwd: identity.path,
    env: gitEnvironment(identity.path, undefined, identity.commonDir),
    allowFailure: true,
    ...signalOptions(signal),
  };
  let repository: string | null = null;
  let usable = false;
  try {
    const remotes = await configuredRemotes(identity.path, gitOptions);
    if (typeof remotes === "string") return failedEvidence(remotes);
    if (remotes.length === 0) return NO_REMOTE_EVIDENCE;
    const format = await runGit(
      ["--no-optional-locks", "rev-parse", "--show-object-format"],
      gitOptions,
    );
    const objectFormat = format.stdout.trim();
    if (format.exitCode !== 0 || objectFormat === "")
      return failedEvidence(withDetail(FETCH_FAILED, format.stderr));
    const fetchConfig = await trustedFetchConfig(
      identity,
      signal,
      untrustedRoots,
    );
    if (typeof fetchConfig === "string") return failedEvidence(fetchConfig);
    repository = await fs.mkdtemp(
      path.join(os.tmpdir(), EVIDENCE_REPOSITORY_PREFIX),
    );
    liveEvidenceRepositories.add(repository);
    registerExitCleanup();
    const isolated = isolatedGitOptions(repository, signal);
    const configFile = path.join(repository, FETCH_CONFIG_FILE);
    await fs.writeFile(configFile, "", { mode: 0o600 });
    const ignoredConfig = [...fetchConfig.ignored];
    for (const { key, value } of fetchConfig.entries) {
      const written = await runGit(
        ["config", "--file", configFile, "--add", key, value],
        isolated,
      );
      if (written.exitCode !== 0)
        ignoredConfig.push(`${key} (${written.stderr.trim()})`);
    }
    const init = await runGit(
      [
        "init",
        "--bare",
        "--quiet",
        "--template=",
        `--object-format=${objectFormat}`,
        repository,
      ],
      isolated,
    );
    if (init.exitCode !== 0)
      return failedEvidence(withDetail(FETCH_FAILED, init.stderr));
    await fs.mkdir(path.join(repository, "objects", "info"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repository, "objects", "info", "alternates"),
      `${path.join(identity.commonDir, "objects")}\n`,
    );
    await copyShallowBoundary(identity.commonDir, repository);
    const helpers = await runGit(
      [
        "--no-optional-locks",
        "config",
        "--null",
        "--no-includes",
        "--show-scope",
        "--show-origin",
        "--get-regexp",
        CREDENTIAL_HELPER_KEYS,
      ],
      gitOptions,
    );
    const replayed = replayedCredentialHelpers(
      helpers.exitCode === 0 ? helpers.stdout : "",
    );
    const environment = {
      ...nonInteractiveFetchEnvironment(
        isolatedGitEnvironment(repository),
        process.env,
        fetchConfig.sshCommand,
      ),
      ...replayed.env,
    };
    const failures: string[] = [];
    for (const [index, remote] of remotes.entries()) {
      if (remote.url === null) {
        failures.push(
          `remote ${remote.name} has no URL\nerror: could not fetch ${remote.name}`,
        );
        continue;
      }
      const timedOut = `${FETCH_FAILED} (git fetch ${remote.name} timed out after ${timeoutMs}ms)`;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return failedEvidence(timedOut);
      let fetched: GitCommandResult;
      try {
        fetched = await runGit(
          [
            `--git-dir=${repository}`,
            "-c",
            "credential.helper=",
            ...replayed.args,
            "-c",
            "gc.auto=0",
            "-c",
            "maintenance.auto=false",
            "fetch",
            "--no-tags",
            "--quiet",
            "--no-recurse-submodules",
            "--upload-pack=git-upload-pack",
            "--end-of-options",
            remote.url,
            `+refs/heads/*:refs/remotes/${index}/*`,
          ],
          { ...isolated, env: environment, timeoutMs: remaining },
        );
      } catch (error) {
        if (errorCode(error) === "git_command_timeout")
          return failedEvidence(timedOut);
        throw error;
      }
      if (fetched.exitCode !== 0)
        failures.push(
          `${fetched.stderr.trimEnd()}\nerror: could not fetch ${remote.name}`,
        );
    }
    const tips = await runGit(
      [
        `--git-dir=${repository}`,
        "for-each-ref",
        "--format=%(objectname)",
        "refs/remotes",
      ],
      isolated,
    );
    if (tips.exitCode !== 0)
      return failedEvidence(withDetail(FETCH_FAILED, tips.stderr));
    usable = true;
    return {
      reason:
        failures.length > 0 ? fetchFailureReason(failures.join("\n")) : null,
      repository,
      published: outputLines(tips.stdout),
      bytes: await directoryBytes(repository).catch(() => null),
      ignoredConfig,
    };
  } catch (error) {
    return failedEvidence(
      `${FETCH_FAILED} (${redactUrlCredentials(describeError(error))})`,
    );
  } finally {
    if (!usable && repository !== null)
      await removeEvidenceRepository(repository);
  }
}

const BATCH_MODE_OPTION = "-o BatchMode=yes";
const NON_INTERACTIVE_FETCH_ENVIRONMENT: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "true",
  SSH_ASKPASS: "true",
  SSH_ASKPASS_REQUIRE: "never",
  GCM_INTERACTIVE: "never",
};

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function nonInteractiveFetchEnvironment(
  environment: NodeJS.ProcessEnv,
  inherited: NodeJS.ProcessEnv,
  configuredSshCommand: string | null,
): NodeJS.ProcessEnv {
  const sshCommand =
    inherited.GIT_SSH_COMMAND ??
    configuredSshCommand ??
    (inherited.GIT_SSH !== undefined && inherited.GIT_SSH !== ""
      ? shellQuote(inherited.GIT_SSH)
      : "ssh");
  return {
    ...environment,
    ...NON_INTERACTIVE_FETCH_ENVIRONMENT,
    GIT_SSH_COMMAND: `${sshCommand} ${BATCH_MODE_OPTION}`,
  };
}
const CREDENTIAL_HELPER_KEYS = "^credential\\..*helper$";
const TRUSTED_SCOPES = new Set(["system", "global"]);
const FILE_ORIGIN = "file:";
const NON_INTERACTIVE_HELPER = /^(?:!|(?:store|cache)(?:\s|$))/u;
const DIALOG_HELPER =
  /osxkeychain|credential-manager|manager-core|wincred|libsecret|(?:^|[\s!/])manager(?:\s|$)/u;

function isCredentialHelperKey(key: string): boolean {
  return (
    !key.includes("=") &&
    (key === "credential.helper" ||
      (key.startsWith("credential.") && key.endsWith(".helper")))
  );
}

function trustedConfigEntries(
  configured: string,
): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = [];
  const fields = configured.split("\0");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const scope = fields[index];
    const origin = fields[index + 1];
    const entry = fields[index + 2];
    if (scope === undefined || origin === undefined || entry === undefined)
      continue;
    if (!TRUSTED_SCOPES.has(scope)) continue;
    if (!origin.startsWith(FILE_ORIGIN)) continue;
    const newline = entry.indexOf("\n");
    if (newline === -1) continue;
    entries.push({
      key: entry.slice(0, newline),
      value: entry.slice(newline + 1),
    });
  }
  return entries;
}

export function replayedCredentialHelpers(configured: string): {
  args: string[];
  env: Record<string, string>;
} {
  const args: string[] = [];
  const env: Record<string, string> = {};
  for (const { key, value } of trustedConfigEntries(configured)) {
    if (!isCredentialHelperKey(key)) continue;
    if (value === "") {
      args.push("-c", `${key}=`);
      continue;
    }
    if (!NON_INTERACTIVE_HELPER.test(value) || DIALOG_HELPER.test(value))
      continue;
    const name = `BB_FETCH_CREDENTIAL_HELPER_${Object.keys(env).length}`;
    env[name] = value;
    args.push(`--config-env=${key}=${name}`);
  }
  return { args, env };
}

const AUTHENTICATION_FAILURE =
  /Authentication failed for '([^']+)'|could not read (?:Username|Password) for '([^']+)'|Permission denied \(publickey/u;
const UNFETCHED_REMOTE = /^error: could not fetch (\S+)$/u;

function redactUrlCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s']+@/giu, "$1");
}

function authenticationFailures(stderr: string): string[] {
  const failed: string[] = [];
  let block: string[] = [];
  for (const line of stderr.split("\n")) {
    const remote = UNFETCHED_REMOTE.exec(line)?.[1];
    if (remote === undefined) {
      block.push(line);
      continue;
    }
    if (AUTHENTICATION_FAILURE.test(block.join("\n"))) failed.push(remote);
    block = [];
  }
  const unnamed = AUTHENTICATION_FAILURE.exec(block.join("\n"));
  if (unnamed !== null) failed.push(unnamed[1] ?? unnamed[2] ?? "its remote");
  return failed;
}

export function fetchFailureReason(stderr: string): string {
  const detail = redactUrlCredentials(stderr.trim());
  const suffix = detail ? ` (${detail})` : "";
  const failed = authenticationFailures(detail);
  return failed.length > 0
    ? `could not verify remotes: authentication failed for ${failed.join(", ")}${suffix}`
    : `could not fetch its remotes to verify its commits are published${suffix}`;
}
const STASH_SUBJECT = /^(?:WIP on|On) ([^:]+): /;
function stashBranch(subject: string): string | null {
  return STASH_SUBJECT.exec(subject)?.[1] ?? null;
}

const BRANCH_CREATED = "branch: Created from";

async function findZeroCommitBase(
  branchName: string,
  gitOptions: Parameters<typeof runGit>[1],
): Promise<string | null> {
  const head = await runGit(
    ["--no-optional-locks", "rev-parse", "HEAD"],
    gitOptions,
  );
  if (head.exitCode !== 0) return null;
  const reflog = await runGit(
    [
      "--no-optional-locks",
      "-c",
      "log.showSignature=false",
      "reflog",
      "show",
      "--format=%H%x09%gs",
      `refs/heads/${branchName}`,
    ],
    gitOptions,
  );
  if (reflog.exitCode !== 0) return null;
  const entries = reflog.stdout.split("\n").filter((line) => line !== "");
  const oldest = entries[entries.length - 1];
  if (oldest === undefined) return null;
  const [sha, subject] = oldest.split("\t");
  if (sha === undefined || subject === undefined) return null;
  if (!subject.startsWith(BRANCH_CREATED)) return null;
  return sha === head.stdout.trim() ? sha : null;
}

const FILTER_DRIVER_KEYS = "^filter\\..*\\.(clean|smudge|process|required)$";
const FILTER_COMMANDS = ["clean", "smudge", "process"] as const;
const SUBMODULE_MODE = "160000 ";

async function neutralisedFilterDrivers(
  gitOptions: Parameters<typeof runGit>[1],
  signal: AbortSignal | undefined,
): Promise<
  { args: string[]; env: Record<string, string> } | { failure: string }
> {
  const names = new Set<string>();
  const defined = new Set<string>();
  const visited = new Set<string>();
  const pending = [gitOptions];
  for (
    let current = pending.pop();
    current !== undefined;
    current = pending.pop()
  ) {
    const listed = await runGit(
      [
        "--no-optional-locks",
        "config",
        "--null",
        "--name-only",
        "--get-regexp",
        FILTER_DRIVER_KEYS,
      ],
      current,
    );
    if (listed.exitCode !== 0 && !isEmptyConfigMatch(listed))
      return { failure: listed.stderr.trim() };
    for (const key of listed.stdout.split("\0")) {
      const name = key.slice("filter.".length, key.lastIndexOf("."));
      if (name.includes("="))
        return {
          failure: `filter driver ${name} cannot be overridden on Git's command line`,
        };
      if (name === "") continue;
      names.add(name);
      defined.add(key);
    }
    const staged = await runGit(
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "ls-files",
        "--stage",
        "-z",
      ],
      current,
    );
    if (staged.exitCode !== 0) return { failure: staged.stderr.trim() };
    for (const entry of staged.stdout.split("\0")) {
      const tab = entry.indexOf("\t");
      if (!entry.startsWith(SUBMODULE_MODE) || tab === -1) continue;
      const submodule = path.join(current.cwd, entry.slice(tab + 1));
      if (visited.has(submodule)) continue;
      visited.add(submodule);
      const checkedOut = await entryExists(path.join(submodule, ".git"));
      if (checkedOut === null)
        return { failure: `could not inspect submodule ${submodule}` };
      if (checkedOut)
        pending.push({
          cwd: submodule,
          env: gitEnvironment(submodule),
          allowFailure: true,
          ...signalOptions(signal),
        });
    }
  }
  if (names.size === 0) return { args: [], env: {} };
  const trusted = await runGit(
    [
      "--no-optional-locks",
      "config",
      "--null",
      "--no-includes",
      "--show-scope",
      "--show-origin",
      "--get-regexp",
      "^filter\\.",
    ],
    gitOptions,
  );
  const values = new Map<string, string>();
  for (const { key, value } of trustedConfigEntries(
    trusted.exitCode === 0 ? trusted.stdout : "",
  ))
    values.set(key, value);
  const args: string[] = [];
  const env: Record<string, string> = {};
  for (const name of names) {
    for (const command of FILTER_COMMANDS) {
      const key = `filter.${name}.${command}`;
      const value = values.get(key);
      if (value !== undefined && value !== "") {
        const variable = `BB_FILTER_DRIVER_${Object.keys(env).length}`;
        env[variable] = value;
        args.push(`--config-env=${key}=${variable}`);
        continue;
      }
      if (defined.has(key)) args.push("-c", `${key}=`);
    }
    args.push("-c", `filter.${name}.required=false`);
  }
  return { args, env };
}

async function firstUnpublishedCommit(
  commit: string,
  published: readonly string[] | null,
  evidence: RemoteEvidence,
  gitOptions: Parameters<typeof runGit>[1],
  signal: AbortSignal | undefined,
): Promise<GitCommandResult> {
  if (published === null)
    return {
      exitCode: 1,
      stdout: "",
      stderr: "could not list its remote-tracking branches",
    };
  const input = [commit, ...published.map((tip) => `^${tip}`), ""].join("\n");
  const args = ["--no-optional-locks", "rev-list", "--max-count=1", "--stdin"];
  return evidence.repository === null
    ? await runGit(args, { ...gitOptions, input })
    : await runGit([`--git-dir=${evidence.repository}`, ...args], {
        ...isolatedGitOptions(evidence.repository, signal),
        input,
      });
}

export async function findPreservationReasons(
  identity: WorktreeIdentity,
  signal: AbortSignal | undefined,
  options: {
    fetchRemotes?: boolean;
    fetchTimeoutMs?: number;
    fetchMemoMs?: number;
    gitDir?: string;
    final?: boolean;
    remotes?: RemoteEvidence;
    untrustedRoots?: readonly string[];
  } = {},
): Promise<string[]> {
  const reasons = await findStructuralReasons(identity);
  const gitOptions = {
    cwd: identity.path,
    env: gitEnvironment(identity.path, options.gitDir, identity.commonDir),
    allowFailure: true,
    ...signalOptions(signal),
  };

  const filters = await neutralisedFilterDrivers(gitOptions, signal);
  if ("failure" in filters) {
    reasons.push(withDetail("could not read its Git status", filters.failure));
  } else {
    const status = await runGit(
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        ...filters.args,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
        "--ignore-submodules=none",
      ],
      { ...gitOptions, env: { ...gitOptions.env, ...filters.env } },
    );
    if (status.exitCode !== 0) {
      reasons.push(withDetail("could not read its Git status", status.stderr));
    } else if (hasPreservableStatus(status.stdout)) {
      reasons.push("has uncommitted changes or untracked files");
    }
  }

  const flaggedFiles = await runGit(
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "ls-files",
      "-v",
      "-z",
    ],
    gitOptions,
  );
  if (flaggedFiles.exitCode !== 0) {
    reasons.push(
      `could not check for files hidden from Git status${flaggedFiles.stderr.trim() ? ` (${flaggedFiles.stderr.trim()})` : ""}`,
    );
  } else if (
    flaggedFiles.stdout.split("\0").some((entry) => /^[a-z]|^S/u.test(entry))
  ) {
    reasons.push("has files marked assume-unchanged or skip-worktree");
  }

  const head = await runGit(
    ["--no-optional-locks", "symbolic-ref", "--short", "-q", "HEAD"],
    gitOptions,
  );
  const branchName = head.exitCode === 0 ? head.stdout.trim() : null;
  const stashes = await runGit(
    ["--no-optional-locks", "stash", "list", "--format=%gs"],
    gitOptions,
  );
  if (stashes.exitCode !== 0) {
    reasons.push(
      `could not list its stashes${stashes.stderr.trim() ? ` (${stashes.stderr.trim()})` : ""}`,
    );
  } else {
    const own = stashes.stdout
      .split("\n")
      .filter(
        (subject) => stashBranch(subject) === (branchName ?? "(no branch)"),
      );
    if (own.length > 0) {
      reasons.push(
        `has ${own.length} stashed change${own.length === 1 ? "" : "s"} (git stash)`,
      );
    }
  }

  let lease: RemoteEvidenceLease | null = null;
  try {
    let evidence = options.remotes ?? NO_REMOTE_EVIDENCE;
    if (options.remotes === undefined && options.fetchRemotes !== false) {
      lease = await acquireRemoteEvidence(identity, signal, {
        ...(options.fetchTimeoutMs !== undefined
          ? { fetchTimeoutMs: options.fetchTimeoutMs }
          : {}),
        ...(options.fetchMemoMs !== undefined
          ? { fetchMemoMs: options.fetchMemoMs }
          : {}),
        ...(options.untrustedRoots !== undefined
          ? { untrustedRoots: options.untrustedRoots }
          : {}),
      });
      evidence = lease.evidence;
    }
    if (evidence.reason !== null) reasons.push(evidence.reason);

    const sourceTips = await runGit(
      [
        "--no-optional-locks",
        "for-each-ref",
        "--format=%(objectname)",
        "refs/remotes",
      ],
      gitOptions,
    );
    const published =
      sourceTips.exitCode === 0
        ? [
            ...new Set([
              ...evidence.published,
              ...outputLines(sourceTips.stdout),
            ]),
          ]
        : null;
    const unpublishedFrom = (commit: string) =>
      firstUnpublishedCommit(commit, published, evidence, gitOptions, signal);

    const zeroCommitBase =
      branchName === null
        ? null
        : await findZeroCommitBase(branchName, gitOptions);
    if (zeroCommitBase !== null) {
      const baseUnpublished = await unpublishedFrom(zeroCommitBase);
      if (baseUnpublished.exitCode !== 0) {
        reasons.push(
          withDetail(
            `could not verify its base commit ${zeroCommitBase} is published`,
            baseUnpublished.stderr,
          ),
        );
      } else if (baseUnpublished.stdout.trim() !== "") {
        reasons.push(
          `its base commit ${zeroCommitBase} is not reachable from any remote-tracking branch, so the branch holds no commit of its own but starts from work that was never published`,
        );
      }
    } else {
      const headCommit = await runGit(
        ["--no-optional-locks", "rev-parse", "--verify", "HEAD^{commit}"],
        gitOptions,
      );
      const unpublished =
        headCommit.exitCode !== 0
          ? headCommit
          : await unpublishedFrom(headCommit.stdout.trim());
      if (unpublished.exitCode !== 0) {
        reasons.push(
          withDetail(
            "could not verify its commits are published",
            unpublished.stderr,
          ),
        );
      } else if (unpublished.stdout.trim() !== "") {
        const upstream =
          branchName === null
            ? null
            : await runGit(
                [
                  "--no-optional-locks",
                  "rev-parse",
                  "--abbrev-ref",
                  "--symbolic-full-name",
                  `${branchName}@{upstream}`,
                ],
                gitOptions,
              );
        reasons.push(
          branchName !== null && upstream !== null && upstream.exitCode !== 0
            ? `its branch ${branchName} has no upstream and has commits that are not reachable from any remote-tracking branch`
            : "has commits that are not reachable from any remote-tracking branch",
        );
      }
    }
    const worktreeRefs = await runGit(
      [
        "--no-optional-locks",
        "for-each-ref",
        "--format=%(objectname)",
        "refs/worktree",
        "refs/bisect",
      ],
      gitOptions,
    );
    const reflogHead = await runGit(
      [
        "--no-optional-locks",
        "-c",
        "log.showSignature=false",
        "reflog",
        "show",
        "--format=%H",
        "HEAD",
      ],
      gitOptions,
    );
    if (worktreeRefs.exitCode !== 0 || reflogHead.exitCode !== 0) {
      reasons.push(
        "could not verify commits held by this worktree's refs or reflog",
      );
    } else {
      const localCommits = [
        ...outputLines(worktreeRefs.stdout),
        ...outputLines(reflogHead.stdout),
      ];
      for (const commit of localCommits) {
        const retained = await unpublishedFrom(commit);
        if (retained.exitCode !== 0 || retained.stdout.trim() !== "") {
          reasons.push(
            "has unpublished commits held only by this worktree's refs or reflog",
          );
          break;
        }
      }
    }
  } finally {
    await lease?.release();
  }
  const holderReason = describeHolderScan(
    testWorktreeHolderScan ??
      (await scanWorktreeHolders(identity.path, {
        final: options.final === true,
      })),
  );
  if (holderReason !== null) reasons.push(holderReason);
  return reasons;
}
