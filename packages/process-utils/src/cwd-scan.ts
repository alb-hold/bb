import { readdir, readFile, readlink, stat } from "node:fs/promises";
import path from "node:path";
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
  realUid(pid: number): Promise<number>;
  effectiveUid(pid: number): Promise<number>;
  realGid(pid: number): Promise<number>;
  effectiveGid(pid: number): Promise<number>;
  filesystemUid(pid: number): Promise<number>;
  filesystemGid?(pid: number): Promise<number>;
  effectiveCapabilities?(pid: number): Promise<bigint>;
  statAccess?(path: string): Promise<{ uid: number; mode: number }>;
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

export function parseFilesystemUid(status: string): number {
  const line = /^Uid:\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/mu.exec(status);
  if (line === null)
    throw Object.assign(new Error("no Uid line"), { code: "EINVAL" });
  return Number(line[4]);
}

export function parseEffectiveUid(status: string): number {
  const line = /^Uid:\s*(\d+)\s+(\d+)/mu.exec(status);
  if (line === null)
    throw Object.assign(new Error("no Uid line"), { code: "EINVAL" });
  return Number(line[2]);
}

export function parseRealUid(status: string): number {
  const line = /^Uid:\s*(\d+)/mu.exec(status);
  if (line === null)
    throw Object.assign(new Error("no Uid line"), { code: "EINVAL" });
  return Number(line[1]);
}

export function parseFilesystemGid(status: string): number {
  const line = /^Gid:\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/mu.exec(status);
  if (line === null)
    throw Object.assign(new Error("no Gid line"), { code: "EINVAL" });
  return Number(line[4]);
}

export function parseRealGid(status: string): number {
  const line = /^Gid:\s*(\d+)/mu.exec(status);
  if (line === null)
    throw Object.assign(new Error("no Gid line"), { code: "EINVAL" });
  return Number(line[1]);
}

