import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { CommandDispatchError } from "../command-dispatch-support.js";

export const FS_PROBE_DEADLINE_MS = 5000;

export interface FsProbes {
  lstat: (target: string) => Promise<Stats>;
  realpath: (target: string) => Promise<string>;
  deadlineMs: number;
}

const hostProbes: FsProbes = {
  lstat: (target) => fs.lstat(target),
  realpath: (target) => fs.realpath(target),
  deadlineMs: FS_PROBE_DEADLINE_MS,
};

let activeProbes: FsProbes = hostProbes;

export function useFsProbesForTests(override: Partial<FsProbes> | null): void {
  activeProbes =
    override === null ? hostProbes : { ...hostProbes, ...override };
}

function bounded<T>(
  action: string,
  target: string,
  start: (probes: FsProbes) => Promise<T>,
): Promise<T> {
  const probes = activeProbes;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new CommandDispatchError(
          "path_in_use",
          `The filesystem did not answer ${action} for ${target} within ${probes.deadlineMs} ms (a mount may be hung), so the path was not touched and nothing was changed.`,
        ),
      );
    }, probes.deadlineMs);
    start(probes).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function boundedLstat(target: string): Promise<Stats> {
  return bounded("lstat", target, (probes) => probes.lstat(target));
}

export function boundedRealpath(target: string): Promise<string> {
  return bounded("realpath", target, (probes) => probes.realpath(target));
}
