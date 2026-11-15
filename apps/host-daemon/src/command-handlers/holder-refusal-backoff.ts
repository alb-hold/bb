import fs from "node:fs/promises";
import type { WorktreeHolderScan } from "@bb/process-utils";

export const HOLDER_REFUSAL_FIRST_DELAY_MS = 15_000;
export const HOLDER_REFUSAL_MAX_DELAY_MS = 600_000;
const MAX_REMEMBERED_REFUSALS = 4096;

type DoubtfulScan = Extract<
  WorktreeHolderScan,
  { status: "uncertain" | "unknown" }
>;

export interface HolderRefusal {
  identity: string;
  reason: string;
  blockers: Map<number, string>;
  attempts: number;
  firstRefusedAt: number;
  nextScanAt: number;
}

let clock: () => number = Date.now;
let startReader: (pid: number) => Promise<string | null> = readProcessStart;
const refusals = new Map<string, HolderRefusal>();

export function useHolderRefusalClockForTests(next: (() => number) | null) {
  clock = next ?? Date.now;
}

export function useProcessStartReaderForTests(
  next: ((pid: number) => Promise<string | null>) | null,
) {
  startReader = next ?? readProcessStart;
}

export function resetHolderRefusalsForTests() {
  refusals.clear();
}

export async function directoryIdentity(
  directory: string,
): Promise<string | null> {
  try {
    const info = await fs.lstat(directory, { bigint: true });
    return `${info.dev}:${info.ino}`;
  } catch {
    return null;
  }
}

async function readProcessStart(pid: number): Promise<string | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/u);
    const start = fields[19];
    return start !== undefined && /^\d+$/u.test(start) ? start : null;
  } catch {
    return null;
  }
}

export async function unchangedHolderRefusal(
  directory: string,
  identity: string,
): Promise<HolderRefusal | null> {
  const refusal = refusals.get(directory);
  if (refusal === undefined) return null;
  if (refusal.identity !== identity) {
    refusals.delete(directory);
    return null;
  }
  if (clock() >= refusal.nextScanAt) return null;
  for (const [pid, start] of refusal.blockers) {
    if ((await startReader(pid)) !== start) {
      refusals.delete(directory);
      return null;
    }
  }
  return refusal;
}

export async function recordHolderRefusal(
  directory: string,
  identity: string,
  scan: DoubtfulScan,
): Promise<void> {
  const pids = scan.blockingProcesses ?? [];
  const blockers = new Map<number, string>();
  for (const pid of pids) {
    const start = await startReader(pid);
    if (start === null) {
      refusals.delete(directory);
      return;
    }
    blockers.set(pid, start);
  }
  if (blockers.size === 0) {
    refusals.delete(directory);
    return;
  }
  const previous = refusals.get(directory);
  const sameSet =
    previous !== undefined &&
    previous.identity === identity &&
    previous.blockers.size === blockers.size &&
    [...blockers].every(([pid, start]) => previous.blockers.get(pid) === start);
  const now = clock();
  const attempts = sameSet ? previous.attempts + 1 : 1;
  const delay = Math.min(
    HOLDER_REFUSAL_MAX_DELAY_MS,
    HOLDER_REFUSAL_FIRST_DELAY_MS * 2 ** Math.min(attempts - 1, 16),
  );
  refusals.delete(directory);
  refusals.set(directory, {
    identity,
    reason: scan.reason,
    blockers,
    attempts,
    firstRefusedAt: sameSet ? previous.firstRefusedAt : now,
    nextScanAt: now + delay,
  });
  while (refusals.size > MAX_REMEMBERED_REFUSALS) {
    const oldest = refusals.keys().next().value;
    if (oldest === undefined) break;
    refusals.delete(oldest);
  }
}

export function forgetHolderRefusal(directory: string): void {
  refusals.delete(directory);
}