export function parseEffectiveGid(status: string): number {
  const line = /^Gid:\s*(\d+)\s+(\d+)/mu.exec(status);
  if (line === null)
    throw Object.assign(new Error("no Gid line"), { code: "EINVAL" });
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
  realUid: async (pid) =>
    parseRealUid(await readFile(`/proc/${pid}/status`, "utf8")),
  effectiveUid: async (pid) =>
    parseEffectiveUid(await readFile(`/proc/${pid}/status`, "utf8")),
  realGid: async (pid) =>
    parseRealGid(await readFile(`/proc/${pid}/status`, "utf8")),
  effectiveGid: async (pid) =>
    parseEffectiveGid(await readFile(`/proc/${pid}/status`, "utf8")),
  filesystemUid: async (pid) =>
    parseFilesystemUid(await readFile(`/proc/${pid}/status`, "utf8")),
  filesystemGid: async (pid) =>
    parseFilesystemGid(await readFile(`/proc/${pid}/status`, "utf8")),
  effectiveCapabilities: async (pid) => {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const capabilities = /^CapEff:\s*([0-9a-f]+)/imu.exec(status)?.[1];
    if (capabilities === undefined)
      throw Object.assign(new Error("no CapEff line"), { code: "EINVAL" });
    return BigInt(`0x${capabilities}`);
  },
  statAccess: async (path) => {
    const info = await stat(path);
    return { uid: info.uid, mode: info.mode };
  },
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

export function cwdScanIoDescendantsOnly(
  base: CwdScanIo,
  rootPid: number,
): CwdScanIo {
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

async function foreignUidCanReachTarget(args: {
  pid: number;
  uid: number;
  directories: readonly string[];
  io: CwdScanIo;
}): Promise<boolean | null> {
  if (
    args.io.effectiveCapabilities === undefined ||
    args.io.statAccess === undefined
  )
    return null;
  let capabilities: bigint;
  try {
    capabilities = await args.io.effectiveCapabilities(args.pid);
  } catch (error) {
    return GONE.has(codeOf(error)) ? false : null;
  }
  if ((capabilities & ((1n << 1n) | (1n << 2n))) !== 0n) return true;
  for (const directory of args.directories) {
    let cursor = directory;
    while (true) {
      let access: { uid: number; mode: number };
      try {
        access = await args.io.statAccess(cursor);
      } catch (error) {
        if (GONE.has(codeOf(error))) break;
        return null;
      }
      const permissions = access.mode & 0o777;
      const canSearch =
        access.uid === args.uid
          ? (permissions & 0o100) !== 0
          : (permissions & 0o011) !== 0;
      if (!canSearch) break;
      const parent = path.dirname(cursor);
      if (parent === cursor) return true;
      cursor = parent;
    }
  }
  return false;
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
    let filesystemUid = io.uid;
    if (io.uid !== null) {
      try {
        filesystemUid = await io.filesystemUid(io.selfPid);
      } catch (error) {
        if (!GONE.has(codeOf(error)))
          return {
            status: "unknown",
            reason: "the filesystem owner of this process could not be read",
          };
      }
    }
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
        if (filesystemUid !== null) {
          let owner: number;
          try {
            owner = await io.filesystemUid(pid);
          } catch (ownerError) {
            if (GONE.has(codeOf(ownerError))) continue;
            return {
              status: "unknown",
              reason: `the owner of process ${pid} could not be read`,
            };
          }
          if (owner !== filesystemUid) {
            if (owner < 1000 && filesystemUid !== 0) {
              excluded += 1;
              skippedOtherUsers.push({
                pid,
                uid: owner,
                errno: code || "error",
              });
              continue;
            }
            const reachable = await foreignUidCanReachTarget({
              pid,
              uid: owner,
              directories,
              io,
            });
            if (reachable === null) {
              return {
                status: "unknown",
                reason: `the reachability of foreign process ${pid} could not be determined`,
              };
            }
            if (!reachable) {
              excluded += 1;
              skippedOtherUsers.push({
                pid,
                uid: owner,
                errno: code || "error",
              });
              continue;
            }
            return {
              status: "unknown",
              reason: `foreign process ${pid} cwd is unreadable and may be inside a target directory`,
            };
          }
          if (code === "EACCES" || code === "EPERM") {
            let realUid: number;
            let effectiveUid: number;
            let realGid: number;
            let effectiveGid: number;
            let processFilesystemGid: number;
            try {
              realUid = await io.realUid(pid);
              effectiveUid = await io.effectiveUid(pid);
              realGid = await io.realGid(pid);
              effectiveGid = await io.effectiveGid(pid);
              if (io.filesystemGid === undefined)
                throw Object.assign(new Error("no filesystem GID reader"), {
                  code: "EINVAL",
                });
              processFilesystemGid = await io.filesystemGid(pid);
            } catch (identityError) {
              if (GONE.has(codeOf(identityError))) continue;
              return {
                status: "unknown",
                reason: `the effective owner of process ${pid} could not be read`,
              };
            }
            if (
              realUid !== filesystemUid ||
              effectiveUid !== filesystemUid ||
              realGid !== processFilesystemGid ||
              effectiveGid !== processFilesystemGid
            ) {
              return {
                status: "unknown",
                reason: `process ${pid} has credentials that differ from its filesystem UID and its cwd is unreadable`,
              };
            }
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
      unvouchedHelpers: [],
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
      reason: `the working directory of process ${first.pid} (${first.comm}) runs as the current user but could not be established from the lsof listing${inspection.invisible.length > 1 ? ` (${inspection.invisible.length} such processes)` : ""}`,
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

export type CwdProcessClass =
  | "readable"
  | "unreadable-same-uid"
  | "skipped-other-uid";

export type DarwinInspection =
  | { status: "unknown"; reason: string }
  | {
      status: "ok";
      cwds: Map<number, string>;
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
    output = await io.runLsof(timeoutMs);
  } catch (error) {
    return {
      status: "unknown",
      reason: `lsof failed (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (output.code !== 0 && output.code !== 1) {
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
  let pid: number | null = null;
  for (const line of output.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null) cwds.set(pid, line.slice(1));
  }
  if (listed === null || io.uid === null)
    return {
      status: "ok",
      cwds,
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
    if (row.uid !== io.uid && io.uid !== 0) {
      skipped.push({ pid: row.pid, uid: row.uid, errno: "other-euid" });
      rows.push({ ...row, klass: "skipped-other-uid" });
    } else if (cwds.has(row.pid)) {
      rows.push({ ...row, klass: "readable" });
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
  return { status: "ok", cwds, skipped, helpers, invisible, rows };
}
