import { Buffer } from "node:buffer";
import { open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  NATIVE_CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES,
  type HostDaemonOnlineRpcResult,
} from "@bb/host-daemon-contract";
import type { CommandOf } from "../command-dispatch-support.js";

interface ReadClaudeTranscriptTailOptions {
  homeDir?: string;
  shellEnv?: Readonly<Record<string, string | undefined>>;
}

function missingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export async function readClaudeTranscriptTail(
  command: CommandOf<"native_terminal.read_claude_transcript_tail">,
  options: ReadClaudeTranscriptTailOptions = {},
): Promise<
  HostDaemonOnlineRpcResult<"native_terminal.read_claude_transcript_tail">
> {
  if (!path.isAbsolute(command.cwd)) {
    throw new Error("Native Claude transcript cwd must be absolute");
  }
  const configuredRoot =
    options.shellEnv?.CLAUDE_CONFIG_DIR ??
    process.env.CLAUDE_CONFIG_DIR ??
    path.join(options.homeDir ?? os.homedir(), ".claude");
  const projectSlug = command.cwd
    .replaceAll("\\", "/")
    .replaceAll("/", "-")
    .replace(/:/gu, "-");
  const transcriptPath = path.join(
    configuredRoot,
    "projects",
    projectSlug,
    `${command.sessionId}.jsonl`,
  );
  try {
    const root = await realpath(configuredRoot);
    const resolvedPath = await realpath(transcriptPath);
    if (!resolvedPath.startsWith(`${root}${path.sep}`)) {
      throw new Error("Native Claude transcript path escaped its config root");
    }
    const file = await open(resolvedPath, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile()) {
        throw new Error("Native Claude transcript is not a regular file");
      }
      const length = Math.min(
        stat.size,
        NATIVE_CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES,
      );
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(
        buffer,
        0,
        length,
        stat.size - length,
      );
      return {
        outcome: "available",
        contentBase64: buffer.subarray(0, bytesRead).toString("base64"),
        sizeBytes: stat.size,
        truncated: stat.size > length,
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (missingFile(error)) return { outcome: "missing" };
    throw error;
  }
}
