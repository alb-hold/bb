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

function stripDeletedSuffix(value: string): string {
  return value.replace(/ \(deleted\)$/, "");
}

function underWorkspace(value: string, workspace: string): boolean {
  const normalized = value.replace(/ \(deleted\)$/, "");
  return [value, normalized].some(
    (candidate) =>
      candidate === workspace || candidate.startsWith(workspace + path.sep),
  );
}

type AncestorResolve =
  | { ok: true; path: string }
  | { ok: false; reason: "missing" | "unreadable" };

const DATA_VOLUME_PREFIX = "/System/Volumes/Data";

const LSOF_NON_FILESYSTEM_TYPES = new Set([
  "unix",
  "IPv4",
  "IPv6",
  "PIPE",
  "KQUEUE",
  "systm",
]);

const LSOF_FILESYSTEM_TYPES = new Set([
  "REG",
  "DIR",
  "LINK",
  "VREG",
  "VDIR",
  "VLINK",
  "FIFO",
  "CHR",
  "BLK",
]);

function isNonFilesystemLsofType(type: string | undefined): boolean {
  return type !== undefined && LSOF_NON_FILESYSTEM_TYPES.has(type);
}

function isKnownFilesystemLsofType(type: string | undefined): boolean {
  return type !== undefined && LSOF_FILESYSTEM_TYPES.has(type);
}

function nonFilesystemEntryIsOutsideWithoutInspection(
  value: string,
  lsofType: string | undefined,
): boolean {
  if (!isNonFilesystemLsofType(lsofType)) return false;
  const normalized = stripDeletedSuffix(value).trim();
  if (normalized.length === 0) return true;
  if (normalized.startsWith("/")) return false;
  if (normalized.startsWith("->")) return true;
  if (/^0x[0-9a-fA-F]+$/.test(normalized)) return true;
  if (lsofType === "unix") return false;
  return true;
}

function isRelativeUnixBindPath(
  value: string,
  lsofType: string | undefined,
): boolean {
  if (lsofType !== "unix") return false;
  const normalized = stripDeletedSuffix(value).trim();
  if (normalized.length === 0) return false;
  if (normalized.startsWith("/")) return false;
  if (normalized.startsWith("->")) return false;
  if (/^0x[0-9a-fA-F]+$/.test(normalized)) return false;
  return true;
}

function relativeUnixBindNeedsUnreadableWithoutCwd(
  value: string,
  lsofType: string | undefined,
): boolean {
  if (!isRelativeUnixBindPath(value, lsofType)) return false;
  return stripDeletedSuffix(value).trim().startsWith("./");
}

function normalizeLsofPathName(value: string): string {
  const stripped = stripDeletedSuffix(value);
  if (!stripped.startsWith("/")) return stripped;
  return path.normalize(stripped);
}

function isSocketStylePathName(value: string): boolean {
  const normalized = stripDeletedSuffix(value);
  if (normalized.startsWith("/")) return false;
  return normalized.startsWith("->") || normalized.includes("->");
}

function lexicalPathNames(value: string, lsofType: string | undefined): string[] {
  const normalized = normalizeLsofPathName(value);
  const names = new Set<string>([normalized]);
  const failClosed =
    lsofType === undefined || !isKnownFilesystemLsofType(lsofType);
  if (failClosed && isSocketStylePathName(value)) {
    const before = normalized.split("->")[0] ?? "";
    if (before.length > 0) names.add(normalizeLsofPathName(before));
  }
  return [...names];
}

function expandPathAliases(value: string): string[] {
  const aliases = new Set<string>([value]);
  if (value.startsWith(DATA_VOLUME_PREFIX + path.sep)) {
    aliases.add(value.slice(DATA_VOLUME_PREFIX.length) || "/");
  } else if (value === DATA_VOLUME_PREFIX) {
    aliases.add("/");
  }
  if (value.startsWith("/private/tmp" + path.sep)) {
    aliases.add("/tmp" + value.slice("/private/tmp".length));
  } else if (value === "/private/tmp") {
    aliases.add("/tmp");
  }
  if (value.startsWith("/tmp" + path.sep)) {
    aliases.add("/private/tmp" + value.slice("/tmp".length));
  } else if (value === "/tmp") {
    aliases.add("/private/tmp");
  }
  if (value.startsWith("/private/var" + path.sep)) {
    aliases.add("/var" + value.slice("/private/var".length));
  } else if (value.startsWith("/var" + path.sep)) {
    aliases.add("/private/var" + value.slice("/var".length));
  }
  return [...aliases];
}

function pathLexicallyCouldBeInWorkspace(
  value: string,
  workspaceCanonical: string,
  workspaceArg: string,
  lsofType?: string,
): boolean {
  if (nonFilesystemEntryIsOutsideWithoutInspection(value, lsofType))
    return false;
  const roots = new Set<string>();
  for (const root of [workspaceCanonical, workspaceArg]) {
    const normalizedRoot = path.normalize(root);
    roots.add(normalizedRoot);
    for (const alias of expandPathAliases(normalizedRoot)) roots.add(alias);
  }
  return lexicalPathNames(value, lsofType).some((name) => {
    if (!name.startsWith("/")) return false;
    return expandPathAliases(name).some((candidate) =>
      [...roots].some(
        (root) =>
          candidate === root || candidate.startsWith(root + path.sep),
      ),
    );
  });
}

