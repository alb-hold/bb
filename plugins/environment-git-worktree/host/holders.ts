import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const LSOF_TIMEOUT_MS = 30_000;
const LINUX_SCAN_CONCURRENCY = 32;

export interface WorktreeHolder {
  pid: number;
  command: string | null;
  through: "working folder" | "open file" | "mapped file";
}

export type WorktreeHolderScan =
  | { status: "clear" }
  | { status: "held"; holders: WorktreeHolder[] }
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

export const UNREADABLE_SAME_USER_HELPER_COMMS: ReadonlySet<string> = new Set([
  "systemd",
  "(sd-pam)",
  "ssh-agent",
  "sshd",
  "sshd-session",
  "gpg-agent",
  "dbus-daemon",
]);

export interface ProcReader {
  readlink(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
}

export const hostProc: ProcReader = {
  readlink: (path) => fs.readlink(path),
  readFile: (path) => fs.readFile(path, "utf8"),
  readdir: (path) => fs.readdir(path),
};

interface ProcessResultUnknown {
  unknown: string;
  vouchable: boolean;
}
type ProcessResult =
  | WorktreeHolder
  | ProcessResultUnknown
  | { otherUser: true }
  | { helper: string }
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

export interface ProcessIdentity {
  uid: number;
  gids: number[];
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

async function scanLinuxProcess(
  proc: ProcReader,
  pid: number,
  directory: string,
  mountNamespace: string,
  self: ProcessIdentity,
): Promise<ProcessResult> {
  const base = `/proc/${pid}`;
  const status = await readOptional(() => proc.readFile(`${base}/status`));
  if ("gone" in status) return null;
  if ("failed" in status)
    return unreadable(`process ${pid} status`, status.failed);
  const uids = parseStatusNumbers(status.value, "Uid");
  if (uids === null || uids[0] === undefined)
    return notVouchable(`process ${pid} owner could not be read`);
  if (/^State:\s+Z/mu.test(status.value)) return null;
  if (self.uid !== 0 && uids[0] !== self.uid) return { otherUser: true };

  const comm = await readOptional(() => proc.readFile(`${base}/comm`));
  const command = "value" in comm ? comm.value.trim() || null : null;
  const result = await scanOwnProcess(
    proc,
    pid,
    base,
    directory,
    mountNamespace,
    command,
  );
  if (
    result !== null &&
    "unknown" in result &&
    result.vouchable &&
    command !== null &&
    UNREADABLE_SAME_USER_HELPER_COMMS.has(command)
  )
    return { helper: command };
  return result;
}

async function scanOwnProcess(
  proc: ProcReader,
  pid: number,
  base: string,
  directory: string,
  mountNamespace: string,
  command: string | null,
): Promise<ProcessResult> {
  const mount = await readOptional(() => proc.readlink(`${base}/ns/mnt`));
  if ("gone" in mount) return null;
  if ("failed" in mount)
    return unreadable(`process ${pid} mount namespace`, mount.failed);
  if (mount.value !== mountNamespace)
    return notVouchable(`process ${pid} runs in a different mount namespace`);
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
      return notVouchable(
        `process ${pid} thread ${task} runs in a different mount namespace`,
      );
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
    const fields = line.split(/\s+/u);
    const permissions = fields[1] ?? "";
    const mapped = fields.slice(5).join(" ");
    if (
      permissions[1] === "w" &&
      permissions[3] === "s" &&
      mapped !== "" &&
      isUnder(mapped, directory)
    ) {
      return { pid, command, through: "mapped file" };
    }
  }
  return null;
}

interface LinuxVisibility {
  problem: string | null;
  mountNamespace: string;
  self: ProcessIdentity;
}

const NO_IDENTITY: ProcessIdentity = { uid: -1, gids: [] };

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
  const self: ProcessIdentity = {
    uid: uids?.[0] ?? -1,
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
      problem: "the process list settings are unreadable",
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
): Promise<WorktreeHolderScan> {
  const visibility = await linuxVisibilityProblem(proc);
  if (visibility.problem !== null) {
    return { status: "unknown", reason: visibility.problem };
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
  for (let offset = 0; offset < pids.length; offset += LINUX_SCAN_CONCURRENCY) {
    const batch = pids.slice(offset, offset + LINUX_SCAN_CONCURRENCY);
    const results = await Promise.all(
      batch.map((pid) =>
        scanLinuxProcess(
          proc,
          pid,
          directory,
          visibility.mountNamespace,
          visibility.self,
        ),
      ),
    );
    for (const result of results) {
      if (result === null) continue;
      if ("otherUser" in result || "helper" in result) continue;
      if ("unknown" in result) unknown.push(result.unknown);
      else holders.push(result);
    }
  }
  if (holders.length > 0) return { status: "held", holders };
  if (unknown.length > 0) {
    return {
      status: "unknown",
      reason: `${unknown.length} processes could not be inspected, such as ${unknown[0]}`,
    };
  }
  return { status: "clear" };
}

function runLsof(directory: string): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  spawnFailed: boolean;
}> {
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
        const code = (error as NodeJS.ErrnoException).code;
        resolve({
          code: typeof code === "number" ? code : null,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
          spawnFailed: typeof code !== "number",
        });
      },
    );
  });
}

async function scanWithLsof(directory: string): Promise<WorktreeHolderScan> {
  const result = await runLsof(directory);
  if (result.spawnFailed) {
    return { status: "unknown", reason: "lsof could not be run" };
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
  return {
    status: "unknown",
    reason: "lsof cannot prove it sees every process",
  };
}

export async function scanWorktreeHolders(
  directory: string,
): Promise<WorktreeHolderScan> {
  if (process.platform === "linux") return scanLinux(directory);
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
