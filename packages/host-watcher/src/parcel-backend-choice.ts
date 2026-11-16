import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type { ParcelWatcherSubscribeOptions } from "./parcel-watcher-backend.js";

const WATCHMAN_PROBE_TIMEOUT_MS = 10_000;
const WATCHMAN_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

function executableOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): boolean {
  if (env.PATH === undefined) return false;
  for (const entry of env.PATH.split(path.delimiter)) {
    const candidate = path.join(path.resolve(cwd, entry || "."), name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function withPlatformParcelBackend(
  opts: ParcelWatcherSubscribeOptions,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ParcelWatcherSubscribeOptions {
  if (opts?.backend !== undefined) return opts;
  if (platform === "darwin") return { ...opts, backend: "fs-events" };
  if (platform !== "linux") return opts;
  if (executableOnPath("watchman", env, cwd)) return opts;
  return { ...opts, backend: "inotify" };
}

function hasSockname(output: string): boolean {
  try {
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed !== "object" || parsed === null) return false;
    if (!("sockname" in parsed)) return false;
    return typeof parsed.sockname === "string" && parsed.sockname !== "";
  } catch {
    return false;
  }
}

function watchmanAnswers(
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let stopped = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (answer: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    let child: ChildProcessByStdio<null, Readable, null>;
    try {
      child = spawn("/bin/sh", ["-c", "watchman get-sockname"], {
        env,
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(false);
      return;
    }
    const stop = () => {
      if (stopped || child.pid === undefined) return;
      stopped = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    const timer = setTimeout(stop, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > WATCHMAN_PROBE_MAX_OUTPUT_BYTES) stop();
      else chunks.push(chunk);
    });
    child.on("error", () => finish(false));
    child.on("exit", () => {
      if (stopped) finish(false);
    });
    child.on("close", (code) => {
      finish(
        !stopped &&
          code === 0 &&
          hasSockname(Buffer.concat(chunks).toString("utf8")),
      );
    });
  });
}

const probes = new Map<string, Promise<boolean>>();

export async function choosePlatformParcelBackend(
  opts: ParcelWatcherSubscribeOptions,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  probeTimeoutMs: number = WATCHMAN_PROBE_TIMEOUT_MS,
): Promise<ParcelWatcherSubscribeOptions> {
  const chosen = withPlatformParcelBackend(opts, platform, env, cwd);
  if (platform !== "linux" || chosen?.backend !== undefined) return chosen;
  if (env.WATCHMAN_SOCK !== undefined && env.WATCHMAN_SOCK !== "")
    return chosen;
  const key = JSON.stringify([env.PATH, cwd]);
  let probe = probes.get(key);
  if (probe === undefined) {
    probe = watchmanAnswers(env, cwd, probeTimeoutMs);
    probes.set(key, probe);
  }
  if (await probe) return chosen;
  return { ...opts, backend: "inotify" };
}
