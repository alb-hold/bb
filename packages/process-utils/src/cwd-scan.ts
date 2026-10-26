import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { resolveSweepDirectory } from "./cwd-processes.js";
import { spawnPortableOutputProcess } from "./spawn.js";

export interface CwdHolder {
  pid: number;
  cwd: string;
}

export interface CwdUnvouchedHelper {
  pid: number;
  comm: string;
}

export interface CwdSkippedProcess {
  pid: number;
  uid: number;
  errno: string;
}

export interface CwdScanCoverage {
  excludedOtherUsers: number | null;
  skippedOtherUsers?: CwdSkippedProcess[];
  unvouchedHelpers: CwdUnvouchedHelper[] | null;
}

export const UNREADABLE_SAME_USER_HELPER_COMMS: ReadonlySet<string> = new Set([
  "systemd",
  "(sd-pam)",
  "ssh-agent",
  "sshd",
  "sshd-session",
  "gpg-agent",
  "dbus-daemon",
]);

export type CwdHolderScan =
  | ({ status: "clear" } & CwdScanCoverage)
  | ({ status: "held"; holders: CwdHolder[] } & CwdScanCoverage)
  | { status: "unknown"; reason: string };

export interface CwdScanIo {
  platform: NodeJS.Platform;
  uid: number | null;
  selfPid: number;
  listProcessIds(): Promise<string[]>;
  readCwd(pid: number): Promise<string>;
  effectiveUid(pid: number): Promise<number>;
  readComm(pid: number): Promise<string>;
  runLsof(
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
  runPs?(
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
  delay?(ms: number): Promise<void>;
}

export const PS_ARGS: readonly string[] = ["-A", "-o", "pid=,uid=,comm="];
const MAC_RETRY_MS = 200;

export function parseEffectiveUid(status: string): number {
  const line = /^Uid:\t(\d+)\t(\d+)\t/mu.exec(status);
  if (line === null)
    throw Object.assign(new Error("no Uid line"), { code: "EINVAL" });
  return Number(line[2]);
}

const GONE = new Set(["ENOENT", "ESRCH", "ENOTDIR"]);

function codeOf(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "";
}

function isUnder(candidate: string, directory: string): boolean {
  const normalized = candidate.endsWith(" (deleted)")
    ? candidate.slice(0, -" (deleted)".length)
    : candidate;
  return normalized === directory || normalized.startsWith(`${directory}/`);
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnPortableOutputProcess({ command, args });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const errChunks: Buffer[] = [];
    child.stderr.on("data", (chunk) => errChunks.push(Buffer.from(chunk)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
      });
    });
  });
}

export const hostCwdScanIo: CwdScanIo = {
  platform: process.platform,
  uid: typeof process.geteuid === "function" ? process.geteuid() : null,
  selfPid: process.pid,
  listProcessIds: () => readdir("/proc"),
  readCwd: (pid) => readlink(`/proc/${pid}/cwd`),
  effectiveUid: async (pid) =>
    parseEffectiveUid(await readFile(`/proc/${pid}/status`, "utf8")),
  readComm: async (pid) => {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const open = text.indexOf("(");
    const close = text.lastIndexOf(")");
    if (open === -1 || close <= open)
      throw Object.assign(new Error("unparsable stat"), { code: "EINVAL" });
    return text.slice(open + 1, close);
  },
  runPs: (timeoutMs) => runCommand("ps", [...PS_ARGS], timeoutMs),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  runLsof: (timeoutMs) =>
    new Promise((resolve, reject) => {
      const child = spawnPortableOutputProcess({
        command: "lsof",
        args: ["-a", "-d", "cwd", "-F", "pn", "-n"],
      });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      const errChunks: Buffer[] = [];
      child.stderr.on("data", (chunk) => errChunks.push(Buffer.from(chunk)));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("lsof timed out"));
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve({
          code,
          stdout: Buffer.concat(chunks).toString("utf8"),
          stderr: Buffer.concat(errChunks).toString("utf8"),
        });
      });
    }),
};

let activeIo: CwdScanIo = hostCwdScanIo;

export function useCwdScanIoForTests(io: CwdScanIo | null): void {
  activeIo = io ?? hostCwdScanIo;
}

export function cwdScanIoDescendantsOnly<Io extends CwdScanIo>(
  base: Io,
  rootPid: number,
): Io {
  const parentOf = async (pid: number): Promise<number | null> => {
    try {
      const text = await readFile(`/proc/${pid}/stat`, "utf8");
      const parent = Number(
        text.slice(text.lastIndexOf(")") + 2).split(" ")[1],
      );
      return Number.isInteger(parent) ? parent : null;
    } catch {
      return null;
    }
  };
  const below = async (pid: number): Promise<boolean> => {
    let current: number | null = pid;
    for (
      let steps = 0;
      steps < 64 && current !== null && current > 1;
      steps += 1
    ) {
      if (current === rootPid) return true;
      current = await parentOf(current);
    }
    return false;
  };
  return {
    ...base,
    listProcessIds: async () => {
      const kept: string[] = [];
      for (const entry of await base.listProcessIds()) {
        if (!/^\d+$/u.test(entry) || (await below(Number(entry))))
          kept.push(entry);
      }
      return kept;
    },
  };
}

