import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isPathWithinDirectory } from "@bb/process-utils";
import { CommandDispatchError } from "../command-dispatch-support.js";

export const FS_PROBE_DEADLINE_MS = 5000;
export const MAX_STRANDED_FS_PROBES = 2;

export interface FsProbes {
  lstat: (target: string) => Promise<Stats>;
  realpath: (target: string) => Promise<string>;
  deadlineMs: number;
  maxStranded: number;
}

interface PendingProbe {
  target: string;
  stranded: boolean;
  settled: Promise<unknown>;
}

const hostProbes: FsProbes = {
  lstat: (target) => fs.lstat(target),
  realpath: (target) => fs.realpath(target),
  deadlineMs: FS_PROBE_DEADLINE_MS,
  maxStranded: MAX_STRANDED_FS_PROBES,
};

let activeProbes: FsProbes = hostProbes;
const pending = new Map<string, PendingProbe>();

export function useFsProbesForTests(override: Partial<FsProbes> | null): void {
  activeProbes =
    override === null ? hostProbes : { ...hostProbes, ...override };
  pending.clear();
}

function sharesMountNeighbourhood(left: string, right: string): boolean {
  return (
    path.dirname(left) === path.dirname(right) ||
    isPathWithinDirectory(left, right) ||
    isPathWithinDirectory(right, left)
  );
}

function strandedCount(): number {
  let count = 0;
  for (const entry of pending.values()) if (entry.stranded) count += 1;
  return count;
}

function refusal(action: string, target: string, why: string): Error {
  return new CommandDispatchError(
    "path_in_use",
    `Refusing ${action} for ${target}: ${why}, so the path was not touched and nothing was changed.`,
  );
}

function admissionRefusal(
  action: string,
  target: string,
  probes: FsProbes,
): Error | null {
  for (const entry of pending.values())
    if (entry.stranded && entry.target === target)
      return refusal(
        action,
        target,
        "an earlier check of this path is still waiting on the filesystem (a mount may be hung)",
      );
  if (strandedCount() < probes.maxStranded) return null;
  for (const entry of pending.values())
    if (entry.stranded && sharesMountNeighbourhood(target, entry.target))
      return refusal(
        action,
        target,
        `${probes.maxStranded} filesystem checks nearby are already stuck (a mount may be hung)`,
      );
  return null;
}

function bounded<T>(
  action: string,
  target: string,
  start: (probes: FsProbes) => Promise<T>,
): Promise<T> {
  const probes = activeProbes;
  const key = `${action}\0${target}`;
  const refused = admissionRefusal(action, target, probes);
  if (refused !== null) return Promise.reject(refused);
  const joined = pending.get(key);
  if (joined !== undefined) return joined.settled as Promise<T>;
  const entry: PendingProbe = {
    target,
    stranded: false,
    settled: Promise.resolve(),
  };
  pending.set(key, entry);
  const release = () => {
    if (pending.get(key) === entry) pending.delete(key);
  };
  const outcome = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.stranded = true;
      reject(
        new CommandDispatchError(
          "path_in_use",
          `The filesystem did not answer ${action} for ${target} within ${probes.deadlineMs} ms (a mount may be hung), so the path was not touched and nothing was changed.`,
        ),
      );
    }, probes.deadlineMs);
    let started: Promise<T>;
    try {
      started = start(probes);
    } catch (error) {
      clearTimeout(timer);
      release();
      reject(error);
      return;
    }
    started.then(
      (value) => {
        clearTimeout(timer);
        release();
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        release();
        reject(error);
      },
    );
  });
  entry.settled = outcome;
  return outcome;
}

export function boundedLstat(target: string): Promise<Stats> {
  return bounded("lstat", target, (probes) => probes.lstat(target));
}

export function boundedRealpath(target: string): Promise<string> {
  return bounded("realpath", target, (probes) => probes.realpath(target));
}
