import { Buffer } from "node:buffer";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  expandSessionFilesAsync,
  resolveNativeTerminalTranscriptPattern,
} from "@bb/cli/native-session-files";
import {
  NATIVE_TRANSCRIPT_TAIL_MAX_BYTES,
  type HostDaemonOnlineRpcResult,
} from "@bb/host-daemon-contract";
import type { CommandOf } from "../command-dispatch-support.js";

interface ReadTranscriptTailOptions {
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

export async function readTranscriptTail(
  command: CommandOf<"native_terminal.read_transcript_tail">,
  options: ReadTranscriptTailOptions = {},
): Promise<HostDaemonOnlineRpcResult<"native_terminal.read_transcript_tail">> {
  if (!path.isAbsolute(command.cwd)) {
    throw new Error("Native transcript cwd must be absolute");
  }
  const resolved = resolveNativeTerminalTranscriptPattern({
    sessionRoot: command.sessionRoot,
    transcriptPattern: command.transcriptPattern,
    sessionId: command.sessionId,
    env: options.shellEnv ?? process.env,
    ...(options.homeDir === undefined ? {} : { fallbackHome: options.homeDir }),
  });
  try {
    const root = await realpath(resolved.root);
    const candidates = await expandSessionFilesAsync(
      resolved.root,
      resolved.pattern,
    );
    const transcriptPath = candidates[0];
    if (transcriptPath === undefined) return { outcome: "missing" };
    const resolvedPath = await realpath(transcriptPath);
    if (!resolvedPath.startsWith(`${root}${path.sep}`)) {
      throw new Error("Native transcript path escaped its session root");
    }
    const file = await open(resolvedPath, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile()) {
        throw new Error("Native transcript is not a regular file");
      }
      const length = Math.min(stat.size, NATIVE_TRANSCRIPT_TAIL_MAX_BYTES);
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