async function resolveThroughExistingAncestor(
  value: string,
): Promise<AncestorResolve> {
  let dir = normalizeLsofPathName(value);
  const tail: string[] = [];
  while (true) {
    try {
      const root = await realpath(dir);
      const resolved =
        tail.length === 0 ? root : path.join(root, ...tail.reverse());
      return { ok: true, path: resolved };
    } catch (error) {
      if (!missing(error)) return { ok: false, reason: "unreadable" };
      tail.push(path.basename(dir));
      const parent = path.dirname(dir);
      if (parent === dir) return { ok: false, reason: "missing" };
      dir = parent;
    }
  }
}

async function classifyPathForWorkspace(
  value: string,
  workspaceCanonical: string,
  workspaceArg: string,
  lsofType?: string,
  processCwd?: string,
): Promise<"matched" | "outside" | "unreadable"> {
  if (relativeUnixBindNeedsUnreadableWithoutCwd(value, lsofType))
    return "unreadable";
  let pathName = normalizeLsofPathName(value);
  let bindWasDotRelativeUnix = false;
  if (isRelativeUnixBindPath(value, lsofType)) {
    if (processCwd === undefined) return "unreadable";
    bindWasDotRelativeUnix = stripDeletedSuffix(value).trim().startsWith("./");
    pathName = normalizeLsofPathName(
      path.resolve(processCwd, stripDeletedSuffix(value).trim()),
    );
  }
  if (nonFilesystemEntryIsOutsideWithoutInspection(pathName, lsofType))
    return "outside";
  if (
    !pathLexicallyCouldBeInWorkspace(
      pathName,
      workspaceCanonical,
      workspaceArg,
      lsofType,
    )
  ) {
    if (bindWasDotRelativeUnix) return "unreadable";
    return "outside";
  }
  const ancestor = await resolveThroughExistingAncestor(pathName);
  if (ancestor.ok && underWorkspace(ancestor.path, workspaceCanonical))
    return "matched";
  try {
    if (underWorkspace(await canonicalPath(pathName), workspaceCanonical))
      return "matched";
  } catch {
    undefined;
  }
  return "unreadable";
}

function parseLsofOutput(output: string):
  | {
      ok: true;
      paths: Array<{ pid: number; path: string; type?: string }>;
      unreadablePids: number[];
      cwdByPid: Map<number, string>;
    }
  | { ok: false } {
  const paths: Array<{ pid: number; path: string; type?: string }> = [];
  const unreadablePids: number[] = [];
  const cwdByPid = new Map<number, string>();
  let pid: number | null = null;
  let sawName = false;
  let currentType: string | undefined;
  let currentFd: string | undefined;
  const flush = () => {
    if (pid !== null && !sawName) unreadablePids.push(pid);
  };
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    const tag = line[0];
    if (tag === "p") {
      flush();
      const next = Number(line.slice(1));
      if (!Number.isInteger(next) || next < 0) return { ok: false };
      pid = next;
      sawName = false;
      currentType = undefined;
      currentFd = undefined;
    } else if (tag === "f") {
      currentType = undefined;
      currentFd = line.slice(1);
    } else if (tag === "t") {
      currentType = line.slice(1);
    } else if (tag === "n") {
      if (pid === null) return { ok: false };
      sawName = true;
      const name = line.slice(1);
      if (currentFd === "cwd") cwdByPid.set(pid, name);
      paths.push({ pid, path: name, type: currentType });
      currentFd = undefined;
    } else {
      return { ok: false };
    }
  }
  flush();
  return { ok: true, paths, unreadablePids, cwdByPid };
}

type LsofRun = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

function lsofStderrIsBenign(stderr: string): boolean {
  return stderr.trim().length === 0;
}

export function lsofRunIsTrustworthy(run: LsofRun): boolean {
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
    if (!(error instanceof Error)) return "failed";
    const code =
      "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ENOENT") return "missing";
    const stdout =
      "stdout" in error && typeof error.stdout === "string"
        ? error.stdout
        : "";
    const stderr =
      "stderr" in error && typeof error.stderr === "string"
        ? error.stderr
        : "";
    const exitCode =
      typeof code === "number"
        ? code
        : typeof code === "string" && /^\d+$/.test(code)
          ? Number(code)
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
  const workspaceArg = path.resolve(workspacePath);
  const workspace = await canonicalPath(workspaceArg);
  const uid = String(process.getuid!());
  const lsofFlags = ["-n", "-Fpnt"] as const;
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
  const pathsByPid = new Map<number, Array<{ path: string; type?: string }>>();
  for (const entry of parsed.paths) {
    if (entry.pid === process.pid) continue;
    const bucket = pathsByPid.get(entry.pid);
    const item = { path: entry.path, type: entry.type };
    if (bucket === undefined) pathsByPid.set(entry.pid, [item]);
    else bucket.push(item);
  }
  await Promise.all(
    [...pathsByPid.entries()].map(async ([pid, paths]) => {
      let matched = false;
      for (const { path: value, type } of paths) {
        const processCwd = parsed.cwdByPid.get(pid);
        const kind = await classifyPathForWorkspace(
          value,
          workspace,
          workspaceArg,
          type,
          processCwd === undefined
            ? undefined
            : normalizeLsofPathName(processCwd),
        );
        if (kind === "matched") matched = true;
        else if (kind === "unreadable") unreadablePids.add(pid);
      }
      if (matched) pids.add(pid);
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
