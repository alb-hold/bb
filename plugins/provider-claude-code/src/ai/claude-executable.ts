import fs from "node:fs/promises";
import path from "node:path";
import { experimental_resolveExecutablePath as resolveExecutablePath } from "@get-bb/plugin-sdk/provider-bridge";
import { claudeExecutable } from "../bridge/provider-maintenance.js";

const OTHERS_WRITE = 0o002;
const STICKY = 0o1000;
const MAX_LINK_HOPS = 40;

export type ClaudeExecutableCheck =
  | { ok: true; path: string }
  | { ok: false; message: string };

export interface ClaudeExecutableCheckDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number | null;
  defaultExecutable: () => Promise<string>;
  resolve: (command: string) => Promise<string | null>;
}

function defaultDeps(): ClaudeExecutableCheckDeps {
  return {
    env: process.env,
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    defaultExecutable: claudeExecutable,
    resolve: resolveExecutablePath,
  };
}

function withParents(dir: string, into: Set<string>): void {
  for (let current = dir; ; current = path.dirname(current)) {
    into.add(current);
    if (path.dirname(current) === current) return;
  }
}

async function untrustedReason(
  file: string,
  uid: number | null,
): Promise<string | null> {
  const checked = new Set<string>();
  let current = file;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
    withParents(path.dirname(current), checked);
    withParents(await fs.realpath(path.dirname(current)), checked);
    const link = await fs.lstat(current);
    if (!link.isSymbolicLink()) break;
    current = path.resolve(path.dirname(current), await fs.readlink(current));
  }
  const real = await fs.realpath(file);
  checked.add(real);
  withParents(path.dirname(real), checked);
  for (const entry of checked) {
    const stat = await fs.stat(entry);
    if (uid !== null && stat.uid !== uid && stat.uid !== 0) {
      return `${entry} belongs to another account`;
    }
    const othersWrite = (stat.mode & OTHERS_WRITE) !== 0;
    const sticky = stat.isDirectory() && (stat.mode & STICKY) !== 0;
    if (othersWrite && !sticky) {
      return `any account can change ${entry}`;
    }
  }
  if (!(await fs.stat(real)).isFile()) return `${real} is not a file`;
  return null;
}

export async function trustedClaudeExecutable(
  deps: ClaudeExecutableCheckDeps = defaultDeps(),
): Promise<ClaudeExecutableCheck> {
  const override = deps.env.BB_CLAUDE_CODE_EXECUTABLE?.trim();
  let candidate: string;
  if (override) {
    if (!path.isAbsolute(override)) {
      return {
        ok: false,
        message: `BB_CLAUDE_CODE_EXECUTABLE must be an absolute path for writing assistance, not ${override}`,
      };
    }
    candidate = override;
  } else {
    const chosen = await deps.defaultExecutable();
    const resolved = path.isAbsolute(chosen)
      ? chosen
      : await deps.resolve(chosen);
    if (resolved === null) {
      return {
        ok: false,
        message: "Install Claude Code on the primary machine",
      };
    }
    candidate = resolved;
  }
  if (deps.platform === "win32") return { ok: true, path: candidate };
  try {
    const reason = await untrustedReason(candidate, deps.uid);
    if (reason !== null) {
      return {
        ok: false,
        message: `Writing assistance will not run ${candidate}: ${reason}`,
      };
    }
    return { ok: true, path: await fs.realpath(candidate) };
  } catch {
    return {
      ok: false,
      message: `Writing assistance cannot read ${candidate}. Install Claude Code on the primary machine`,
    };
  }
}
