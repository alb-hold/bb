import { readdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  fillNativeTerminalTemplate,
  type ProviderNativeTerminal,
} from "@bb/domain";

export type NativeHarnessEnv = Readonly<Record<string, string | undefined>>;
export type NativeTerminalSessionRoot = ProviderNativeTerminal["sessionRoot"];

function homeDir(env: NativeHarnessEnv, fallback: string): string {
  return env.HOME ?? fallback;
}

export function resolveNativeTerminalSessionRoot(
  sessionRoot: NativeTerminalSessionRoot,
  env: NativeHarnessEnv,
  fallbackHome = os.homedir(),
): string {
  const override = sessionRoot.env === null ? undefined : env[sessionRoot.env];
  return override !== undefined && override.length > 0
    ? override
    : path.join(homeDir(env, fallbackHome), sessionRoot.home);
}

export function resolveNativeTerminalTranscriptPattern(args: {
  env: NativeHarnessEnv;
  fallbackHome?: string;
  sessionId: string;
  sessionRoot: NativeTerminalSessionRoot;
  transcriptPattern: string;
}): { pattern: string; root: string } {
  return {
    root: resolveNativeTerminalSessionRoot(
      args.sessionRoot,
      args.env,
      args.fallbackHome,
    ),
    pattern: fillNativeTerminalTemplate(args.transcriptPattern, {
      sessionId: args.sessionId,
    }),
  };
}

function listDirectory(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function segmentPattern(segment: string): RegExp {
  const source = segment
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`, "u");
}

function segmentsMatch(name: string, pattern: string): boolean {
  return segmentPattern(pattern).test(name);
}

export function expandSessionFiles(root: string, pattern: string): string[] {
  let current = [root];
  for (const segment of pattern.split("/")) {
    if (!segment.includes("*")) {
      current = current.map((dir) => path.join(dir, segment));
      continue;
    }
    current = current.flatMap((dir) =>
      listDirectory(dir)
        .filter((name) => segmentsMatch(name, segment))
        .map((name) => path.join(dir, name)),
    );
  }
  return current.filter(isFile);
}

export async function expandSessionFilesAsync(
  root: string,
  pattern: string,
): Promise<string[]> {
  let current = [root];
  for (const segment of pattern.split("/")) {
    if (!segment.includes("*")) {
      current = current.map((dir) => path.join(dir, segment));
      continue;
    }
    const next = await Promise.all(
      current.map(async (dir) => {
        try {
          return (await readdir(dir))
            .filter((name) => segmentsMatch(name, segment))
            .map((name) => path.join(dir, name));
        } catch {
          return [];
        }
      }),
    );
    current = next.flat();
  }
  const files = await Promise.all(
    current.map(async (filePath) => {
      try {
        return (await stat(filePath)).isFile() ? filePath : null;
      } catch {
        return null;
      }
    }),
  );
  return files.filter((filePath): filePath is string => filePath !== null);
}
