import { readdir, readFile, readlink } from "node:fs/promises";
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
  return { status: "ok", cwds, skipped, helpers, invisible, rows };
}
