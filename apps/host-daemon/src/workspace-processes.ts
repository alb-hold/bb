import { execHostFile } from "@bb/process-utils";
import { readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";

const LSOF_MAX_BUFFER = 64 * 1024 * 1024;

function missing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ESRCH")
  );
}

async function canonicalPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch (error) {
    if (!missing(error)) throw error;
    const parent = path.dirname(value);
    if (parent === value) throw error;
    return path.join(await canonicalPath(parent), path.basename(value));
  }
}

function underWorkspace(value: string, workspace: string): boolean {
  const normalized = value.replace(/ \(deleted\)$/, "");
  return [value, normalized].some(
    (candidate) =>
      candidate === workspace || candidate.startsWith(workspace + path.sep),
  );
}

function parseLsofOutput(output: string):
  | {
      ok: true;
      paths: Array<{ pid: number; path: string }>;
      unreadablePids: number[];
    }
  | { ok: false } {
  const paths: Array<{ pid: number; path: string }> = [];
  const unreadablePids: number[] = [];
  let pid: number | null = null;
  let sawDescriptor = false;
  let sawName = false;
  const flush = (): boolean => {
    if (pid !== null && sawDescriptor && !sawName) return false;
    return true;
  };
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    const tag = line[0];
    if (tag === "p") {
      if (!flush()) return { ok: false };
      const next = Number(line.slice(1));
      if (!Number.isInteger(next) || next < 0) return { ok: false };
      pid = next;
      sawDescriptor = false;
      sawName = false;
    } else if (tag === "f") {
      if (pid === null) return { ok: false };
      sawDescriptor = true;
    } else if (tag === "n") {
      if (pid === null) return { ok: false };
      sawName = true;
      paths.push({ pid, path: line.slice(1) });
    } else {
      return { ok: false };
    }
  }
  if (!flush()) return { ok: false };
  return { ok: true, paths, unreadablePids };
}

type LsofRun = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

function lsofStderrIsBenign(stderr: string): boolean {
  return stderr.trim().length === 0;
}

function lsofRunIsTrustworthy(run: LsofRun): boolean {
  if (run.exitCode === 0) {
    return lsofStderrIsBenign(run.stderr);
  }
  if (run.exitCode === 1) {
    return run.stdout.length === 0 && lsofStderrIsBenign(run.stderr);
  }
  return false;
}

async function execLsof(
  args: readonly string[],
): Promise<LsofRun | "missing" | "failed"> {
  try {
    const result = await execHostFile("lsof", args, {
      maxBuffer: LSOF_MAX_BUFFER,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return "missing";
    if (!(error instanceof Error)) return "failed";
    const stdout =
      "stdout" in error && typeof error.stdout === "string"
        ? error.stdout
        : "";
    const stderr =
      "stderr" in error && typeof error.stderr === "string"
        ? error.stderr
        : "";
    const exitCode =
      typeof error.code === "number"
        ? error.code
        : typeof error.code === "string" && /^\d+$/.test(error.code)
          ? Number(error.code)
          : -1;
    if (exitCode < 0) return "failed";
    return { stdout, stderr, exitCode };
  }
}

async function inspectLinuxWorkspaceProcesses(
  workspacePath: string,
): Promise<{
  supported: boolean;
  pids: number[];
  unreadablePids: number[];
}> {
  const workspace = await canonicalPath(path.resolve(workspacePath));
  const uid = process.getuid!();
  const pids: number[] = [];
  const unreadablePids: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const directory = `/proc/${entry}`;
    try {
      const status = await readFile(`${directory}/status`, "utf8");
      const uids = status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m);
      if (uids === null) {
        unreadablePids.push(pid);
        continue;
      }
      if (!uids.slice(1).some((value) => Number(value) === uid)) continue;
      if (/^State:\s+[ZX]/m.test(status)) continue;
      const cwd = await readlink(`${directory}/cwd`);
      const maps = await readFile(`${directory}/maps`, "utf8");
      const mappedPaths = maps.split("\n").flatMap((line) => {
        const match = line.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/);
        return match === null ? [] : [match[1]!];
      });
      if (
        underWorkspace(cwd, workspace) ||
        mappedPaths.some((value) =>
          underWorkspace(value, workspace.replace(/\n/g, "\\012")),
        )
      )
        pids.push(pid);
    } catch (error) {
      if (missing(error)) {
        try {
          await stat(directory);
        } catch (gone) {
          if (missing(gone)) continue;
        }
      }
      unreadablePids.push(pid);
    }
  }
  return { supported: true, pids, unreadablePids };
}

async function inspectDarwinWorkspaceProcesses(
  workspacePath: string,
): Promise<{
  supported: boolean;
  pids: number[];
  unreadablePids: number[];
}> {
  const workspace = await canonicalPath(path.resolve(workspacePath));
  const uid = String(process.getuid!());
  const lsofFlags = ["-w", "-n", "-Fpn"] as const;
  const cwdRun = await execLsof([
    "-a",
    "-u",
    uid,
    "-d",
    "cwd",
    ...lsofFlags,
  ]);
  if (cwdRun === "missing" || cwdRun === "failed") {
    return { supported: false, pids: [], unreadablePids: [] };
  }
  if (!lsofRunIsTrustworthy(cwdRun)) {
    return { supported: false, pids: [], unreadablePids: [] };
  }
  const filesRun = await execLsof(["-u", uid, ...lsofFlags]);
  if (filesRun === "missing" || filesRun === "failed") {
    return { supported: false, pids: [], unreadablePids: [] };
  }
  if (!lsofRunIsTrustworthy(filesRun)) {
    return { supported: false, pids: [], unreadablePids: [] };
  }
  const parsed = parseLsofOutput(`${cwdRun.stdout}\n${filesRun.stdout}`);
  if (!parsed.ok) {
    return { supported: false, pids: [], unreadablePids: [] };
  }
  const pids = new Set<number>();
  const unreadablePids = new Set<number>();
  for (const pid of parsed.unreadablePids) {
    if (pid !== process.pid) unreadablePids.add(pid);
  }
  const pathsByPid = new Map<number, string[]>();
  for (const entry of parsed.paths) {
    if (entry.pid === process.pid) continue;
    const bucket = pathsByPid.get(entry.pid);
    if (bucket === undefined) pathsByPid.set(entry.pid, [entry.path]);
    else bucket.push(entry.path);
  }
  await Promise.all(
    [...pathsByPid.entries()].map(async ([pid, paths]) => {
      let inspected = false;
      let matched = false;
      for (const value of paths) {
        try {
          const canonical = await canonicalPath(value);
          inspected = true;
          if (underWorkspace(canonical, workspace)) matched = true;
        } catch (error) {
          if (!missing(error)) unreadablePids.add(pid);
        }
      }
      if (matched) pids.add(pid);
      else if (!inspected && paths.length > 0) unreadablePids.add(pid);
    }),
  );
  return {
    supported: true,
    pids: [...pids].sort((left, right) => left - right),
    unreadablePids: [...unreadablePids].sort((left, right) => left - right),
  };
}

export async function inspectWorkspaceProcesses(
  workspacePath: string,
): Promise<{
  supported: boolean;
  pids: number[];
  unreadablePids: number[];
}> {
  if (process.getuid === undefined)
    return { supported: false, pids: [], unreadablePids: [] };
  if (process.platform === "linux")
    return inspectLinuxWorkspaceProcesses(workspacePath);
  if (process.platform === "darwin")
    return inspectDarwinWorkspaceProcesses(workspacePath);
  return { supported: false, pids: [], unreadablePids: [] };
}
