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
  | { status: "unknown"; reason: string }
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
    const match = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/u.exec(line);
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
          reason: `ps exited with ${ps.code === null ? "a signal" : `code ${ps.code}`}`,
        };
      listed = parsePs(ps.stdout);
    } catch (error) {
      return {
        status: "unknown",
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
      reason: `lsof failed (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (output.code !== 0 && !(exitOneIsComplete && output.code === 1)) {
    return {
      status: "unknown",
      reason: `lsof exited with ${output.code === null ? "a signal" : `code ${output.code}`}`,
    };
  }
  if (output.stderr.trim() !== "") {
    return {
      status: "unknown",
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
          reason: `ps exited with ${ps.code === null ? "a signal" : `code ${ps.code}`} on the second look`,
        };
      again = parsePs(ps.stdout);
    } catch (error) {
      return {
        status: "unknown",
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
  | { status: "unknown"; reason: string };

export interface HoldScanIo extends CwdScanIo {
  readExe(pid: number): Promise<string>;
  listOpenFiles(pid: number): Promise<string[]>;
  readMaps(pid: number): Promise<string>;
  statPath(path: string): Promise<{ uid: number; mode: number }>;
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
    const { uid, mode } = await stat(path);
    return { uid, mode };
  },
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
  | { status: "unknown"; reason: string };

interface HoldCoverage {
  helpers: CwdUnvouchedHelper[];
  skipped: CwdSkippedProcess[];
  hiddenFromOtherUsers: boolean;
}

const ROOT_UID = 0;
const GROUP_AND_OTHER_SEARCH_BITS = 0o011;

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

async function hiddenFromOtherUsers(
  io: HoldScanIo,
  paths: readonly string[],
  barrierRoot: string | undefined,
): Promise<boolean> {
  if (io.uid === null) return false;
  for (const path of paths) {
    let hidden = false;
    for (const candidate of ancestorsOf(path)) {
      if (
        barrierRoot !== undefined &&
        isUnder(path, barrierRoot) &&
        !isUnder(candidate, barrierRoot)
      )
        break;
      try {
        const { uid, mode } = await io.statPath(candidate);
        if (uid === io.uid && (mode & GROUP_AND_OTHER_SEARCH_BITS) === 0) {
          hidden = true;
          break;
        }
      } catch {
        return false;
      }
    }
    if (!hidden) return false;
  }
  return true;
}

function otherUserCanReach(pid: number, uid: number): string {
  return `process ${pid} runs as user ${uid}, who is neither this user nor root and can reach the folder, so what it holds cannot be vouched for`;
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
          reason: `the owner of process ${pid} could not be read`,
        };
    }
    if (io.uid !== null && owner !== null && owner !== io.uid) {
      if (owner !== ROOT_UID && !coverage.hiddenFromOtherUsers)
        return { status: "unknown", reason: otherUserCanReach(pid, owner) };
      coverage.skipped.push({ pid, uid: owner, errno: code || "error" });
      return { status: "skip" };
    }
    if (io.uid !== null && (code === "EACCES" || code === "EPERM")) {
      let comm: string;
      try {
        comm = await io.readComm(pid);
      } catch (commError) {
        if (GONE.has(codeOf(commError))) return { status: "gone" };
        return {
          status: "unknown",
          reason: `the ${what} of process ${pid} could not be read and its name could not be read either`,
        };
      }
      if (UNREADABLE_SAME_USER_HELPER_COMMS.has(comm)) {
        coverage.helpers.push({ pid, comm });
        return { status: "skip" };
      }
      return {
        status: "unknown",
        reason: `the ${what} of process ${pid} (${comm}) could not be read and it is not a known session helper`,
      };
    }
    return {
      status: "unknown",
      reason: `the ${what} of process ${pid} could not be read (${code || "error"})`,
    };
  }
}

async function foreignOrUnknown(
  io: HoldScanIo,
  coverage: HoldCoverage,
  pid: number,
  reason: string,
): Promise<HoldRead<never>> {
  let owner: number;
  try {
    owner = await io.effectiveUid(pid);
  } catch (error) {
    if (GONE.has(codeOf(error))) return { status: "gone" };
    return { status: "unknown", reason };
  }
  if (io.uid !== null && owner !== io.uid) {
    if (owner !== ROOT_UID && !coverage.hiddenFromOtherUsers)
      return { status: "unknown", reason: otherUserCanReach(pid, owner) };
    coverage.skipped.push({ pid, uid: owner, errno: "other-namespace" });
    return { status: "skip" };
  }
  return { status: "unknown", reason };
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
    if (
      mount === containing ||
      mount.device !== containing.device ||
      !isAncestorOrSame(mount.root, inFilesystem)
    )
      continue;
    const below =
      mount.root === "/" ? inFilesystem : inFilesystem.slice(mount.root.length);
    const alias =
      mount.mountPoint === "/" ? below || "/" : `${mount.mountPoint}${below}`;
    if (!paths.includes(alias)) paths.push(alias);
  }
  return paths;
}

type LinuxProcessScan =
  | { status: "clear" }
  | { status: "held"; holder: FileHolder }
  | { status: "unknown"; reason: string };

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
  barrierRoot: string | undefined,
): Promise<HolderScan> {
  let entries: string[];
  try {
    entries = await io.listProcessIds();
  } catch (error) {
    return {
      status: "unknown",
      reason: `the process list could not be read (${codeOf(error) || "error"})`,
    };
  }
  let ownNamespace: string;
  try {
    ownNamespace = await io.readOwnMountNamespace();
  } catch (error) {
    return {
      status: "unknown",
      reason: `the mount namespace of this process could not be read (${codeOf(error) || "error"})`,
    };
  }
  let mounts: MountEntry[] | null;
  try {
    mounts = parseMountInfo(await io.readMountInfo());
  } catch (error) {
    return {
      status: "unknown",
      reason: `the mount table could not be read (${codeOf(error) || "error"})`,
    };
  }
  if (mounts === null)
    return { status: "unknown", reason: "the mount table could not be parsed" };
  const paths: string[] = [];
  for (const directory of directories) {
    const aliases = expandMountAliases(directory, mounts);
    if (aliases === null)
      return {
        status: "unknown",
        reason: `which mounts show ${directory} could not be worked out from the mount table`,
      };
    for (const alias of aliases) if (!paths.includes(alias)) paths.push(alias);
  }
  const under = (path: string) =>
    paths.some((directory) => isUnder(path, directory));
  const coverage: HoldCoverage = {
    helpers: [],
    skipped: [],
    hiddenFromOtherUsers: await hiddenFromOtherUsers(io, paths, barrierRoot),
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

const LSOF_ESCAPED_PATH = /[^\x20-\x7e]|\\/u;

async function scanDarwinHolders(
  io: HoldScanIo,
  directories: readonly string[],
  timeoutMs: number,
  barrierRoot: string | undefined,
): Promise<HolderScan> {
  const escaped = directories.find((directory) =>
    LSOF_ESCAPED_PATH.test(directory),
  );
  if (escaped !== undefined)
    return {
      status: "unknown",
      reason: `${escaped} holds characters lsof prints escaped, so a match against its listing cannot be vouched for`,
    };
  if (io.uid === null || io.runPs === undefined)
    return {
      status: "unknown",
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
      reason: `process ${first.pid} (${first.comm}) runs as the current user, is not a known session helper and has no entries in the lsof listing, so whether it holds a file inside the folder cannot be established${inspection.invisible.length > 1 ? ` (${inspection.invisible.length} such processes)` : ""}`,
    };
  }
  const reachableUser =
    holders.length > 0
      ? undefined
      : inspection.skipped?.find((process) => process.uid !== ROOT_UID);
  if (
    reachableUser !== undefined &&
    !(await hiddenFromOtherUsers(io, directories, barrierRoot))
  )
    return {
      status: "unknown",
      reason: otherUserCanReach(reachableUser.pid, reachableUser.uid),
    };
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
  args: {
    directories: readonly string[];
    timeoutMs?: number;
    hiddenFromOtherUsersBelow?: string;
  },
  io: HoldScanIo = activeHoldIo,
): Promise<HolderScan> {
  if (args.directories.length === 0) {
    return {
      status: "unknown",
      reason: "no directory was named, so nothing can be vouched for",
    };
  }
  if (io.platform === "win32") {
    return {
      status: "unknown",
      reason: "what processes hold open on Windows cannot be listed",
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
  return io.platform === "linux"
    ? scanLinuxHolders(io, directories, args.hiddenFromOtherUsersBelow)
    : scanDarwinHolders(
        io,
        directories,
        args.timeoutMs ?? 30_000,
        args.hiddenFromOtherUsersBelow,
      );
}
