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

type ProcessResult = WorktreeHolder | { unknown: string } | null;

async function checkLink(
  pid: number,
  name: string,
  link: string,
  directory: string,
  through: WorktreeHolder["through"],
  command: string | null,
): Promise<ProcessResult> {
  const target = await readOptional(() => fs.readlink(link));
  if ("failed" in target)
    return { unknown: `process ${pid} ${name} (${target.failed})` };
  if ("value" in target && isUnder(target.value, directory)) {
    return { pid, command, through };
  }
  return null;
}

async function scanLinuxProcess(
  pid: number,
  directory: string,
): Promise<ProcessResult> {
  const base = `/proc/${pid}`;
  const comm = await readOptional(() => fs.readFile(`${base}/comm`, "utf8"));
  const command = "value" in comm ? comm.value.trim() || null : null;

  const tasks = await readOptional(() => fs.readdir(`${base}/task`));
  if ("gone" in tasks) return null;
  if ("failed" in tasks)
    return { unknown: `process ${pid} tasks (${tasks.failed})` };
  for (const task of tasks.value) {
    const found = await checkLink(
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
    pid,
    "program",
    `${base}/exe`,
    directory,
    "open file",
    command,
  );
  if (exe !== null) return exe;

  const descriptors = await readOptional(() => fs.readdir(`${base}/fd`));
  if ("gone" in descriptors) return null;
  if ("failed" in descriptors) {
    return { unknown: `process ${pid} open files (${descriptors.failed})` };
  }
  for (const descriptor of descriptors.value) {
    const found = await checkLink(
      pid,
      "open file",
      `${base}/fd/${descriptor}`,
      directory,
      "open file",
      command,
    );
    if (found !== null) return found;
  }

  const maps = await readOptional(() => fs.readFile(`${base}/maps`, "utf8"));
  if ("gone" in maps) return null;
  if ("failed" in maps)
    return { unknown: `process ${pid} memory maps (${maps.failed})` };
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

async function linuxVisibilityProblem(): Promise<string | null> {
  const own = await readOptional(() => fs.readlink("/proc/self/ns/pid"));
  const init = await readOptional(() => fs.readlink("/proc/1/ns/pid"));
  if (!("value" in own) || !("value" in init) || own.value !== init.value) {
    return "this process may not see every process (it runs in a separate process namespace)";
  }
  const mounts = await readOptional(() =>
    fs.readFile("/proc/self/mountinfo", "utf8"),
  );
  if (!("value" in mounts)) return "the process list settings are unreadable";
  for (const line of mounts.value.split("\n")) {
    const fields = line.split(" ");
    if (fields[4] !== "/proc") continue;
    const options = line.slice(line.indexOf(" - ") + 3);
    const hidepid = /hidepid=([^,\s]+)/u.exec(options);
    if (hidepid !== null && hidepid[1] !== "0" && hidepid[1] !== "off") {
      return "the process list is hidden from this user";
    }
  }
  return null;
}

async function scanLinux(directory: string): Promise<WorktreeHolderScan> {
  const problem = await linuxVisibilityProblem();
  if (problem !== null) return { status: "unknown", reason: problem };
  const listing = await readOptional(() => fs.readdir("/proc"));
  if (!("value" in listing)) {
    return { status: "unknown", reason: "the process list is unreadable" };
  }
  const pids = listing.value
    .filter((entry) => /^\d+$/u.test(entry))
    .map(Number)
    .filter((pid) => pid !== process.pid);
  const holders: WorktreeHolder[] = [];
  const unknown: string[] = [];
  for (let offset = 0; offset < pids.length; offset += LINUX_SCAN_CONCURRENCY) {
    const batch = pids.slice(offset, offset + LINUX_SCAN_CONCURRENCY);
    const results = await Promise.all(
      batch.map((pid) => scanLinuxProcess(pid, directory)),
    );
    for (const result of results) {
      if (result === null) continue;
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