export async function scanProcessesWithCwdUnder(
  args: { directories: readonly string[]; timeoutMs?: number },
  io: CwdScanIo = activeIo,
): Promise<CwdHolderScan> {
  if (io.platform === "win32") {
    return {
      status: "unknown",
      reason: "working directories of processes cannot be listed on Windows",
    };
  }
  const directories: string[] = [];
  for (const directory of args.directories) {
    const resolved = await resolveSweepDirectory(directory);
    if (resolved === null) {
      return {
        status: "unknown",
        reason: `${directory} is a symbolic link, so which folder it names cannot be vouched for`,
      };
    }
    directories.push(resolved);
  }
  const holders: CwdHolder[] = [];
  if (io.platform === "linux") {
    let entries: string[];
    try {
      entries = await io.listProcessIds();
    } catch (error) {
      return {
        status: "unknown",
        reason: `the process list could not be read (${codeOf(error) || "error"})`,
      };
    }
    let excluded = 0;
    const skippedOtherUsers: CwdSkippedProcess[] = [];
    const unvouchedHelpers: CwdUnvouchedHelper[] = [];
    for (const entry of entries) {
      if (!/^\d+$/u.test(entry)) continue;
      const pid = Number(entry);
      if (pid === io.selfPid) continue;
      let cwd: string;
      try {
        cwd = await io.readCwd(pid);
      } catch (error) {
        const code = codeOf(error);
        if (GONE.has(code)) continue;
        if (code === "EACCES" || code === "EPERM") {
          let owner: number;
          try {
            owner = await io.effectiveUid(pid);
          } catch (ownerError) {
            if (GONE.has(codeOf(ownerError))) continue;
            return {
              status: "unknown",
              reason: `the owner of process ${pid} could not be read`,
            };
          }
          if (io.uid !== null && owner !== io.uid) {
            excluded += 1;
            skippedOtherUsers.push({ pid, uid: owner, errno: code });
            continue;
          }
          if (io.uid !== null) {
            let comm: string;
            try {
              comm = await io.readComm(pid);
            } catch (commError) {
              if (GONE.has(codeOf(commError))) continue;
              return {
                status: "unknown",
                reason: `the working directory of process ${pid} could not be read and its name could not be read either`,
              };
            }
            if (UNREADABLE_SAME_USER_HELPER_COMMS.has(comm)) {
              unvouchedHelpers.push({ pid, comm });
              continue;
            }
            return {
              status: "unknown",
              reason: `the working directory of process ${pid} (${comm}) could not be read and it is not a known session helper`,
            };
          }
        }
        if (io.uid !== null) {
          let owner: number | null = null;
          try {
            owner = await io.effectiveUid(pid);
          } catch (ownerError) {
            if (GONE.has(codeOf(ownerError))) continue;
          }
          if (owner !== null && owner !== io.uid) {
            excluded += 1;
            skippedOtherUsers.push({ pid, uid: owner, errno: code || "error" });
            continue;
          }
        }
        return {
          status: "unknown",
          reason: `the working directory of process ${pid} could not be read (${code || "error"})`,
        };
      }
      if (directories.some((directory) => isUnder(cwd, directory)))
        holders.push({ pid, cwd });
    }
    const coverage = {
      excludedOtherUsers: excluded,
      unvouchedHelpers,
      ...(skippedOtherUsers.length > 0 ? { skippedOtherUsers } : {}),
    };
    return holders.length > 0
      ? { status: "held", holders, ...coverage }
      : { status: "clear", ...coverage };
  }
  const inspection = await inspectDarwinProcesses(io, args.timeoutMs ?? 30_000);
  if (inspection.status === "unknown") return inspection;
  for (const [pid, cwd] of inspection.cwds) {
    if (pid !== io.selfPid && directories.some((d) => isUnder(cwd, d)))
      holders.push({ pid, cwd });
  }
  if (holders.length === 0 && inspection.invisible.length > 0) {
    const first = inspection.invisible[0]!;
    return {
      status: "unknown",
      reason: `process ${first.pid} (${first.comm}) runs as the current user, is not a known session helper and has no working directory in the lsof listing, so whether it works inside the folder cannot be established${inspection.invisible.length > 1 ? ` (${inspection.invisible.length} such processes)` : ""}`,
    };
  }
  const coverage = {
    excludedOtherUsers:
      inspection.skipped === null ? null : inspection.skipped.length,
    unvouchedHelpers: inspection.helpers,
    ...(inspection.skipped !== null && inspection.skipped.length > 0
      ? { skippedOtherUsers: inspection.skipped }
      : {}),
  };
  return holders.length > 0
    ? { status: "held", holders, ...coverage }
    : { status: "clear", ...coverage };
}

export interface DarwinOpenFile {
  fd: string;
  name: string;
}

export type CwdProcessClass =
  | "readable"
  | "unreadable-same-uid"
  | "skipped-other-uid"
  | "known-helper";

export type DarwinInspection =
  | {
      status: "unknown";
      code: Extract<
        HolderUnknownCode,
        "process-list-unreadable" | "lsof-failed"
      >;
      reason: string;
    }
  | {
      status: "ok";
      cwds: Map<number, string>;
      files: Map<number, DarwinOpenFile[]>;
      skipped: CwdSkippedProcess[] | null;
      helpers: CwdUnvouchedHelper[] | null;
      invisible: CwdUnvouchedHelper[];
      rows: {
        pid: number;
        uid: number | null;
        comm: string;
        klass: CwdProcessClass;
      }[];
    };

interface PsRow {
  pid: number;
  uid: number;
  comm: string;
}

function parsePs(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(-?\d+)\s+(.*\S)\s*$/u.exec(line);
    if (match === null) continue;
    const comm = (match[3] ?? "").split("/").pop() ?? "";
    rows.push({ pid: Number(match[1]), uid: Number(match[2]), comm });
  }
  return rows;
}

