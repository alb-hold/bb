import { execFile } from "node:child_process";
import { readdirSync, readlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { UNREADABLE_SESSION_AGENT_COMMS } from "./session-agent-comms.js";
import {
  linuxDirectoryIsTraversable,
  linuxDirectoryModeAllowsTraversal,
  linuxPathHasExtendedAcl,
  parseLinuxSupplementaryGroups,
} from "./linux-path-access.js";

const LSOF_TIMEOUT_MS = 30_000;
const LINUX_SCAN_CONCURRENCY = 32;
const PERMISSION_RETRIES = 3;
const PERMISSION_RETRY_MS = 40;

export type LsofResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnFailed: boolean;
  failure?: "timeout" | "maxBuffer" | "spawn" | "signal";
  signal?: string | null;
};

export function mapLsofError(
  error: unknown,
  stdout: string,
  stderr: string,
): LsofResult {
  const value =
    typeof error === "object" && error !== null
      ? (error as {
          code?: unknown;
          killed?: unknown;
          signal?: unknown;
        })
      : null;
  const errorCode = value?.code;
  const code = typeof errorCode === "number" ? errorCode : null;
  const signal = typeof value?.signal === "string" ? value.signal : null;
  const failure =
    errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      ? "maxBuffer"
      : value?.killed === true
        ? "timeout"
        : code === null
          ? signal === null
            ? "spawn"
            : "signal"
          : undefined;
  return {
    code,
    stdout,
    stderr,
    spawnFailed: failure !== undefined,
    ...(failure === undefined ? {} : { failure }),
    signal,
  };
}

export interface WorktreeHolder {
  pid: number;
  command: string | null;
  through: "working folder" | "open file" | "mapped file";
}

export interface FallbackClearance {
  pid: number;
  link: string;
  path: string;
  identity: string;
}

export type WorktreeHolderScan =
  | {
      status: "clear";
      clearances?: FallbackClearance[];
    }
  | { status: "held"; holders: WorktreeHolder[] }
  | { status: "uncertain"; reason: string }
  | { status: "unknown"; reason: string };

function errorCode(error: unknown): string | null {
  return error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
    ? ((error as NodeJS.ErrnoException).code ?? null)
    : null;
}

function isUnder(candidate: string, directory: string): boolean {
  const normalized = candidate.endsWith(" (deleted)")
    ? candidate.slice(0, -" (deleted)".length)
    : candidate;
  return (
    normalized === directory || normalized.startsWith(`${directory}${path.sep}`)
  );
}

