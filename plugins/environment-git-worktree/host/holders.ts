import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const LSOF_TIMEOUT_MS = 30_000;
const LINUX_SCAN_CONCURRENCY = 32;

export interface WorktreeHolder {
  pid: number;
  command: string | null;
  through: "working folder" | "open file";
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

async function readOptional<T>(
  read: () => Promise<T>,
): Promise<{ value: T } | { gone: true } | { failed: string }> {
  try {
    return { value: await read() };
  } catch (error) {
    const code = errorCode(error);
    return code !== null && GONE_CODES.has(code)
      ? { gone: true }
      : { failed: code ?? "unreadable" };
  }
}

async function scanLinuxProcess(
  pid: number,
  directory: string,
): Promise<WorktreeHolder | { unknown: string } | null> {
  const command = await readOptional(() =>
    fs.readFile(`/proc/${pid}/comm`, "utf8"),
  );
  const name = "value" in command ? command.value.trim() || null : null;

  const cwd = await readOptional(() => fs.readlink(`/proc/${pid}/cwd`));
  if ("failed" in cwd) return { unknown: `process ${pid} (${cwd.failed})` };
  if ("value" in cwd && isUnder(cwd.value, directory)) {
    return { pid, command: name, through: "working folder" };
  }

  const descriptors = await readOptional(() => fs.readdir(`/proc/${pid}/fd`));
  if ("failed" in descriptors) {
    return { unknown: `process ${pid} (${descriptors.failed})` };
  }
  if ("gone" in descriptors) return null;
  for (const descriptor of descriptors.value) {
    const target = await readOptional(() =>
      fs.readlink(`/proc/${pid}/fd/${descriptor}`),
    );
    if ("failed" in target) {
      return { unknown: `process ${pid} (${target.failed})` };
    }
    if ("value" in target && isUnder(target.value, directory)) {
      return { pid, command: name, through: "open file" };
    }
  }
  return null;
}

async function scanLinux(directory: string): Promise<WorktreeHolderScan> {
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

function isPrivileged(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
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
  if (result.code === 1 && result.stdout === "" && result.stderr === "") {
    return isPrivileged()
      ? { status: "clear" }
      : {
          status: "unknown",
          reason:
            "lsof lists only your own processes without administrator rights",
        };
  }
  if (result.code !== 0 || result.stderr !== "") {
    return { status: "unknown", reason: "lsof did not finish cleanly" };
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
  return isPrivileged()
    ? { status: "clear" }
    : {
        status: "unknown",
        reason:
          "lsof lists only your own processes without administrator rights",
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