export async function inspectDarwinProcesses(
  io: CwdScanIo,
  timeoutMs: number,
  runLsof: CwdScanIo["runLsof"] = io.runLsof,
  exitOneIsComplete = true,
): Promise<DarwinInspection> {
  let listed: PsRow[] | null = null;
  if (io.runPs !== undefined) {
    try {
      const ps = await io.runPs(timeoutMs);
      if (ps.code !== 0)
        return {
          status: "unknown",
          code: "process-list-unreadable",
          reason: `ps exited with ${ps.code === null ? "a signal" : `code ${ps.code}`}`,
        };
      listed = parsePs(ps.stdout);
    } catch (error) {
      return {
        status: "unknown",
        code: "process-list-unreadable",
        reason: `ps failed (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }
  let output: { code: number | null; stdout: string; stderr: string };
  try {
    output = await runLsof(timeoutMs);
  } catch (error) {
    return {
      status: "unknown",
      code: "lsof-failed",
      reason: `lsof failed (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (output.code !== 0 && !(exitOneIsComplete && output.code === 1)) {
    return {
      status: "unknown",
      code: "lsof-failed",
      reason: `lsof exited with ${output.code === null ? "a signal" : `code ${output.code}`}`,
    };
  }
  if (output.stderr.trim() !== "") {
    return {
      status: "unknown",
      code: "lsof-failed",
      reason: `lsof exited with code ${output.code} and reported: ${output.stderr.trim().split("\n")[0]}`,
    };
  }
  const cwds = new Map<number, string>();
  const files = new Map<number, DarwinOpenFile[]>();
  let pid: number | null = null;
  let fd: string | null = null;
  for (const field of output.stdout.split(/[\0\n]/u)) {
    if (field.startsWith("p")) {
      pid = Number(field.slice(1));
      fd = null;
    } else if (field.startsWith("f")) fd = field.slice(1);
    else if (field.startsWith("n") && pid !== null) {
      if (fd === null || fd === "cwd") cwds.set(pid, field.slice(1));
      else
        files.set(pid, [
          ...(files.get(pid) ?? []),
          { fd, name: field.slice(1) },
        ]);
    }
  }
  if (listed === null || io.uid === null)
    return {
      status: "ok",
      cwds,
      files,
      skipped: null,
      helpers: null,
      invisible: [],
      rows: [],
    };
  const skipped: CwdSkippedProcess[] = [];
  const helpers: CwdUnvouchedHelper[] = [];
  const candidates: PsRow[] = [];
  const rows: Extract<DarwinInspection, { status: "ok" }>["rows"] = [];
  for (const row of listed) {
    if (row.pid === io.selfPid) continue;
    if (row.uid !== io.uid) {
      skipped.push({ pid: row.pid, uid: row.uid, errno: "other-euid" });
      rows.push({ ...row, klass: "skipped-other-uid" });
    } else if (cwds.has(row.pid)) {
      rows.push({ ...row, klass: "readable" });
    } else if (UNREADABLE_SAME_USER_HELPER_COMMS.has(row.comm)) {
      helpers.push({ pid: row.pid, comm: row.comm });
      rows.push({ ...row, klass: "known-helper" });
    } else {
      candidates.push(row);
    }
  }
  let invisible: CwdUnvouchedHelper[] = [];
  if (candidates.length > 0) {
    await (
      io.delay ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    )(MAC_RETRY_MS);
    let again: PsRow[];
    try {
      const ps = await io.runPs!(timeoutMs);
      if (ps.code !== 0)
        return {
          status: "unknown",
          code: "process-list-unreadable",
          reason: `ps exited with ${ps.code === null ? "a signal" : `code ${ps.code}`} on the second look`,
        };
      again = parsePs(ps.stdout);
    } catch (error) {
      return {
        status: "unknown",
        code: "process-list-unreadable",
        reason: `ps failed on the second look (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    const alive = new Map(again.map((row) => [row.pid, row]));
    for (const row of candidates) {
      const now = alive.get(row.pid);
      if (now !== undefined && now.comm === row.comm && now.uid === row.uid) {
        invisible.push({ pid: row.pid, comm: row.comm });
        rows.push({ ...row, klass: "unreadable-same-uid" });
      }
    }
  }
  return { status: "ok", cwds, files, skipped, helpers, invisible, rows };
}

export type HolderUnknownCode =
  | "no-directory"
  | "unsupported-platform"
  | "symlinked-directory"
  | "process-list-unreadable"
  | "lsof-failed"
  | "mount-table"
  | "foreign-namespace"
  | "main-thread-exited"
  | "unreadable-same-user"
  | "invisible-process"
  | "escaped-directory"
  | "other-user-reachable"
  | "other-user-namespace"
  | "other-user-descendant"
  | "other-user-acl"
  | "other-user-groups"
  | "other-user-capability";

export interface HolderBlocker {
  pid: number;
  uid: number | null;
  namespace: string;
}

export type HolderThrough =
  | "working-directory"
  | "program"
  | "open-file"
  | "memory-map";

export interface FileHolder {
  pid: number;
  path: string;
  through: HolderThrough;
}

export type HolderScan =
  | ({ status: "clear" } & CwdScanCoverage)
  | ({ status: "held"; holders: FileHolder[] } & CwdScanCoverage)
  | {
      status: "unknown";
      code: HolderUnknownCode;
      reason: string;
      blocker?: HolderBlocker;
    };

export interface HoldScanIo extends CwdScanIo {
  readExe(pid: number): Promise<string>;
  listOpenFiles(pid: number): Promise<string[]>;
  readMaps(pid: number): Promise<string>;
  statPath(path: string): Promise<{ uid: number; gid: number; mode: number }>;
  readAcl(path: string): Promise<HolderAcl>;
  readCredentials(pid: number): Promise<HolderCredentials>;
  readProcessNamespace(pid: number): Promise<string>;
  runPsUser(
    pid: number,
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
  readCmdline(pid: number): Promise<string[]>;
  runPsTree(
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
  runIdGroups(
    user: number | string,
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
  readOwnMountNamespace(): Promise<string>;
  readMountInfo(): Promise<string>;
  listTasks(pid: number): Promise<string[]>;
  readTaskNamespace(pid: number, tid: string): Promise<string>;
  readTaskCwd(pid: number, tid: string): Promise<string>;
  readRoot(pid: number): Promise<string>;
  runLsofOpenFiles(
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export const hostHoldScanIo: HoldScanIo = {
  ...hostCwdScanIo,
  readExe: (pid) => readlink(`/proc/${pid}/exe`),
  listOpenFiles: async (pid) => {
    const targets: string[] = [];
    for (const name of await readdir(`/proc/${pid}/fd`)) {
      try {
        targets.push(await readlink(`/proc/${pid}/fd/${name}`));
      } catch (error) {
        if (!GONE.has(codeOf(error))) throw error;
      }
    }
    return targets;
  },
  readMaps: (pid) => readFile(`/proc/${pid}/maps`, "utf8"),
  statPath: async (path) => {
    const { uid, gid, mode } = await stat(path);
    return { uid, gid, mode };
  },
  readAcl: async (path) => {
    const listing = await runCommand(
      "ls",
      process.platform === "darwin"
        ? ["-lde", "--", path]
        : ["-ld", "--", path],
      10_000,
    );
    if (listing.code !== 0)
      throw Object.assign(new Error("ls failed"), { code: "EIO" });
    return parseAclListing(listing.stdout, process.platform);
  },
  readCredentials: async (pid) =>
    parseCredentials(await readFile(`/proc/${pid}/status`, "utf8")),
  readCmdline: async (pid) =>
    (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0"),
  runPsTree: (timeoutMs) =>
    runCommand("ps", ["-A", "-o", "pid=,ppid=,uid="], timeoutMs),
  runIdGroups: (user, timeoutMs) =>
    runCommand("id", ["-G", String(user)], timeoutMs),
  runPsUser: (pid, timeoutMs) =>
    runCommand("ps", ["-o", "user=", "-p", String(pid)], timeoutMs),
  readProcessNamespace: (pid) => readlink(`/proc/${pid}/ns/mnt`),
  readOwnMountNamespace: () => readlink("/proc/self/ns/mnt"),
  readMountInfo: () => readFile("/proc/self/mountinfo", "utf8"),
  listTasks: (pid) => readdir(`/proc/${pid}/task`),
  readTaskNamespace: (pid, tid) => readlink(`/proc/${pid}/task/${tid}/ns/mnt`),
  readTaskCwd: (pid, tid) => readlink(`/proc/${pid}/task/${tid}/cwd`),
  readRoot: (pid) => readlink(`/proc/${pid}/root`),
  runLsofOpenFiles: (timeoutMs) =>
    runCommand(
      "lsof",
      [
        "-n",
        "-F",
        "pfn0",
        ...(hostCwdScanIo.uid === null
          ? []
          : ["-u", String(hostCwdScanIo.uid)]),
      ],
      timeoutMs,
    ),
};

let activeHoldIo: HoldScanIo = hostHoldScanIo;

export function useHoldScanIoForTests(io: HoldScanIo | null): void {
  activeHoldIo = io ?? hostHoldScanIo;
}

type HoldRead<Value> =
  | { status: "read"; value: Value }
  | { status: "gone" }
  | { status: "skip" }
  | {
      status: "unknown";
      code: HolderUnknownCode;
      reason: string;
      blocker?: HolderBlocker;
    };

export interface HolderCredentials {
  uid: number;
  gids: number[];
  parentPid: number;
  nestedPidNamespace: boolean;
  dacCapability: boolean;
}

export type HolderAcl = "none" | "deny-only" | "allow";

interface Stranger {
  uid: number;
  gids: number[];
  pid: number;
}

interface HoldCoverage {
  helpers: CwdUnvouchedHelper[];
  skipped: CwdSkippedProcess[];
  strangers: Map<number, Stranger>;
  ownNamespace: string;
}

const ROOT_UID = 0;
const MAX_ANCESTOR_STEPS = 64;
const DAC_CAPABILITY_BITS = 0b110n;

function ancestorsOf(path: string): string[] {
  const chain: string[] = [];
  let current = path;
  while (current !== "/" && current !== "") {
    chain.push(current);
    current = current.slice(0, current.lastIndexOf("/")) || "/";
  }
  chain.push("/");
  return chain;
}

function otherUserCanReach(pid: number, uid: number): string {
  return `process ${pid} runs as user ${uid}, who is neither this user nor root and can reach the folder, so what it holds cannot be vouched for`;
}

function hasSearchPermission(
  entry: { uid: number; gid: number; mode: number },
  user: { uid: number; gids: readonly number[] },
): boolean {
  if (user.uid === entry.uid) return (entry.mode & 0o100) !== 0;
  if (user.gids.includes(entry.gid)) return (entry.mode & 0o010) !== 0;
  return (entry.mode & 0o001) !== 0;
}

export function parseCredentials(status: string): HolderCredentials {
  const field = (name: string): number[] => {
    const line = new RegExp(`^${name}:\\t([0-9\\t ]*)$`, "mu").exec(status);
    if (line === null)
      throw Object.assign(new Error(`no ${name} line`), { code: "EINVAL" });
    return (line[1] ?? "")
      .split(/\s+/u)
      .filter((value) => value !== "")
      .map(Number);
  };
  const uids = field("Uid");
  const gids = field("Gid");
  const parent = field("PPid");
  const namespaced = field("NSpid");
  const uid = uids[1];
  const gid = gids[1];
  const parentPid = parent[0];
  if (
    uid === undefined ||
    gid === undefined ||
    parentPid === undefined ||
    namespaced.length === 0
  )
    throw Object.assign(new Error("unparsable status"), { code: "EINVAL" });
  const supplementary = /^Groups:\t([0-9\t ]*)$/mu.exec(status);
  const effective = /^CapEff:\t([0-9a-fA-F]+)$/mu.exec(status);
  if (supplementary === null || effective === null)
    throw Object.assign(new Error("unparsable status"), { code: "EINVAL" });
  return {
    uid,
    gids: [
      gid,
      ...(supplementary[1] ?? "")
        .split(/\s+/u)
        .filter((value) => value !== "")
        .map(Number),
    ],
    parentPid,
    nestedPidNamespace: namespaced.length > 1,
    dacCapability:
      (BigInt(`0x${effective[1] ?? "0"}`) & DAC_CAPABILITY_BITS) !== 0n,
  };
}

export function parseAclListing(
  listing: string,
  platform: NodeJS.Platform,
): HolderAcl {
  const lines = listing.split("\n");
  const flag = /^[-dlcbps][rwxsStT-]{9}([+@. ]?)\s/u.exec(lines[0] ?? "");
  if (flag === null)
    throw Object.assign(new Error("unparsable listing"), { code: "EINVAL" });
  if (platform !== "darwin") return flag[1] === "+" ? "allow" : "none";
  let entries = 0;
  let allow = false;
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    if (!/^\s*\d+:\s+\S/u.test(line))
      throw Object.assign(new Error("unparsable ACL entry"), {
        code: "EINVAL",
      });
    entries += 1;
    if (/\ballow\b/u.test(line)) allow = true;
    else if (!/\bdeny\b/u.test(line))
      throw Object.assign(new Error("unparsable ACL entry"), {
        code: "EINVAL",
      });
  }
  if (entries === 0) {
    if (flag[1] === "+")
      throw Object.assign(new Error("ACL flag without entries"), {
        code: "EINVAL",
      });
    return "none";
  }
  return allow ? "allow" : "deny-only";
}

function helperCommandLineMatches(
  comm: string,
  argv: readonly string[],
): boolean {
  const first = (argv[0] ?? "").split(/[: ]/u)[0] ?? "";
  return first.split("/").pop() === comm;
}

async function ancestorRunsAs(
  io: HoldScanIo,
  pid: number,
  uid: number,
): Promise<"yes" | "no" | "unreadable"> {
  let current = pid;
  for (let step = 0; step < MAX_ANCESTOR_STEPS; step += 1) {
    let parent: number;
    try {
      parent = (await io.readCredentials(current)).parentPid;
    } catch {
      return "unreadable";
    }
    if (parent <= 0) return "no";
    let credentials: HolderCredentials;
    try {
      credentials = await io.readCredentials(parent);
    } catch {
      return "unreadable";
    }
    if (credentials.uid === uid) return "yes";
    if (parent === 1) return "no";
    current = parent;
  }
  return "unreadable";
}

async function noteStranger(
  io: HoldScanIo,
  coverage: HoldCoverage,
  pid: number,
  owner: number,
  errno: string,
): Promise<HoldRead<never>> {
  if (owner === ROOT_UID || io.uid === null) {
    coverage.skipped.push({ pid, uid: owner, errno });
    return { status: "skip" };
  }
  let credentials: HolderCredentials;
  try {
    credentials = await io.readCredentials(pid);
  } catch (error) {
    if (GONE.has(codeOf(error))) return { status: "gone" };
    return {
      status: "unknown",
      code: "other-user-groups",
      reason: `the groups of process ${pid}, which runs as user ${owner}, could not be read`,
    };
  }
  if (credentials.nestedPidNamespace)
    return {
      status: "unknown",
      code: "other-user-namespace",
      reason: `process ${pid} runs as user ${owner} in a nested process namespace, so another user, other namespace: the folder may be reachable through a mount bb cannot see`,
      blocker: { pid, uid: owner, namespace: "nested process namespace" },
    };
  if (credentials.dacCapability)
    return {
      status: "unknown",
      code: "other-user-capability",
      reason: `process ${pid} runs as user ${owner} with a capability that bypasses search permission, so the folder modes do not bound what it can reach`,
    };
  let theirs: string;
  try {
    theirs = await io.readProcessNamespace(pid);
  } catch (error) {
    if (GONE.has(codeOf(error))) return { status: "gone" };
    return {
      status: "unknown",
      code: "other-user-namespace",
      reason: `the mount namespace of process ${pid}, which runs as user ${owner}, cannot be read, so another user, other namespace: it is not shown to share this one`,
      blocker: { pid, uid: owner, namespace: "unreadable" },
    };
  }
  if (theirs !== coverage.ownNamespace)
    return {
      status: "unknown",
      code: "other-user-namespace",
      reason: `process ${pid} runs as user ${owner} in another mount namespace, so another user, other namespace: the folder may be reachable through a mount bb cannot see`,
      blocker: { pid, uid: owner, namespace: theirs },
    };
  const inherited = await ancestorRunsAs(io, pid, io.uid);
  if (inherited !== "no")
    return {
      status: "unknown",
      code: "other-user-descendant",
      reason:
        inherited === "yes"
          ? `process ${pid} runs as user ${owner} but descends from a process of this user, so it may have inherited a working directory inside the folder`
          : `whether process ${pid}, which runs as user ${owner}, descends from a process of this user could not be established`,
    };
  const known = coverage.strangers.get(owner);
  coverage.strangers.set(owner, {
    uid: owner,
    gids: [...new Set([...(known?.gids ?? []), ...credentials.gids])],
    pid: known?.pid ?? pid,
  });
  coverage.skipped.push({ pid, uid: owner, errno });
  return { status: "skip" };
}

async function strangersReachFolder(
  io: HoldScanIo,
  strangers: readonly Stranger[],
  paths: readonly string[],
): Promise<HolderScan | null> {
  if (strangers.length === 0) return null;
  const chains = new Map<
    string,
    { uid: number; gid: number; mode: number }[]
  >();
  const acls = new Map<string, HolderAcl>();
  for (const path of paths) {
    const chain: { uid: number; gid: number; mode: number }[] = [];
    for (const ancestor of ancestorsOf(path)) {
      try {
        chain.push(await io.statPath(ancestor));
        if (!acls.has(ancestor)) acls.set(ancestor, await io.readAcl(ancestor));
      } catch {
        return {
          status: "unknown",
          code: "other-user-acl",
          reason: `the owner, mode or access control list of ${ancestor} could not be read, so whether other users can reach ${path} cannot be established`,
        };
      }
    }
    chains.set(path, chain);
  }
  const allowing = [...acls].find(([, acl]) => acl === "allow");
  if (allowing !== undefined)
    return {
      status: "unknown",
      code: "other-user-acl",
      reason: `${allowing[0]} has an access control list entry that allows access, so whether other users can reach the folder cannot be judged from its mode`,
    };
  for (const stranger of strangers) {
    const reaches = [...chains.values()].some((chain) =>
      chain.every((entry) => hasSearchPermission(entry, stranger)),
    );
    if (reaches)
      return {
        status: "unknown",
        code: "other-user-reachable",
        reason: otherUserCanReach(stranger.pid, stranger.uid),
      };
  }
  return null;
}

async function readHeldProcessFact<Value>(
  io: HoldScanIo,
  coverage: HoldCoverage,
  pid: number,
  what: string,
  read: () => Promise<Value>,
): Promise<HoldRead<Value>> {
  try {
    return { status: "read", value: await read() };
  } catch (error) {
    const code = codeOf(error);
    if (GONE.has(code)) return { status: "gone" };
    let owner: number | null = null;
    try {
      owner = await io.effectiveUid(pid);
    } catch (ownerError) {
      if (GONE.has(codeOf(ownerError))) return { status: "gone" };
      if (code === "EACCES" || code === "EPERM")
        return {
          status: "unknown",
          code: "unreadable-same-user",
          reason: `the owner of process ${pid} could not be read`,
        };
    }
    if (io.uid !== null && owner !== null && owner !== io.uid)
      return noteStranger(io, coverage, pid, owner, code || "error");
    if (io.uid !== null && (code === "EACCES" || code === "EPERM")) {
      let comm: string;
      try {
        comm = await io.readComm(pid);
      } catch (commError) {
        if (GONE.has(codeOf(commError))) return { status: "gone" };
        return {
          status: "unknown",
          code: "unreadable-same-user",
          reason: `the ${what} of process ${pid} could not be read and its name could not be read either`,
        };
      }
      if (UNREADABLE_SAME_USER_HELPER_COMMS.has(comm)) {
        let argv: string[];
        try {
          argv = await io.readCmdline(pid);
        } catch (argvError) {
          if (GONE.has(codeOf(argvError))) return { status: "gone" };
          return {
            status: "unknown",
            code: "unreadable-same-user",
            reason: `the ${what} of process ${pid} (${comm}) could not be read and its command line could not be read either`,
          };
        }
        if (helperCommandLineMatches(comm, argv)) {
          coverage.helpers.push({ pid, comm });
          return { status: "skip" };
        }
      }
      return {
        status: "unknown",
        code: "unreadable-same-user",
        reason: `the ${what} of process ${pid} (${comm}) could not be read and it is not a known session helper`,
      };
    }
    return {
      status: "unknown",
      code: "unreadable-same-user",
      reason: `the ${what} of process ${pid} could not be read (${code || "error"})`,
    };
  }
}

async function foreignOrUnknown(
  io: HoldScanIo,
  coverage: HoldCoverage,
  pid: number,
  namespace: string,
  reason: string,
): Promise<HoldRead<never>> {
  let owner: number;
  try {
    owner = await io.effectiveUid(pid);
  } catch (error) {
    if (GONE.has(codeOf(error))) return { status: "gone" };
    return {
      status: "unknown",
      code: "foreign-namespace",
      reason,
      blocker: { pid, uid: null, namespace },
    };
  }
  if (io.uid !== null && owner !== io.uid) {
    if (owner !== ROOT_UID)
      return {
        status: "unknown",
        code: "other-user-namespace",
        reason: `another user, other namespace: ${reason}`,
        blocker: { pid, uid: owner, namespace },
      };
    coverage.skipped.push({ pid, uid: owner, errno: "other-namespace" });
    return { status: "skip" };
  }
  return {
    status: "unknown",
    code: "foreign-namespace",
    reason,
    blocker: { pid, uid: owner, namespace },
  };
}

const MAPS_PATH_COLUMN = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/u;

function decodeKernelEscapes(text: string): string {
  return text.replace(/\\([0-7]{3})/gu, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function mappedPaths(maps: string): string[] {
  const paths: string[] = [];
  for (const line of maps.split("\n")) {
    const mapped = MAPS_PATH_COLUMN.exec(line)?.[1];
    if (mapped !== undefined) paths.push(decodeKernelEscapes(mapped));
  }
  return paths;
}

interface MountEntry {
  device: string;
  root: string;
  mountPoint: string;
}

function parseMountInfo(text: string): MountEntry[] | null {
  const entries: MountEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    const device = fields[2];
    const root = fields[3];
    const mountPoint = fields[4];
    if (
      separator < 6 ||
      device === undefined ||
      root === undefined ||
      mountPoint === undefined
    )
      return null;
    entries.push({
      device,
      root: decodeKernelEscapes(root),
      mountPoint: decodeKernelEscapes(mountPoint),
    });
  }
  return entries.length > 0 ? entries : null;
}

function isAncestorOrSame(ancestor: string, path: string): boolean {
  return (
    ancestor === "/" || path === ancestor || path.startsWith(`${ancestor}/`)
  );
}

function expandMountAliases(
  directory: string,
  mounts: readonly MountEntry[],
): string[] | null {
  let containing: MountEntry | null = null;
  for (const mount of mounts) {
    if (
      isAncestorOrSame(mount.mountPoint, directory) &&
      (containing === null ||
        mount.mountPoint.length >= containing.mountPoint.length)
    )
      containing = mount;
  }
  if (containing === null) return null;
  const relative =
    containing.mountPoint === "/"
      ? directory
      : directory.slice(containing.mountPoint.length);
  const inFilesystem =
    containing.root === "/" ? relative : `${containing.root}${relative}`;
  const paths = [directory];
  for (const mount of mounts) {
    if (mount === containing || mount.device !== containing.device) continue;
    if (
      !isAncestorOrSame(mount.root, inFilesystem) &&
      isAncestorOrSame(inFilesystem, mount.root)
    ) {
      if (!paths.includes(mount.mountPoint)) paths.push(mount.mountPoint);
      continue;
    }
    if (!isAncestorOrSame(mount.root, inFilesystem)) continue;
    const below =
      mount.root === "/" ? inFilesystem : inFilesystem.slice(mount.root.length);
    const alias =
      mount.mountPoint === "/" ? below || "/" : `${mount.mountPoint}${below}`;
    if (!paths.includes(alias)) paths.push(alias);
  }
  return paths;
}

export function mountsInsideDirectory(
  directory: string,
  mountInfo: string,
): string[] | null {
  const mounts = parseMountInfo(mountInfo);
  if (mounts === null) return null;
  const inside: string[] = [];
  for (const mount of mounts) {
    if (
      mount.mountPoint !== directory &&
      isAncestorOrSame(directory, mount.mountPoint) &&
      !inside.includes(mount.mountPoint)
    )
      inside.push(mount.mountPoint);
  }
  return inside;
}

type LinuxProcessScan =
  | { status: "clear" }
  | { status: "held"; holder: FileHolder }
  | {
      status: "unknown";
      code: HolderUnknownCode;
      reason: string;
      blocker?: HolderBlocker;
    };

async function scanLinuxProcess(
  io: HoldScanIo,
  coverage: HoldCoverage,
  pid: number,
  ownNamespace: string,
  under: (path: string) => boolean,
): Promise<LinuxProcessScan> {
  const tasks = await readHeldProcessFact(io, coverage, pid, "threads", () =>
    io.listTasks(pid),
  );
  if (tasks.status === "unknown") return tasks;
  if (tasks.status !== "read") return { status: "clear" };
  for (const tid of tasks.value) {
    const namespace = await readHeldProcessFact(
      io,
      coverage,
      pid,
      "mount namespace",
      () => io.readTaskNamespace(pid, tid),
    );
    if (namespace.status === "unknown") return namespace;
    if (namespace.status === "skip") return { status: "clear" };
    if (namespace.status === "gone") continue;
    if (namespace.value !== ownNamespace) {
      const outcome = await foreignOrUnknown(
        io,
        coverage,
        pid,
        namespace.value,
        `process ${pid} runs in a different mount namespace, so which folder its paths name cannot be vouched for`,
      );
      return outcome.status === "unknown" ? outcome : { status: "clear" };
    }
    const cwd = await readHeldProcessFact(
      io,
      coverage,
      pid,
      "working directory",
      () => io.readTaskCwd(pid, tid),
    );
    if (cwd.status === "unknown") return cwd;
    if (cwd.status === "skip") return { status: "clear" };
    if (cwd.status === "read" && under(cwd.value))
      return {
        status: "held",
        holder: { pid, path: cwd.value, through: "working-directory" },
      };
  }
  const vanished = async (): Promise<LinuxProcessScan> => {
    const again = await readHeldProcessFact(io, coverage, pid, "threads", () =>
      io.listTasks(pid),
    );
    if (again.status === "unknown") return again;
    if (
      again.status === "read" &&
      again.value.some((tid) => tid !== String(pid))
    )
      return {
        status: "unknown",
        code: "main-thread-exited",
        reason: `the main thread of process ${pid} has exited while other threads still run, so what the process holds cannot be listed`,
      };
    return { status: "clear" };
  };
  const root = await readHeldProcessFact(io, coverage, pid, "root folder", () =>
    io.readRoot(pid),
  );
  if (root.status === "unknown") return root;
  if (root.status === "skip") return { status: "clear" };
  if (root.status === "gone") return vanished();
  if (root.value !== "/") {
    const outcome = await foreignOrUnknown(
      io,
      coverage,
      pid,
      `root:${root.value}`,
      `process ${pid} runs under a different root folder, so which folder its paths name cannot be vouched for`,
    );
    return outcome.status === "unknown" ? outcome : { status: "clear" };
  }
  const exe = await readHeldProcessFact(io, coverage, pid, "program", () =>
    io.readExe(pid),
  );
  if (exe.status === "unknown") return exe;
  if (exe.status === "skip") return { status: "clear" };
  if (exe.status === "gone") return vanished();
  if (under(exe.value))
    return {
      status: "held",
      holder: { pid, path: exe.value, through: "program" },
    };
  const opened = await readHeldProcessFact(
    io,
    coverage,
    pid,
    "open files",
    () => io.listOpenFiles(pid),
  );
  if (opened.status === "unknown") return opened;
  if (opened.status === "skip") return { status: "clear" };
  if (opened.status === "gone") return vanished();
  const openFile = opened.value.find(under);
  if (openFile !== undefined)
    return {
      status: "held",
      holder: { pid, path: openFile, through: "open-file" },
    };
  const maps = await readHeldProcessFact(io, coverage, pid, "memory maps", () =>
    io.readMaps(pid),
  );
  if (maps.status === "unknown") return maps;
  if (maps.status === "skip") return { status: "clear" };
  if (maps.status === "gone") return vanished();
  const mapped = mappedPaths(maps.value).find(under);
  return mapped === undefined
    ? { status: "clear" }
    : {
        status: "held",
        holder: { pid, path: mapped, through: "memory-map" },
      };
}

async function scanLinuxHolders(
  io: HoldScanIo,
  directories: readonly string[],
): Promise<HolderScan> {
  let entries: string[];
  try {
    entries = await io.listProcessIds();
  } catch (error) {
    return {
      status: "unknown",
      code: "process-list-unreadable",
      reason: `the process list could not be read (${codeOf(error) || "error"})`,
    };
  }
  let ownNamespace: string;
  try {
    ownNamespace = await io.readOwnMountNamespace();
  } catch (error) {
    return {
      status: "unknown",
      code: "mount-table",
      reason: `the mount namespace of this process could not be read (${codeOf(error) || "error"})`,
    };
  }
  let mounts: MountEntry[] | null;
  try {
    mounts = parseMountInfo(await io.readMountInfo());
  } catch (error) {
    return {
      status: "unknown",
      code: "mount-table",
      reason: `the mount table could not be read (${codeOf(error) || "error"})`,
    };
  }
  if (mounts === null)
    return {
      status: "unknown",
      code: "mount-table",
      reason: "the mount table could not be parsed",
    };
  const paths: string[] = [];
  for (const directory of directories) {
    const aliases = expandMountAliases(directory, mounts);
    if (aliases === null)
      return {
        status: "unknown",
        code: "mount-table",
        reason: `which mounts show ${directory} could not be worked out from the mount table`,
      };
    for (const alias of aliases) if (!paths.includes(alias)) paths.push(alias);
  }
  const under = (path: string) =>
    paths.some((directory) => isUnder(path, directory));
  const coverage: HoldCoverage = {
    helpers: [],
    skipped: [],
    strangers: new Map(),
    ownNamespace,
  };
  const holders: FileHolder[] = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    if (pid === io.selfPid) continue;
    const scanned = await scanLinuxProcess(
      io,
      coverage,
      pid,
      ownNamespace,
      under,
    );
    if (scanned.status === "unknown") return scanned;
    if (scanned.status === "held") holders.push(scanned.holder);
  }
  if (holders.length === 0) {
    const reachable = await strangersReachFolder(
      io,
      [...coverage.strangers.values()],
      paths,
    );
    if (reachable !== null) return reachable;
  }
  const report = {
    excludedOtherUsers: coverage.skipped.length,
    unvouchedHelpers: coverage.helpers,
    ...(coverage.skipped.length > 0
      ? { skippedOtherUsers: coverage.skipped }
      : {}),
  };
  return holders.length > 0
    ? { status: "held", holders, ...report }
    : { status: "clear", ...report };
}

function darwinThrough(fd: string): HolderThrough {
  if (fd === "txt") return "program";
  if (fd === "mem") return "memory-map";
  return "open-file";
}

async function darwinStrangers(
  io: HoldScanIo,
  skipped: readonly CwdSkippedProcess[],
  timeoutMs: number,
): Promise<Stranger[] | HolderScan> {
  const others = skipped.filter((process) => process.uid !== ROOT_UID);
  if (others.length === 0 || io.uid === null) return [];
  let tree: Map<number, { parent: number; uid: number }>;
  try {
    const listing = await io.runPsTree(timeoutMs);
    if (listing.code !== 0) throw new Error("ps failed");
    tree = new Map();
    for (const line of listing.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const row = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s*$/u.exec(line);
      if (row === null) throw new Error("unparsable ps line");
      tree.set(Number(row[1]), {
        parent: Number(row[2]),
        uid: Number(row[3]),
      });
    }
  } catch {
    return {
      status: "unknown",
      code: "other-user-descendant",
      reason:
        "the process tree could not be read, so whether another user's process descends from one of this user's cannot be established",
    };
  }
  const strangers = new Map<number, Stranger>();
  for (const other of others) {
    let current = other.pid;
    for (let step = 0; step < MAX_ANCESTOR_STEPS; step += 1) {
      const known = tree.get(current);
      if (known === undefined)
        return {
          status: "unknown",
          code: "other-user-descendant",
          reason: `process ${current} is missing from the process tree, so whether process ${other.pid} descends from a process of this user cannot be established`,
        };
      const parent = known.parent;
      if (parent <= 0) break;
      if (tree.get(parent)?.uid === io.uid)
        return {
          status: "unknown",
          code: "other-user-descendant",
          reason: `process ${other.pid} runs as user ${other.uid} but descends from a process of this user, so it may have inherited a working directory inside the folder`,
        };
      current = parent;
    }
    if (strangers.has(other.uid)) continue;
    let gids: number[];
    try {
      let account: number | string = other.uid;
      if (other.uid < 0) {
        const named = await io.runPsUser(other.pid, timeoutMs);
        if (named.code !== 0 || !/^\S+$/u.test(named.stdout.trim()))
          throw new Error("user name unreadable");
        account = named.stdout.trim();
      }
      const listing = await io.runIdGroups(account, timeoutMs);
      if (listing.code !== 0) throw new Error("id failed");
      gids = listing.stdout
        .trim()
        .split(/\s+/u)
        .map((value) => {
          if (!/^\d+$/u.test(value)) throw new Error("unparsable group");
          return Number(value);
        });
    } catch {
      return {
        status: "unknown",
        code: "other-user-groups",
        reason: `the groups of user ${other.uid}, who runs process ${other.pid}, could not be read`,
      };
    }
    strangers.set(other.uid, { uid: other.uid, gids, pid: other.pid });
  }
  return [...strangers.values()];
}

const LSOF_ESCAPED_PATH = /[^\x20-\x7e]|\\/u;

async function scanDarwinHolders(
  io: HoldScanIo,
  directories: readonly string[],
  timeoutMs: number,
): Promise<HolderScan> {
  const escaped = directories.find((directory) =>
    LSOF_ESCAPED_PATH.test(directory),
  );
  if (escaped !== undefined)
    return {
      status: "unknown",
      code: "escaped-directory",
      reason: `${escaped} holds characters lsof prints escaped, so a match against its listing cannot be vouched for`,
    };
  if (io.uid === null || io.runPs === undefined)
    return {
      status: "unknown",
      code: "process-list-unreadable",
      reason:
        "which processes belong to the current user cannot be listed, so none can be ruled out",
    };
  const inspection = await inspectDarwinProcesses(
    io,
    timeoutMs,
    io.runLsofOpenFiles,
    false,
  );
  if (inspection.status === "unknown") return inspection;
  const under = (path: string) =>
    directories.some((directory) => isUnder(path, directory));
  const holders: FileHolder[] = [];
  const holding = new Set<number>();
  for (const [pid, cwd] of inspection.cwds) {
    if (pid !== io.selfPid && under(cwd)) {
      holders.push({ pid, path: cwd, through: "working-directory" });
      holding.add(pid);
    }
  }
  for (const [pid, opened] of inspection.files) {
    if (pid === io.selfPid || holding.has(pid)) continue;
    const found = opened.find((file) => under(file.name));
    if (found !== undefined) {
      holders.push({
        pid,
        path: found.name,
        through: darwinThrough(found.fd),
      });
      holding.add(pid);
    }
  }
  if (holders.length === 0 && inspection.invisible.length > 0) {
    const first = inspection.invisible[0]!;
    return {
      status: "unknown",
      code: "invisible-process",
      reason: `process ${first.pid} (${first.comm}) runs as the current user, is not a known session helper and has no entries in the lsof listing, so whether it holds a file inside the folder cannot be established${inspection.invisible.length > 1 ? ` (${inspection.invisible.length} such processes)` : ""}`,
    };
  }
  if (holders.length === 0 && inspection.skipped !== null) {
    const strangers = await darwinStrangers(io, inspection.skipped, timeoutMs);
    if (!Array.isArray(strangers)) return strangers;
    const reachable = await strangersReachFolder(io, strangers, directories);
    if (reachable !== null) return reachable;
  }
  const report = {
    excludedOtherUsers:
      inspection.skipped === null ? null : inspection.skipped.length,
    unvouchedHelpers: inspection.helpers,
    ...(inspection.skipped !== null && inspection.skipped.length > 0
      ? { skippedOtherUsers: inspection.skipped }
      : {}),
  };
  return holders.length > 0
    ? { status: "held", holders, ...report }
    : { status: "clear", ...report };
}

export async function scanProcessesHoldingUnder(
  args: { directories: readonly string[]; timeoutMs?: number },
  io: HoldScanIo = activeHoldIo,
): Promise<HolderScan> {
  if (args.directories.length === 0) {
    return {
      status: "unknown",
      code: "no-directory",
      reason: "no directory was named, so nothing can be vouched for",
    };
  }
  if (io.platform === "win32") {
    return {
      status: "unknown",
      code: "unsupported-platform",
      reason: "what processes hold open on Windows cannot be listed",
    };
  }
  const directories: string[] = [];
  for (const directory of args.directories) {
    const resolved = await resolveSweepDirectory(directory);
    if (resolved === null) {
      return {
        status: "unknown",
        code: "symlinked-directory",
        reason: `${directory} is a symbolic link, so which folder it names cannot be vouched for`,
      };
    }
    directories.push(resolved);
  }
  return io.platform === "linux"
    ? scanLinuxHolders(io, directories)
    : scanDarwinHolders(io, directories, args.timeoutMs ?? 30_000);
}
