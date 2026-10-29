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

function parseLsofOutput(output: string): {
  paths: Array<{ pid: number; path: string }>;
  unreadablePids: number[];
} {
  const paths: Array<{ pid: number; path: string }> = [];
  const unreadablePids: number[] = [];
  let pid: number | null = null;
  let sawDescriptor = false;
  let sawName = false;
  const flush = () => {
    if (pid !== null && sawDescriptor && !sawName) unreadablePids.push(pid);
  };
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    if (line[0] === "p") {
      flush();
      pid = Number(line.slice(1));
      sawDescriptor = false;
      sawName = false;
    } else if (line[0] === "f") {
      sawDescriptor = true;
    } else if (line[0] === "n" && pid !== null) {
      sawName = true;
      paths.push({ pid, path: line.slice(1) });
    }
  }
  flush();
  return { paths, unreadablePids };
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
  const lsofOptions = { maxBuffer: LSOF_MAX_BUFFER };
  let combinedOutput: string;
  try {
    const cwd = await execHostFile(
      "lsof",
      ["-a", "-u", uid, "-d", "cwd", ...lsofFlags],
      lsofOptions,
    );
    const files = await execHostFile(
      "lsof",
      ["-u", uid, ...lsofFlags],
      lsofOptions,
    );
    combinedOutput = `${cwd.stdout}\n${files.stdout}`;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return { supported: false, pids: [], unreadablePids: [] };
    return { supported: false, pids: [], unreadablePids: [] };
  }
  const parsed = parseLsofOutput(combinedOutput);
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
