import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NATIVE_CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES } from "@bb/host-daemon-contract";
import { readClaudeTranscriptTail } from "./native-transcript.js";

describe("readClaudeTranscriptTail", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("returns a bounded async tail from the session path and handles missing sessions", async () => {
    root = await mkdtemp(join(tmpdir(), "bb-native-transcript-"));
    const command = {
      type: "native_terminal.read_claude_transcript_tail" as const,
      cwd: "/work/native-status",
      sessionId: "legacy-session-123",
    };
    const options = { shellEnv: { CLAUDE_CONFIG_DIR: root } };
    expect(await readClaudeTranscriptTail(command, options)).toEqual({
      outcome: "missing",
    });

    const project = join(root, "projects", "-work-native-status");
    await mkdir(project, { recursive: true });
    const content = "x".repeat(NATIVE_CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES + 12);
    await writeFile(join(project, command.sessionId + ".jsonl"), content);
    const result = await readClaudeTranscriptTail(command, options);
    expect(result.outcome).toBe("available");
    if (result.outcome !== "available") return;
    expect(result.sizeBytes).toBe(content.length);
    expect(result.truncated).toBe(true);
    expect(Buffer.from(result.contentBase64, "base64").toString()).toBe(
      content.slice(-NATIVE_CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES),
    );
  });
});