function mappedPath(line: string): string {
  return (line.match(/^(?:\S+[ \t]+){5}(.*)$/u)?.[1] ?? "").replace(
    /\\(040|011|012|134)/gu,
    (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

type Mount = { device: string; root: string; point: string };

function parseMountinfo(text: string): Mount[] | null {
  const mounts: Mount[] = [];
  for (const line of text.trim().split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (
      separator < 6 ||
      fields.length < separator + 4 ||
      !/^\d+:\d+$/u.test(fields[2] ?? "")
    )
      return null;
    const decode = (value: string | undefined): string | null => {
      if (value === undefined || !value.startsWith("/")) return null;
      const decoded = value.replace(
        /\\(040|011|012|134)/gu,
        (_match, octal: string) =>
          String.fromCharCode(Number.parseInt(octal, 8)),
      );
      if (/\\(?![\\])/u.test(decoded)) return null;
      return path.posix.normalize(decoded);
    };
    const mountRoot = decode(fields[3]);
    const point = decode(fields[4]);
    if (mountRoot === null || point === null) return null;
    mounts.push({ device: fields[2]!, root: mountRoot, point });
  }
  return mounts.length === 0 ? null : mounts;
}

function mountContains(candidate: string, ancestor: string): boolean {
  return ancestor === "/" || isUnder(candidate, ancestor);
}

async function worktreeAliases(
  proc: ProcReader,
  directory: string,
): Promise<string[] | null> {
  const canonical = await readOptional(() => proc.realpath(directory));
  if (!("value" in canonical) || canonical.value !== directory) return null;
  const own = await readOptional(() => proc.readFile("/proc/self/mountinfo"));
  if (!("value" in own)) return null;
  const mounts = parseMountinfo(own.value);
  if (mounts === null) return null;
  const mount = mounts
    .filter((entry) => mountContains(directory, entry.point))
    .sort((a, b) => b.point.length - a.point.length)[0];
  if (mount === undefined) return null;
  const filesystemPath = path.posix.join(
    mount.root,
    path.posix.relative(mount.point, directory),
  );
  const aliases = new Set([directory]);
  for (const entry of mounts) {
    if (entry.device !== mount.device) continue;
    if (mountContains(filesystemPath, entry.root))
      aliases.add(
        path.posix.join(
          entry.point,
          path.posix.relative(entry.root, filesystemPath),
        ),
      );
    else if (mountContains(entry.root, filesystemPath))
      aliases.add(entry.point);
  }
  return [...aliases];
}

async function foreignMountsExcludeWorktree(
  proc: ProcReader,
  base: string,
  directory: string,
  mountNamespace: string,
): Promise<boolean> {
  const canonical = await readOptional(() => proc.realpath(directory));
  if (!("value" in canonical) || canonical.value !== directory) return false;
  const namespace = await readOptional(() => proc.readlink(`${base}/ns/mnt`));
  if (!("value" in namespace) || namespace.value === mountNamespace)
    return false;
  const own = await readOptional(() => proc.readFile("/proc/self/mountinfo"));
  const foreign = await readOptional(() => proc.readFile(`${base}/mountinfo`));
  if (!("value" in own) || !("value" in foreign)) return false;
  const ownMounts = parseMountinfo(own.value);
  const foreignMounts = parseMountinfo(foreign.value);
  if (ownMounts === null || foreignMounts === null) return false;
  const mount = ownMounts
    .filter((entry) => mountContains(directory, entry.point))
    .sort((a, b) => b.point.length - a.point.length)[0];
  if (mount === undefined) return false;
  const filesystemPath = path.posix.join(
    mount.root,
    path.posix.relative(mount.point, directory),
  );
  return !foreignMounts.some(
    (entry) =>
      entry.device === mount.device &&
      (mountContains(filesystemPath, entry.root) ||
        mountContains(entry.root, filesystemPath)),
  );
}

const GONE_CODES = new Set(["ENOENT", "ESRCH", "ENOTDIR"]);

type Read<T> = { value: T } | { gone: true } | { failed: string };

async function readOptional<T>(read: () => Promise<T>): Promise<Read<T>> {
  try {
    return { value: await read() };
  } catch (error) {
    const code = errorCode(error);
    return code !== null && GONE_CODES.has(code)
      ? { gone: true }
      : { failed: code ?? "unreadable" };
  }
}

export interface ProcReader {
  realpath(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  lstatId(path: string): Promise<string>;
  statId(path: string): Promise<string>;
  statAccess(path: string): Promise<{ uid: number; gid: number; mode: number }>;
  hasExtendedAcl(path: string): Promise<boolean | null>;
  creationMs(directory: string): Promise<number | null>;
  subdirectories(path: string): Promise<string[]>;
}

const LEAVES_PROC =
  /\/(?:root|cwd)\/|\/exe(?:\/|$)|\/fd\/[^/]+\/|\/map_files(?:\/|$)|\/\.\.?(?:\/|$)/u;

export function procReadIsSynchronous(target: string): boolean {
  return (
    (target === "/proc" || target.startsWith("/proc/")) &&
    !LEAVES_PROC.test(target)
  );
}

const PSEUDO_FILE_LINK =
  /^(?:pipe|socket|anon_inode|net|mnt|cgroup|pidfd|user|uts|ipc|time|pid):/u;

export const hostProc: ProcReader = {
  realpath: (path) => fs.realpath(path),
  readlink: async (path) =>
    procReadIsSynchronous(path) ? readlinkSync(path) : fs.readlink(path),
  readFile: (path) => fs.readFile(path, "utf8"),
  readdir: async (path) =>
    procReadIsSynchronous(path) ? readdirSync(path) : fs.readdir(path),
  lstatId: async (path) => {
    const info = await fs.lstat(path, { bigint: true });
    return `${info.dev}:${info.ino}`;
  },
  statId: async (path) => {
    const info = await fs.stat(path, { bigint: true });
    return `${info.dev}:${info.ino}`;
  },
  statAccess: async (path) => {
    const info = await fs.stat(path);
    return { uid: info.uid, gid: info.gid, mode: info.mode };
  },
  hasExtendedAcl: linuxPathHasExtendedAcl,
  creationMs: async (directory) => {
    const info = await fs.stat(directory, { bigint: true });
    if (info.birthtimeNs > 0n) return Number(info.birthtimeNs / 1_000_000n);
    const marker = await fs.stat(path.join(directory, ".git"), {
      bigint: true,
    });
    return Number(marker.ctimeNs / 1_000_000n);
  },
  subdirectories: async (path) =>
    (await fs.readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
};

let activeProc: ProcReader = hostProc;

export function useProcReaderForTests(reader: ProcReader | null): void {
  activeProc = reader ?? hostProc;
}

export const MAX_TREE_DIRECTORIES = 500_000;
export const MAX_WALK_STEPS = 4096;

type TreeIds = { ids: Set<string> } | { tooLarge: number } | { failed: string };
type TreeIdsReader = () => Promise<TreeIds>;

interface ScanContext {
  final: boolean;
  tree: TreeIdsReader;
  aliases: () => Promise<string[] | null>;
  acls: Map<string, Promise<boolean | null>>;
}

async function listTreeIds(
  proc: ProcReader,
  directory: string,
  limit: number,
): Promise<TreeIds> {
  const ids = new Set<string>();
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop() ?? directory;
    const id = await readOptional(() => proc.lstatId(current));
    if ("gone" in id) continue;
    if ("failed" in id) return { failed: `${current} (${id.failed})` };
    ids.add(id.value);
    if (ids.size > limit) return { tooLarge: ids.size };
    const children = await readOptional(() => proc.subdirectories(current));
    if ("gone" in children) continue;
    if ("failed" in children)
      return { failed: `${current} (${children.failed})` };
    for (const child of children.value) pending.push(path.join(current, child));
  }
  return { ids };
}

interface ProcessResultUnknown {
  unknown: string;
  vouchable: boolean;
}
type ProcessResult =
  | WorktreeHolder
  | ProcessResultUnknown
  | { otherUser: true }
  | { uncertain: string }
  | { cleared: FallbackClearance[] }
  | null;

function unreadable(what: string, failed: string): ProcessResultUnknown {
  return {
    unknown: `${what} (${failed})`,
    vouchable: failed === "EACCES" || failed === "EPERM",
  };
}

function notVouchable(reason: string): ProcessResultUnknown {
  return { unknown: reason, vouchable: false };
}

async function checkLink(
  proc: ProcReader,
  pid: number,
  name: string,
  link: string,
  directory: string,
  through: WorktreeHolder["through"],
  command: string | null,
): Promise<ProcessResult> {
  const target = await readOptional(() => proc.readlink(link));
  if ("failed" in target)
    return unreadable(`process ${pid} ${name}`, target.failed);
  if ("value" in target && isUnder(target.value, directory)) {
    return { pid, command, through };
  }
  return null;
}

interface LinuxProcessIdentity {
  uid: number;
  gids: number[];
}

async function foreignUidCanReachDirectory(
  proc: ProcReader,
  directory: string,
  foreignUid: number,
  foreignGid: number,
  supplementaryGroups: number[] | null,
  context: ScanContext,
): Promise<boolean | null> {
  let cursor = path.resolve(directory);
  while (true) {
    const access = await readOptional(() => proc.statAccess(cursor));
    if (!("value" in access)) return null;
    const accessArgs = {
      processUid: foreignUid,
      processFilesystemGid: foreignGid,
      processSupplementaryGroups: supplementaryGroups,
      directoryUid: access.value.uid,
      directoryGid: access.value.gid,
      mode: access.value.mode,
    };
    let canSearch = linuxDirectoryModeAllowsTraversal(accessArgs);
    if (!canSearch) {
      let acl = context.acls.get(cursor);
      if (acl === undefined) {
        acl = proc.hasExtendedAcl(cursor);
        context.acls.set(cursor, acl);
      }
      canSearch = linuxDirectoryIsTraversable({
        ...accessArgs,
        hasExtendedAcl: await acl,
      });
    }
    if (!canSearch) return false;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return true;
}

function parseStatusNumbers(status: string, key: string): number[] | null {
  for (const line of status.split("\n")) {
    if (!line.startsWith(`${key}:`)) continue;
    const values = line
      .slice(key.length + 1)
      .trim()
      .split(/\s+/u)
      .filter((value) => value !== "");
    const numbers = values.map(Number);
    return numbers.every((value) => Number.isInteger(value)) ? numbers : null;
  }
  return null;
}

async function scanMountAliases(
  proc: ProcReader,
  pid: number,
  directory: string,
  mountNamespace: string,
  context: ScanContext,
): Promise<
  | WorktreeHolder
  | { uncertain: string }
  | { isolated: true }
  | { gone: true }
  | null
> {
  const base = `/proc/${pid}`;
  const status = await readOptional(() => proc.readFile(`${base}/status`));
  if (
    "gone" in status ||
    ("value" in status && /^State:\s+Z/mu.test(status.value))
  )
    return { gone: true };
  const aliases = await context.aliases();
  let doubt: string | null =
    aliases === null ? "worktree mount aliases could not be established" : null;
  const matches = (value: string) =>
    value.startsWith("/") &&
    (aliases ?? [directory]).some((alias) =>
      mountContains(
        value.endsWith(" (deleted)")
          ? value.slice(0, -" (deleted)".length)
          : value,
        alias,
      ),
    );
  const ids = await context.tree();
  let identityDoubt: string | null = null;
  if (!("ids" in ids))
    identityDoubt =
      "tooLarge" in ids
        ? "worktree is too large to scan for directory identities"
        : `worktree directory identities could not be listed (${ids.failed})`;
  else if (ids.ids.size === 0)
    identityDoubt = "worktree directory identities could not be listed";
  const holder = (through: WorktreeHolder["through"]): WorktreeHolder => ({
    pid,
    command: null,
    through,
  });
  const identity = async (
    link: string,
    through: WorktreeHolder["through"],
  ): Promise<WorktreeHolder | { gone: true } | null> => {
    const id = await readOptional(() => proc.statId(link));
    if ("gone" in id) return id;
    if ("failed" in id) identityDoubt = `${link} identity could not be read`;
    else if ("ids" in ids && ids.ids.has(id.value)) return holder(through);
    return null;
  };
  const link = async (
    target: string,
    through: WorktreeHolder["through"],
    stat: boolean,
  ): Promise<WorktreeHolder | { gone: true } | null> => {
    const value = await readOptional(() => proc.readlink(target));
    if ("value" in value && matches(value.value)) return holder(through);
    if ("gone" in value) return value;
    const found = stat ? await identity(target, through) : null;
    if (found !== null && "gone" in found) return found;
    if ("failed" in value) doubt = `${target} could not be read`;
    return found;
  };
  for (const [leaf, through, stat] of [
    ["cwd", "working folder", true],
    ["exe", "open file", false],
  ] as const) {
    const found = await link(`${base}/${leaf}`, through, stat);
    if (found !== null && !("gone" in found)) return found;
  }
  let sharedMaps = false;
  const mappings = async (
    fileBase: string,
    identities: boolean,
  ): Promise<
    WorktreeHolder | { gone: true } | { failed: string } | { shared: boolean }
  > => {
    const mappedEntries = identities
      ? await readOptional(() => proc.readdir(`${fileBase}/map_files`))
      : { gone: true as const };
    if ("value" in mappedEntries)
      for (const entry of mappedEntries.value) {
        const id = await readOptional(() =>
          proc.statId(`${fileBase}/map_files/${entry}`),
        );
        if ("value" in id && "ids" in ids && ids.ids.has(id.value))
          return holder("mapped file");
        if ("failed" in id && id.failed === "EPERM") break;
      }
    const maps = await readOptional(() => proc.readFile(`${fileBase}/maps`));
    if ("gone" in maps) return maps;
    if ("failed" in maps)
      return { failed: `${fileBase}/maps could not be read` };
    for (const line of maps.value.split("\n"))
      if (matches(mappedPath(line))) return holder("mapped file");
    return { shared: maps.value.trim() !== "" };
  };
  const files = async (
    fileBase: string,
  ): Promise<
    WorktreeHolder | { uncertain: string } | { gone: true } | null
  > => {
    let fileDoubt: string | null = null;
    const entries = await readOptional(() => proc.readdir(`${fileBase}/fd`));
    if ("gone" in entries) return entries;
    if ("failed" in entries) fileDoubt = `${fileBase}/fd could not be read`;
    const inspectFd = async (entry: string) => {
      const target = `${fileBase}/fd/${entry}`;
      const value = await readOptional(() => proc.readlink(target));
      if ("value" in value && matches(value.value)) return holder("open file");
      if ("gone" in value) return value;
      if ("value" in value && PSEUDO_FILE_LINK.test(value.value)) return null;
      const found = await identity(target, "open file");
      if (found !== null && "gone" in found) return null;
      if ("failed" in value) fileDoubt = `${target} could not be read`;
      return found;
    };
    const pending = new Set<string>();
    if ("value" in entries)
      for (const entry of entries.value) {
        const found = await inspectFd(entry);
        if (found !== null && "gone" in found) {
          if (context.final) pending.add(entry);
        } else if (found !== null) return found;
      }
    const memory = sharedMaps ? null : await mappings(fileBase, true);
    if (memory !== null && ("gone" in memory || "pid" in memory))
      return memory;
    if (memory !== null && "failed" in memory) fileDoubt = memory.failed;
    if (fileBase === base && memory !== null && "shared" in memory)
      sharedMaps = memory.shared;
    for (let pass = 0; pass < 3 && pending.size > 0; pass++) {
      const current = await readOptional(() => proc.readdir(`${fileBase}/fd`));
      if ("gone" in current) return current;
      if ("failed" in current)
        return { uncertain: `${fileBase}/fd could not be re-listed` };
      const remaining = new Set(current.value);
      for (const entry of pending) {
        if (!remaining.has(entry)) {
          pending.delete(entry);
          continue;
        }
        const found = await inspectFd(entry);
        if (found !== null && "gone" in found) continue;
        pending.delete(entry);
        if (found !== null) return found;
      }
    }
    if (pending.size > 0)
      fileDoubt = `${fileBase}/fd is still changing after 3 rechecks`;
    return fileDoubt === null ? null : { uncertain: fileDoubt };
  };
  const beforeLeaderFiles = identityDoubt;
  const leaderFiles = await files(base);
  if (leaderFiles !== null) {
    if ("pid" in leaderFiles) return leaderFiles;
    if ("gone" in leaderFiles) identityDoubt = beforeLeaderFiles;
    else doubt = leaderFiles.uncertain;
  }
  const namespace = await readOptional(() => proc.readlink(`${base}/ns/mnt`));
  if ("failed" in namespace)
    doubt = `${base} mount namespace could not be read`;
  const tasks = await readOptional(() => proc.readdir(`${base}/task`));
  if ("failed" in tasks) identityDoubt = `${base}/task could not be read`;
  if ("value" in tasks)
    for (const task of tasks.value) {
      if (task === String(pid)) continue;
      const taskBase = `${base}/task/${task}`;
      const beforeTask = { doubt, identityDoubt };
      const found = await link(`${taskBase}/cwd`, "working folder", true);
      if (found !== null) {
        if ("gone" in found) continue;
        return found;
      }
      const taskFiles = await files(taskBase);
      if (taskFiles !== null) {
        if ("pid" in taskFiles) return taskFiles;
        if ("gone" in taskFiles) {
          doubt = beforeTask.doubt;
          identityDoubt = beforeTask.identityDoubt;
          continue;
        }
      }
      const taskNamespace = await readOptional(() =>
        proc.readlink(`${taskBase}/ns/mnt`),
      );
      if ("gone" in taskNamespace) {
        doubt = beforeTask.doubt;
        identityDoubt = beforeTask.identityDoubt;
        continue;
      }
      if ("failed" in taskNamespace)
        identityDoubt = `${taskBase} mount namespace could not be read`;
      if (
        taskFiles !== null &&
        "uncertain" in taskFiles &&
        "value" in taskNamespace
      ) {
        if (taskNamespace.value === mountNamespace)
          identityDoubt = taskFiles.uncertain;
        else if (
          "value" in namespace &&
          taskNamespace.value === namespace.value
        )
          doubt = taskFiles.uncertain;
      }
      if (
        "value" in taskNamespace &&
        taskNamespace.value !== mountNamespace &&
        (!("value" in namespace) || taskNamespace.value !== namespace.value) &&
        !(await foreignMountsExcludeWorktree(
          proc,
          taskBase,
          directory,
          mountNamespace,
        ))
      )
        identityDoubt = `${taskBase} mount isolation could not be proven`;
    }
  if (sharedMaps) {
    const late = await mappings(base, false);
    if ("pid" in late) return late;
    if (!("shared" in late) || !late.shared)
      for (const task of "value" in tasks ? tasks.value : []) {
        const taskMaps = await mappings(`${base}/task/${task}`, true);
        if ("pid" in taskMaps) return taskMaps;
        if ("failed" in taskMaps) identityDoubt = taskMaps.failed;
      }
  }
  if (
    identityDoubt === null &&
    "value" in namespace &&
    namespace.value !== mountNamespace
  ) {
    if (
      await foreignMountsExcludeWorktree(proc, base, directory, mountNamespace)
    )
      return { isolated: true };
    doubt = `process ${pid} runs in another mount namespace without proven mount isolation`;
  }
  const current = await readOptional(() => proc.readFile(`${base}/status`));
  if ("gone" in current) return current;
  const reason = identityDoubt ?? doubt;
  if (reason !== null) {
    return { uncertain: `process ${pid}: ${reason}` };
  }
  return null;
}

async function scanLinuxProcess(
  proc: ProcReader,
  pid: number,
  directory: string,
  mountNamespace: string,
  self: LinuxProcessIdentity,
  context: ScanContext,
): Promise<ProcessResult> {
  const result = await scanLinuxPaths(
    proc,
    pid,
    directory,
    mountNamespace,
    self,
    context,
  );
  if (result !== null && ("pid" in result || "otherUser" in result))
    return result;
  const safety = await scanMountAliases(
    proc,
    pid,
    directory,
    mountNamespace,
    context,
  );
  if (safety !== null && "gone" in safety) return null;
  if (safety !== null && "pid" in safety) return safety;
  if (result !== null && "uncertain" in result) return result;
  if (safety !== null && "uncertain" in safety)
    return result !== null && "unknown" in result ? result : safety;
  if (safety !== null && "isolated" in safety)
    return result !== null && "cleared" in result ? result : null;
  return result;
}

async function scanLinuxPaths(
  proc: ProcReader,
  pid: number,
  directory: string,
  mountNamespace: string,
  self: LinuxProcessIdentity,
  context: ScanContext,
): Promise<ProcessResult> {
  const base = `/proc/${pid}`;
  const status = await readOptional(() => proc.readFile(`${base}/status`));
  if ("gone" in status) return null;
  if ("failed" in status)
    return unreadable(`process ${pid} status`, status.failed);
  const uids = parseStatusNumbers(status.value, "Uid");
  const gids = parseStatusNumbers(status.value, "Gid");
  const supplementaryGroups = parseLinuxSupplementaryGroups(status.value);
  if (uids === null || uids[3] === undefined)
    return notVouchable(`process ${pid} owner could not be read`);
  if (gids === null || gids[3] === undefined)
    return notVouchable(`process ${pid} group owner could not be read`);
  if (/^State:\s+Z/mu.test(status.value)) return null;
  if (uids[3] !== self.uid) {
    const foreignUid = uids[3];
    if (foreignUid === undefined || (foreignUid < 1000 && self.uid !== 0))
      return { otherUser: true };
    if (self.uid !== 0) {
      let uninspectable = false;
      for (const [leaf, through] of [
        ["cwd", "working folder"],
        ["exe", "open file"],
      ] as const) {
        const target = await readOptional(() =>
          proc.readlink(`${base}/${leaf}`),
        );
        if ("value" in target && isUnder(target.value, directory))
          return { pid, command: null, through };
        if ("failed" in target) uninspectable = true;
      }
      const fds = await readOptional(() => proc.readdir(`${base}/fd`));
      if ("failed" in fds) uninspectable = true;
      if ("value" in fds) {
        for (const fd of fds.value) {
          const target = await readOptional(() =>
            proc.readlink(`${base}/fd/${fd}`),
          );
          if ("value" in target && isUnder(target.value, directory))
            return { pid, command: null, through: "open file" };
          if ("failed" in target) uninspectable = true;
        }
      }
      const maps = await readOptional(() => proc.readFile(`${base}/maps`));
      if ("failed" in maps) uninspectable = true;
      if ("value" in maps) {
        for (const line of maps.value.split("\n"))
          if (isUnder(mappedPath(line), directory))
            return { pid, command: null, through: "mapped file" };
      }
      const command = await readOptional(() =>
        proc.readFile(`${base}/cmdline`),
      );
      const references = (value: string) => {
        let offset = value.indexOf(directory);
        while (offset >= 0) {
          const before = value[offset - 1];
          const after = value[offset + directory.length];
          if (
            (before === undefined || /[\s\0="':]/u.test(before)) &&
            (after === undefined || /[\s\0/']/u.test(after))
          )
            return true;
          offset = value.indexOf(directory, offset + 1);
        }
        return false;
      };
      if ("value" in command && references(command.value))
        return {
          uncertain: `process ${pid} foreign uid ${foreignUid} command references the worktree`,
        };
      let parent = parseStatusNumbers(status.value, "PPid")?.[0];
      for (
        let depth = 0;
        parent !== undefined && parent > 1 && depth < 64;
        depth++
      ) {
        const parentBase = `/proc/${parent}`;
        const parentCommand = await readOptional(() =>
          proc.readFile(`${parentBase}/cmdline`),
        );
        if ("value" in parentCommand && references(parentCommand.value))
          return {
            uncertain: `process ${pid} descends from a worktree process`,
          };
        const parentCwd = await readOptional(() =>
          proc.readlink(`${parentBase}/cwd`),
        );
        if ("value" in parentCwd && isUnder(parentCwd.value, directory))
          return {
            uncertain: `process ${pid} descends from a worktree process`,
          };
        const parentExe = await readOptional(() =>
          proc.readlink(`${parentBase}/exe`),
        );
        if ("value" in parentExe && isUnder(parentExe.value, directory))
          return {
            uncertain: `process ${pid} descends from a worktree process`,
          };
        const parentFds = await readOptional(() =>
          proc.readdir(`${parentBase}/fd`),
        );
        if ("value" in parentFds) {
          for (const fd of parentFds.value) {
            const target = await readOptional(() =>
              proc.readlink(`${parentBase}/fd/${fd}`),
            );
            if ("value" in target && isUnder(target.value, directory))
              return {
                uncertain: `process ${pid} descends from a worktree process`,
              };
          }
        }
        const parentStatus = await readOptional(() =>
          proc.readFile(`${parentBase}/status`),
        );
        if (!("value" in parentStatus)) break;
        parent = parseStatusNumbers(parentStatus.value, "PPid")?.[0];
      }

      if (!uninspectable) return null;
      if (
        await foreignMountsExcludeWorktree(
          proc,
          base,
          directory,
          mountNamespace,
        )
      )
        return null;
      return {
        uncertain: `process ${pid} foreign uid ${foreignUid} could not be inspected or proven unrelated`,
      };
    }
    const cwd = await readOptional(() => proc.readlink(`${base}/cwd`));
    if ("value" in cwd) {
      if (isUnder(cwd.value, directory))
        return { pid, command: null, through: "working folder" };
    }
    if ("gone" in cwd) return null;
    if (!("failed" in cwd)) {
      if (self.uid !== 0) return null;
    } else {
      if (cwd.failed !== "EACCES" && cwd.failed !== "EPERM") {
        return {
          uncertain: `process ${pid} cwd is unreadable (${cwd.failed})`,
        };
      }
      const capabilities = /^CapEff:\s*([0-9a-f]+)/imu.exec(status.value)?.[1];
      if (capabilities === undefined) {
        return {
          uncertain: `process ${pid} cwd capabilities could not be read`,
        };
      }
      const effectiveCapabilities = BigInt(`0x${capabilities}`);
      const dacCapabilities = (1n << 1n) | (1n << 2n);
      if ((effectiveCapabilities & dacCapabilities) !== 0n) {
        return {
          uncertain: `process ${pid} has a DAC override capability and its cwd is unreadable`,
        };
      }
      const reachable = await foreignUidCanReachDirectory(
        proc,
        directory,
        foreignUid,
        gids[3],
        supplementaryGroups,
        context,
      );
      if (reachable === false) {
        return {
          uncertain: `process ${pid} cwd is unreadable for foreign uid ${foreignUid}`,
        };
      }
      if (reachable === null)
        return {
          uncertain: `process ${pid} cwd reachability could not be determined`,
        };
      return {
        uncertain: `process ${pid} cwd is unreadable for foreign uid ${foreignUid}`,
      };
    }
  }

  const comm = await readOptional(() => proc.readFile(`${base}/comm`));
  const command = "value" in comm ? comm.value.trim() || null : null;
  let result = await scanOwnProcess(
    proc,
    pid,
    base,
    directory,
    mountNamespace,
    command,
    context.tree,
  );
  for (
    let attempt = 0;
    attempt < PERMISSION_RETRIES &&
    result !== null &&
    "unknown" in result &&
    result.vouchable;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, PERMISSION_RETRY_MS));
    result = await scanOwnProcess(
      proc,
      pid,
      base,
      directory,
      mountNamespace,
      command,
      context.tree,
    );
  }
  const credentialsDiffer =
    uids[0] !== uids[3] ||
    uids[1] !== uids[3] ||
    uids[3] !== self.uid ||
    gids[0] !== gids[3] ||
    gids[1] !== gids[3];
  if (credentialsDiffer && result === null) {
    return {
      unknown: `process ${pid} has unreadable holder paths and credentials differ from its filesystem UID`,
      vouchable: false,
    };
  }
  if (result === null || !("unknown" in result) || !result.vouchable)
    return result;
  if (credentialsDiffer) {
    return {
      unknown: `${result.unknown}, process credentials differ from its filesystem UID`,
      vouchable: false,
    };
  }
  if (!UNREADABLE_SESSION_AGENT_COMMS.has(command ?? "")) {
    return {
      unknown: `process ${pid} (${command ?? "unknown"}) has an unreadable holder path`,
      vouchable: false,
    };
  }
  return null;
}
interface ForeignTarget {
  what: string;
  through: WorktreeHolder["through"];
  path: string;
  magic: string | null;
  identity?: string;
}

async function foreignTargets(
  proc: ProcReader,
  pid: number,
  base: string,
): Promise<{ targets: ForeignTarget[] } | { stop: ProcessResult }> {
  const targets: ForeignTarget[] = [
    { what: "root folder", through: "working folder", path: "/", magic: null },
  ];
  const link = async (
    what: string,
    through: WorktreeHolder["through"],
    path: string,
  ): Promise<ProcessResult> => {
    const target = await readOptional(() => proc.readlink(path));
    if ("gone" in target) return null;
    if ("failed" in target)
      return unreadable(`process ${pid} ${what}`, target.failed);
    targets.push({ what, through, path: target.value, magic: path });
    return null;
  };
  const tasks = await readOptional(() => proc.readdir(`${base}/task`));
  if ("gone" in tasks) return { stop: null };
  if ("failed" in tasks)
    return { stop: unreadable(`process ${pid} tasks`, tasks.failed) };
  for (const task of tasks.value) {
    const failed = await link(
      "working folder",
      "working folder",
      `${base}/task/${task}/cwd`,
    );
    if (failed !== null) return { stop: failed };
  }
  const exe = await link("program", "open file", `${base}/exe`);
  if (exe !== null) return { stop: exe };
  const descriptors = await readOptional(() => proc.readdir(`${base}/fd`));
  if ("gone" in descriptors) return { stop: null };
  if ("failed" in descriptors)
    return {
      stop: unreadable(`process ${pid} open files`, descriptors.failed),
    };
  for (const descriptor of descriptors.value) {
    const failed = await link(
      "open file",
      "open file",
      `${base}/fd/${descriptor}`,
    );
    if (failed !== null) return { stop: failed };
  }
  const maps = await readOptional(() => proc.readFile(`${base}/maps`));
  if ("gone" in maps) return { stop: null };
  if ("failed" in maps)
    return { stop: unreadable(`process ${pid} memory maps`, maps.failed) };
  const mapped = new Set<string>();
  for (const line of maps.value.split("\n")) {
    const fields = line.split(/\s+/u);
    const file = fields.slice(5).join(" ");
    if (file !== "" && !file.startsWith("[") && !mapped.has(file)) {
      mapped.add(file);
      targets.push({
        what: "memory maps",
        through: "mapped file",
        path: file,
        magic: `${base}/maps:${fields[0] ?? ""}`,
        ...identityOfMapsLine(fields[3] ?? "", fields[4] ?? ""),
      });
    }
  }
  return { targets };
}

function identityOfMapsLine(
  device: string,
  inode: string,
): { identity?: string } {
  const parts = device.split(":");
  const [majorText, minorText] = parts;
  if (
    parts.length !== 2 ||
    !/^[0-9a-f]{1,8}$/iu.test(majorText ?? "") ||
    !/^[0-9a-f]{1,8}$/iu.test(minorText ?? "")
  )
    return {};
  const major = Number.parseInt(majorText ?? "", 16);
  const minor = Number.parseInt(minorText ?? "", 16);
  if (!/^[1-9]\d*$/u.test(inode)) return {};
  const encoded =
    ((BigInt(major) & 0xfffn) << 8n) |
    (BigInt(minor) & 0xffn) |
    ((BigInt(minor) & ~0xffn) << 12n) |
    ((BigInt(major) & ~0xfffn) << 32n);
  return { identity: `${encoded}:${inode}` };
}

async function placeByIdentity(
  proc: ProcReader,
  pid: number,
  target: ForeignTarget,
  worktreeIds: Set<string>,
  command: string | null,
): Promise<ProcessResult> {
  const where = `process ${pid} runs in another mount namespace and its ${target.what} ${target.path} cannot be found from its root`;
  if (target.magic === null) return notVouchable(where);
  const actual =
    target.identity !== undefined
      ? { value: target.identity }
      : await readOptional(() => proc.statId(target.magic ?? ""));
  if ("gone" in actual)
    return notVouchable(`${where}, and its file cannot be identified`);
  if ("failed" in actual)
    return unreadable(
      `${where}, and its file cannot be identified`,
      actual.failed,
    );
  const ours = await readOptional(() => proc.statId(target.path));
  if ("gone" in ours)
    return notVouchable(
      `${where}, and the same path is not in this view either`,
    );
  if ("failed" in ours)
    return unreadable(`${where}, and the same path in this view`, ours.failed);
  if (ours.value !== actual.value)
    return notVouchable(
      `${where}, and the same path in this view is a different file`,
    );
  let current = target.path;
  for (let steps = 0; ; steps += 1) {
    if (steps > MAX_WALK_STEPS)
      return notVouchable(
        `${where}, and its path has too many parts to follow`,
      );
    const id = await readOptional(() => proc.lstatId(current));
    if ("gone" in id)
      return notVouchable(
        `${where}, and ${current} cannot be found in this view`,
      );
    if ("failed" in id)
      return unreadable(`${where}, ${current} in this view`, id.failed);
    if (worktreeIds.has(id.value))
      return { pid, command, through: target.through };
    if (current === "/")
      return {
        cleared: [
          {
            pid,
            link: target.magic,
            path: target.path,
            identity: actual.value,
          },
        ],
      };
    current = path.posix.dirname(current);
  }
}

async function reachesWorktree(
  proc: ProcReader,
  pid: number,
  base: string,
  command: string | null,
  tree: TreeIdsReader,
): Promise<ProcessResult> {
  const where = `process ${pid} runs in another mount namespace`;
  const ids = await tree();
  if ("tooLarge" in ids)
    return notVouchable(
      `${where} and the folder is too large to scan (more than ${MAX_TREE_DIRECTORIES} directories)`,
    );
  if ("failed" in ids)
    return notVouchable(
      `${where} and the folder could not be listed (${ids.failed})`,
    );
  const found = await foreignTargets(proc, pid, base);
  if ("stop" in found) return found.stop;
  const outside = new Set<string>();
  const clearances: FallbackClearance[] = [];
  for (const target of found.targets) {
    if (!target.path.startsWith("/")) continue;
    if (target.path.endsWith(" (deleted)"))
      return notVouchable(
        `${where} and its ${target.what} ${target.path} was deleted, so it cannot be placed`,
      );
    const walked: string[] = [];
    let current = target.path;
    for (let steps = 0; ; steps += 1) {
      if (steps > MAX_WALK_STEPS)
        return notVouchable(
          `${where} and the path of its ${target.what} has too many parts to follow`,
        );
      if (outside.has(current)) break;
      const id = await readOptional(() =>
        proc.lstatId(`/proc/${pid}/root${current}`),
      );
      if ("gone" in id) {
        if (steps !== 0 || target.magic === null)
          return notVouchable(
            `${where} and its ${target.what} ${current} cannot be found from its root`,
          );
        const placed = await placeByIdentity(
          proc,
          pid,
          target,
          ids.ids,
          command,
        );
        if (placed === null || !("cleared" in placed)) return placed;
        clearances.push(...placed.cleared);
        break;
      }
      if ("failed" in id)
        return unreadable(`${where}, its ${target.what} ${current}`, id.failed);
      if (ids.ids.has(id.value))
        return { pid, command, through: target.through };
      walked.push(current);
      if (current === "/") break;
      current = path.posix.dirname(current);
    }
    for (const done of walked) outside.add(done);
  }
  return clearances.length > 0 ? { cleared: clearances } : null;
}

async function scanOwnProcess(
  proc: ProcReader,
  pid: number,
  base: string,
  directory: string,
  mountNamespace: string,
  command: string | null,
  tree: TreeIdsReader,
): Promise<ProcessResult> {
  const mount = await readOptional(() => proc.readlink(`${base}/ns/mnt`));
  if ("gone" in mount) return null;
  if ("failed" in mount)
    return unreadable(`process ${pid} mount namespace`, mount.failed);
  if (mount.value !== mountNamespace)
    return reachesWorktree(proc, pid, base, command, tree);
  const root = await readOptional(() => proc.readlink(`${base}/root`));
  if ("gone" in root) return null;
  if ("failed" in root)
    return unreadable(`process ${pid} root folder`, root.failed);
  if (root.value !== "/")
    return notVouchable(`process ${pid} runs under a different root folder`);

  const tasks = await readOptional(() => proc.readdir(`${base}/task`));
  if ("gone" in tasks) return null;
  if ("failed" in tasks)
    return unreadable(`process ${pid} tasks`, tasks.failed);
  for (const task of tasks.value) {
    const taskMount = await readOptional(() =>
      proc.readlink(`${base}/task/${task}/ns/mnt`),
    );
    if ("failed" in taskMount)
      return unreadable(
        `process ${pid} thread ${task} mount namespace`,
        taskMount.failed,
      );
    if ("value" in taskMount && taskMount.value !== mountNamespace)
      return reachesWorktree(proc, pid, base, command, tree);
    const found = await checkLink(
      proc,
      pid,
      "working folder",
      `${base}/task/${task}/cwd`,
      directory,
      "working folder",
      command,
    );
    if (found !== null) return found;
  }

  const exe = await checkLink(
    proc,
    pid,
    "program",
    `${base}/exe`,
    directory,
    "open file",
    command,
  );
  if (exe !== null) return exe;

  const descriptors = await readOptional(() => proc.readdir(`${base}/fd`));
  if ("gone" in descriptors) return null;
  if ("failed" in descriptors)
    return unreadable(`process ${pid} open files`, descriptors.failed);
  for (const descriptor of descriptors.value) {
    const found = await checkLink(
      proc,
      pid,
      "open file",
      `${base}/fd/${descriptor}`,
      directory,
      "open file",
      command,
    );
    if (found !== null) return found;
  }

  const maps = await readOptional(() => proc.readFile(`${base}/maps`));
  if ("gone" in maps) return null;
  if ("failed" in maps)
    return unreadable(`process ${pid} memory maps`, maps.failed);
  for (const line of maps.value.split("\n")) {
    if (isUnder(mappedPath(line), directory)) {
      return { pid, command, through: "mapped file" };
    }
  }
  return null;
}

interface LinuxVisibility {
  problem: string | null;
  mountNamespace: string;
  self: LinuxProcessIdentity;
}

const NO_IDENTITY: LinuxProcessIdentity = { uid: -1, gids: [] };

export async function linuxVisibilityProblem(
  proc: ProcReader = hostProc,
): Promise<LinuxVisibility> {
  const status = await readOptional(() => proc.readFile("/proc/self/status"));
  if (!("value" in status)) {
    return {
      problem: "the process list settings are unreadable",
      mountNamespace: "",
      self: NO_IDENTITY,
    };
  }
  const nspid = parseStatusNumbers(status.value, "NSpid");
  const uids = parseStatusNumbers(status.value, "Uid");
  const gids = parseStatusNumbers(status.value, "Groups") ?? [];
  const gid = parseStatusNumbers(status.value, "Gid");
  const self: LinuxProcessIdentity = {
    uid: uids?.[3] ?? -1,
    gids: [...gids, ...(gid ?? [])],
  };
  if (nspid === null || self.uid < 0) {
    return {
      problem: "this process cannot tell which process namespace it is in",
      mountNamespace: "",
      self,
    };
  }
  if (nspid.length !== 1) {
    return {
      problem:
        "this process may not see every process (it runs in a nested process namespace)",
      mountNamespace: "",
      self,
    };
  }
  const ownMount = await readOptional(() => proc.readlink("/proc/self/ns/mnt"));
  if (!("value" in ownMount)) {
    return {
      problem: "this process cannot tell which mount namespace it is in",
      mountNamespace: "",
      self,
    };
  }
  const ownRoot = await readOptional(() => proc.readlink("/proc/self/root"));
  if (!("value" in ownRoot) || ownRoot.value !== "/") {
    return {
      problem: "this process runs under a different root folder",
      mountNamespace: ownMount.value,
      self,
    };
  }
  const mounts = await readOptional(() =>
    proc.readFile("/proc/self/mountinfo"),
  );
  if (!("value" in mounts)) {
    return {
      problem: "the process mount information is unreadable",
      mountNamespace: ownMount.value,
      self,
    };
  }
  for (const line of mounts.value.split("\n")) {
    const fields = line.split(" ");
    if (fields[4] !== "/proc") continue;
    const options = line.slice(line.indexOf(" - ") + 3);
    const hidepid = /hidepid=([^,\s]+)/u.exec(options);
    if (hidepid === null || hidepid[1] === "0" || hidepid[1] === "off")
      continue;
    const group = /gid=(\d+)/u.exec(options);
    if (group !== null && self.gids.includes(Number(group[1]))) continue;
    return {
      problem: "the process list is hidden from this user",
      mountNamespace: ownMount.value,
      self,
    };
  }
  return { problem: null, mountNamespace: ownMount.value, self };
}

export async function scanLinux(
  directory: string,
  proc: ProcReader = hostProc,
  ownPid: number = process.pid,
  limits: { maxDirectories: number; final?: boolean } = {
    maxDirectories: MAX_TREE_DIRECTORIES,
  },
): Promise<WorktreeHolderScan> {
  const visibility = await linuxVisibilityProblem(proc);
  if (visibility.problem !== null) {
    return {
      status:
        visibility.problem === "the process mount information is unreadable"
          ? "uncertain"
          : "unknown",
      reason: visibility.problem,
    };
  }
  const listing = await readOptional(() => proc.readdir("/proc"));
  if (!("value" in listing)) {
    return { status: "unknown", reason: "the process list is unreadable" };
  }
  const pids = listing.value
    .filter((entry) => /^\d+$/u.test(entry))
    .map(Number)
    .filter((pid) => pid !== ownPid);
  const holders: WorktreeHolder[] = [];
  const unknown: string[] = [];
  const uncertain: string[] = [];
  const clearances: FallbackClearance[] = [];
  let listed: Promise<TreeIds> | null = null;
  const tree: TreeIdsReader = () => {
    listed ??= listTreeIds(proc, directory, limits.maxDirectories);
    return listed;
  };
  let aliases: Promise<string[] | null> | null = null;
  const context: ScanContext = {
    final: limits.final === true,
    tree,
    aliases: () => {
      aliases ??= worktreeAliases(proc, directory);
      return aliases;
    },
    acls: new Map(),
  };
  for (let offset = 0; offset < pids.length; offset += LINUX_SCAN_CONCURRENCY) {
    if (offset > 0) await new Promise((resolve) => setImmediate(resolve));
    const batch = pids.slice(offset, offset + LINUX_SCAN_CONCURRENCY);
    const results = await Promise.all(
      batch.map((pid) =>
        scanLinuxProcess(
          proc,
          pid,
          directory,
          visibility.mountNamespace,
          visibility.self,
          context,
        ),
      ),
    );
    for (const result of results) {
      if (result === null) continue;
      if ("cleared" in result) {
        clearances.push(...result.cleared);
        continue;
      }
      if ("otherUser" in result) continue;
      if ("uncertain" in result) {
        uncertain.push(result.uncertain);
        continue;
      }
      if ("unknown" in result) {
        unknown.push(result.unknown);
        continue;
      }
      holders.push(result);
    }
  }
  if (holders.length > 0) return { status: "held", holders };
  if (uncertain.length > 0) {
    return {
      status: "uncertain",
      reason: `${uncertain.length} processes could not be inspected or proven unrelated, such as ${uncertain[0]}`,
    };
  }
  if (unknown.length > 0) {
    return {
      status: "unknown",
      reason: `${unknown.length} processes could not be inspected, such as ${unknown[0]}`,
    };
  }
  return clearances.length > 0
    ? {
        status: "clear",
        ...(clearances.length > 0 ? { clearances } : {}),
      }
    : { status: "clear" };
}

function runLsof(directory: string): Promise<LsofResult> {
  return new Promise((resolve) => {
    execFile(
      "lsof",
      ["-n", "-F", "pcn", "+D", directory],
      { timeout: LSOF_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr, spawnFailed: false });
          return;
        }
        resolve(
          mapLsofError(
            error,
            typeof stdout === "string" ? stdout : "",
            typeof stderr === "string" ? stderr : "",
          ),
        );
      },
    );
  });
}

let activeLsof: (directory: string) => Promise<LsofResult> = runLsof;

export function useLsofRunnerForTests(
  runner: ((directory: string) => Promise<LsofResult>) | null,
): void {
  activeLsof = runner ?? runLsof;
}

async function scanWithLsof(directory: string): Promise<WorktreeHolderScan> {
  const result = await activeLsof(directory);
  if (result.spawnFailed) {
    const args = `-n -F pcn +D ${directory}`;
    const detail = result.stderr.split("\n", 1)[0];
    const reason =
      result.failure === "timeout"
        ? `lsof timed out after ${LSOF_TIMEOUT_MS / 1000}s (${args})`
        : result.failure === "maxBuffer"
          ? `lsof exceeded its output limit (${args})`
          : result.failure === "signal"
            ? `lsof terminated by signal (${args})`
            : `lsof failed to start (${args})`;
    const exit =
      result.code === null
        ? result.signal
          ? `; signal ${result.signal}`
          : ""
        : `; exit ${result.code}`;
    return {
      status: "unknown",
      reason: `${reason}${exit}${detail ? `; ${detail}` : ""}`,
    };
  }
  const holders = new Map<number, WorktreeHolder>();
  let pid: number | null = null;
  let command: string | null = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      command = null;
    } else if (line.startsWith("c")) {
      command = line.slice(1) || null;
    } else if (line.startsWith("n") && pid !== null && pid !== process.pid) {
      if (!holders.has(pid)) {
        holders.set(pid, {
          pid,
          command,
          through: isUnder(line.slice(1), directory)
            ? "open file"
            : "working folder",
        });
      }
    }
  }
  if (holders.size > 0)
    return { status: "held", holders: [...holders.values()] };
  if ((result.code === 0 || result.code === 1) && result.stderr.trim() === "")
    return { status: "clear" };
  return {
    status: "unknown",
    reason: `lsof exited with ${result.code ?? "a signal"}`,
  };
}

export async function scanWorktreeHolders(
  directory: string,
  options: { final?: boolean } = {},
): Promise<WorktreeHolderScan> {
  if (process.platform === "linux")
    return scanLinux(directory, activeProc, process.pid, {
      maxDirectories: MAX_TREE_DIRECTORIES,
      final: options.final === true,
    });
  if (process.platform === "win32") {
    return {
      status: "unknown",
      reason: "this platform cannot list the programs using a folder",
    };
  }
  return scanWithLsof(directory);
}

export function describeHolderScan(scan: WorktreeHolderScan): string | null {
  if (scan.status === "clear") return null;
  if (scan.status === "uncertain") {
    return `could not determine which programs are using it (${scan.reason}), so it was kept`;
  }
  if (scan.status === "unknown") {
    return `could not check which programs are using it (${scan.reason}), so it was kept`;
  }
  const shown = scan.holders
    .slice(0, 5)
    .map(
      (holder) =>
        `${holder.command ?? "a process"} (pid ${holder.pid}, ${holder.through})`,
    )
    .join(", ");
  const more =
    scan.holders.length > 5 ? `, and ${scan.holders.length - 5} more` : "";
  return `is in use by ${shown}${more}; bb does not stop other programs, so ask whoever runs them to finish and close them`;
}
