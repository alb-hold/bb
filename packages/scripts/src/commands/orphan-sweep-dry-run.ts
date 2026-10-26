import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  isRawThreadId,
  listThreadStorageIds,
  threadIdOfWorktreeFolder,
  withoutThreadRows,
} from "@bb/domain";
import {
  scanProcessesHoldingUnder,
  type HolderBlocker,
  type HolderScan,
} from "@bb/process-utils";
import { runMainIfEntrypoint } from "../lib/script-entry.js";

const MIN_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface OrphanSweepDryRunOptions {
  dataDir: string;
  head: string | null;
  limit: number;
  output: string;
  threadIdsFile: string;
}

type Population = "thread-storage" | "worktree";

interface Candidate {
  directory: string;
  name: string;
  population: Population;
}

interface BlockerDescription extends HolderBlocker {
  comm: string | null;
}

interface FolderVerdict {
  kind: "folder";
  population: Population;
  name: string;
  directory: string;
  ageDays: number | null;
  verdict: "clear" | "held" | "unknown";
  oldEnough: boolean;
  code: string | null;
  reason: string | null;
  holders: { pid: number; comm: string | null; through: string }[];
  blocker: BlockerDescription | null;
}

export function parseOrphanSweepDryRunArgs(
  argv: readonly string[],
): OrphanSweepDryRunOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined)
      throw new Error(`unexpected argument ${flag ?? ""}`);
    values.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) throw new Error(`${flag} is required`);
    return value;
  };
  const limit = Number(values.get("--limit") ?? "0");
  if (!Number.isInteger(limit) || limit < 0)
    throw new Error("--limit must be a whole number, 0 for every folder");
  return {
    dataDir: resolve(required("--data-dir")),
    head: values.get("--head") ?? null,
    limit,
    output: resolve(required("--output")),
    threadIdsFile: resolve(required("--thread-ids")),
  };
}

export function readThreadIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const [index, line] of text.split("\n").entries()) {
    if (line === "") continue;
    if (!isRawThreadId(line))
      throw new Error(`line ${index + 1} is not a thread id: ${line}`);
    ids.add(line);
  }
  return ids;
}

function directoryEntries(
  root: string,
): { name: string; kind: string }[] | null {
  try {
    return readdirSync(root, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? "directory" : "other",
    }));
  } catch {
    return null;
  }
}

interface Selection {
  candidates: Candidate[];
  unclassifiedWorktreeFolders: number;
  totals: {
    storageFolders: number;
    threadNamedStorageFolders: number;
    worktreeFolders: number;
    threadNamedWorktreeFolders: number;
  };
}

export function selectCandidates(
  dataDir: string,
  idsWithRows: ReadonlySet<string>,
): Selection {
  const candidates: Candidate[] = [];
  const storageRoot = join(dataDir, "thread-storage");
  const storageEntries = directoryEntries(storageRoot) ?? [];
  const threadNamedStorage = listThreadStorageIds(storageEntries);
  for (const name of withoutThreadRows(threadNamedStorage, idsWithRows))
    candidates.push({
      directory: join(storageRoot, name),
      name,
      population: "thread-storage",
    });
  const worktreesRoot = join(
    dataDir,
    "plugins",
    "environment-git-worktree",
    "host-data",
    "worktrees",
  );
  let unclassifiedWorktreeFolders = 0;
  const worktreeEntries = (directoryEntries(worktreesRoot) ?? []).filter(
    (folder) => folder.kind === "directory",
  );
  for (const folder of worktreeEntries) {
    const threadId = threadIdOfWorktreeFolder(folder.name);
    if (threadId === null) {
      unclassifiedWorktreeFolders += 1;
      continue;
    }
    if (idsWithRows.has(threadId)) continue;
    const folderPath = join(worktreesRoot, folder.name);
    for (const repository of directoryEntries(folderPath) ?? []) {
      if (repository.kind === "directory")
        candidates.push({
          directory: join(folderPath, repository.name),
          name: `${folder.name}/${repository.name}`,
          population: "worktree",
        });
    }
  }
  return {
    candidates,
    unclassifiedWorktreeFolders,
    totals: {
      storageFolders: storageEntries.filter(
        (entry) => entry.kind === "directory",
      ).length,
      threadNamedStorageFolders: threadNamedStorage.length,
      worktreeFolders: worktreeEntries.length,
      threadNamedWorktreeFolders:
        worktreeEntries.length - unclassifiedWorktreeFolders,
    },
  };
}

