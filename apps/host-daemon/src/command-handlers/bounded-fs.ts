import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { CommandDispatchError } from "../command-dispatch-support.js";

export const FS_PROBE_DEADLINE_MS = 5000;
export const MAX_OUTSTANDING_FS_PROBES = 3;

export interface FsProbes {
  lstat: (target: string) => Promise<Stats>;
  realpath: (target: string) => Promise<string>;
  deadlineMs: number;
  maxOutstanding: number;
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
  maxOutstanding: MAX_OUTSTANDING_FS_PROBES,
};

let activeProbes: FsProbes = hostProbes;
const pending = new Map<string, PendingProbe>();

export function useFsProbesForTests(override: Partial<FsProbes> | null): void {
  activeProbes =
    override === null ? hostProbes : { ...hostProbes, ...override };
  pending.clear();
}

function refusal(action: string, target: string, why: string): Error {
  return new CommandDispatchError(
    "path_in_use",
    `Refusing ${action} for ${target}: ${why}, so the path was not touched and nothing was changed.`,
  );
}

function admissionRefusal(action: string, target: string): Error | null {
  for (const entry of pending.values())
    if (entry.stranded && entry.target === target)
      return refusal(
        action,
        target,
        "an earlier check of this path is still waiting on the filesystem (a mount may be hung)",
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
  const refused = admissionRefusal(action, target);
  if (refused !== null) return Promise.reject(refused);
  const joined = pending.get(key);
  if (joined !== undefined) return joined.settled as Promise<T>;
  if (pending.size >= probes.maxOutstanding)
    return Promise.reject(
      refusal(
        action,
        target,
        `${pending.size} filesystem checks are already outstanding (a mount may be hung) and new path checks wait until they settle`,
      ),
    );
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
