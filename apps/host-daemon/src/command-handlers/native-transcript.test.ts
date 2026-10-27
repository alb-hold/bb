import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NATIVE_TRANSCRIPT_TAIL_MAX_BYTES } from "@bb/host-daemon-contract";
import { readTranscriptTail } from "./native-transcript.js";

describe("readTranscriptTail", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("resolves a declared assigned transcript pattern and returns a bounded async tail", async () => {
    root = await mkdtemp(join(tmpdir(), "bb-native-transcript-"));
    const command = {
      type: "native_terminal.read_transcript_tail" as const,
      cwd: "/work/native-status",
      sessionRoot: { env: "FIXTURE_HOME", home: ".fixture" },
      transcriptPattern: "projects/*/{sessionId}.jsonl",
      sessionId: "session-123",
    };
    const options = { shellEnv: { FIXTURE_HOME: root } };
    expect(await readTranscriptTail(command, options)).toEqual({
      outcome: "missing",
    });

    const project = join(root, "projects", "fixture-project");
    await mkdir(project, { recursive: true });
    const content = "x".repeat(NATIVE_TRANSCRIPT_TAIL_MAX_BYTES + 12);
    await writeFile(join(project, command.sessionId + ".jsonl"), content);
    const result = await readTranscriptTail(command, options);
    expect(result.outcome).toBe("available");
    if (result.outcome !== "available") return;
    expect(result.sizeBytes).toBe(content.length);
    expect(result.truncated).toBe(true);
    expect(Buffer.from(result.contentBase64, "base64").toString()).toBe(
      content.slice(-NATIVE_TRANSCRIPT_TAIL_MAX_BYTES),
    );
  });
});