function commOf(pid: number): string | null {
  try {
    if (process.platform === "linux")
      return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    return (
      execFileSync("ps", ["-o", "comm=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 10_000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function describeVerdict(
  candidate: Candidate,
  scan: HolderScan,
  now: number,
): FolderVerdict {
  let ageDays: number | null = null;
  try {
    ageDays = (now - lstatSync(candidate.directory).mtimeMs) / DAY_MS;
  } catch {
    ageDays = null;
  }
  const base = {
    kind: "folder" as const,
    population: candidate.population,
    name: candidate.name,
    directory: candidate.directory,
    ageDays,
    oldEnough: ageDays !== null && ageDays >= MIN_AGE_DAYS,
  };
  if (scan.status === "held")
    return {
      ...base,
      verdict: "held",
      code: null,
      reason: null,
      holders: scan.holders.map((holder) => ({
        pid: holder.pid,
        comm: commOf(holder.pid),
        through: holder.through,
      })),
      blocker: null,
    };
  if (scan.status === "unknown")
    return {
      ...base,
      verdict: "unknown",
      code: scan.code,
      reason: scan.reason,
      holders: [],
      blocker:
        scan.blocker === undefined
          ? null
          : { ...scan.blocker, comm: commOf(scan.blocker.pid) },
    };
  return {
    ...base,
    verdict: "clear",
    code: null,
    reason: null,
    holders: [],
    blocker: null,
  };
}

function evenlySpaced<Item>(items: readonly Item[], limit: number): Item[] {
  if (limit === 0 || items.length <= limit) return [...items];
  const step = items.length / limit;
  return Array.from({ length: limit }, (_, index) => {
    const item = items[Math.floor(index * step)];
    if (item === undefined) throw new Error("sampling went out of range");
    return item;
  });
}

export async function runOrphanSweepDryRun(
  options: OrphanSweepDryRunOptions,
): Promise<void> {
  const startedAt = new Date();
  const threadIdsText = readFileSync(options.threadIdsFile, "utf8");
  const idsWithRows = readThreadIds(threadIdsText);
  const descriptor = openSync(options.output, "wx");
  const write = (record: object): void => {
    writeSync(descriptor, `${JSON.stringify(record)}\n`);
  };
  try {
    const { candidates, unclassifiedWorktreeFolders, totals } =
      selectCandidates(options.dataDir, idsWithRows);
    const scanned = evenlySpaced(candidates, options.limit);
    write({
      kind: "header",
      command: process.argv.join(" "),
      cwd: process.cwd(),
      head: options.head,
      startedAt: startedAt.toISOString(),
      node: process.version,
      platform: process.platform,
      uid: process.geteuid?.() ?? null,
      dataDir: options.dataDir,
      threadIdsFile: options.threadIdsFile,
      threadIdsCount: idsWithRows.size,
      threadIdsSha256: createHash("sha256").update(threadIdsText).digest("hex"),
      candidates: candidates.length,
      scanned: scanned.length,
      unclassifiedWorktreeFolders,
      totals,
    });
    const verdicts: FolderVerdict[] = [];
    for (const candidate of scanned) {
      const scan = await scanProcessesHoldingUnder({
        directories: [candidate.directory],
      });
      const verdict = describeVerdict(candidate, scan, Date.now());
      verdicts.push(verdict);
      write(verdict);
    }
    const tally = new Map<string, number>();
    const samples = new Map<string, string>();
    const blockers = new Map<string, number>();
    for (const verdict of verdicts) {
      const key =
        verdict.verdict === "unknown"
          ? `unknown:${verdict.code}`
          : verdict.verdict;
      tally.set(key, (tally.get(key) ?? 0) + 1);
      if (!samples.has(key)) samples.set(key, verdict.directory);
      if (verdict.blocker !== null) {
        const who = `${key} pid=${verdict.blocker.pid} uid=${verdict.blocker.uid} comm=${verdict.blocker.comm} namespace=${verdict.blocker.namespace}`;
        blockers.set(who, (blockers.get(who) ?? 0) + 1);
      }
    }
    write({
      kind: "summary",
      candidates: candidates.length,
      scanned: scanned.length,
      byPopulation: Object.fromEntries(
        (["thread-storage", "worktree"] as const).map((population) => [
          population,
          candidates.filter((candidate) => candidate.population === population)
            .length,
        ]),
      ),
      clearAndOldEnough: verdicts.filter(
        (verdict) => verdict.verdict === "clear" && verdict.oldEnough,
      ).length,
      unclassifiedWorktreeFolders,
      verdicts: Object.fromEntries(tally),
      samples: Object.fromEntries(samples),
      blockers: Object.fromEntries(blockers),
      finishedAt: new Date().toISOString(),
      exit: 0,
    });
  } catch (error) {
    write({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
      finishedAt: new Date().toISOString(),
      exit: 1,
    });
    throw error;
  } finally {
    closeSync(descriptor);
  }
}

async function main(): Promise<void> {
  const options = parseOrphanSweepDryRunArgs(process.argv.slice(2));
  await runOrphanSweepDryRun(options);
  process.stderr.write(`wrote ${options.output}\n`);
}

runMainIfEntrypoint(import.meta.url, main);
