import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  providerNativeTerminalActivitySchema,
  type ProviderNativeTerminalActivity,
} from "@bb/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyHookRecord,
  classifyTranscriptRecord,
  JsonlTail,
  nativeActivityHookSettings,
  NativeActivityTracker,
} from "../native-activity.js";

const CLAUDE_ACTIVITY: ProviderNativeTerminalActivity =
  providerNativeTerminalActivitySchema.parse({
    hooks: {
      args: ["--settings", "{settings}"],
      working: ["UserPromptSubmit"],
      idle: ["Stop"],
      promptField: "prompt",
    },
    transcript: {
      working: [],
      idle: [
        {
          equals: { type: "user" },
          startsWith: {
            "message.content.0.text": "[Request interrupted by user",
          },
        },
      ],
      prompt: [],
    },
  });

const CODEX_ACTIVITY: ProviderNativeTerminalActivity =
  providerNativeTerminalActivitySchema.parse({
    transcript: {
      working: [
        { equals: { type: "event_msg", "payload.type": "task_started" } },
      ],
      idle: [
        { equals: { type: "event_msg", "payload.type": "task_complete" } },
        { equals: { type: "event_msg", "payload.type": "turn_aborted" } },
      ],
      prompt: [
        {
          match: {
            equals: { type: "event_msg", "payload.type": "user_message" },
          },
          text: "payload.message",
        },
      ],
    },
  });

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "bb-native-activity-"));
  roots.push(root);
  return root;
}

describe("native terminal activity", () => {
  it("installs hooks that append each event's input to the events file", () => {
    const hooks = CLAUDE_ACTIVITY.hooks!;
    const eventsFile = path.join(tempDir(), "it's events.jsonl");
    const settings = JSON.parse(nativeActivityHookSettings(hooks, eventsFile));
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "Stop",
      "UserPromptSubmit",
    ]);
    const command: string = settings.hooks.UserPromptSubmit[0].hooks[0].command;
    for (const record of [
      { hook_event_name: "UserPromptSubmit", prompt: "fix the build" },
      { hook_event_name: "Stop" },
    ]) {
      const output = execFileSync("/bin/sh", ["-c", command], {
        input: JSON.stringify(record),
      });
      expect(output.toString()).toBe("");
    }
    const tail = new JsonlTail(false);
    const signals = tail
      .readRecords(eventsFile)
      .map((record) => classifyHookRecord(hooks, record));
    expect(signals).toEqual([
      { state: "working", prompt: "fix the build" },
      { state: "idle", prompt: null },
    ]);
  });

  it("reads a Claude interrupt and Codex turns from their session files", () => {
    const claude = CLAUDE_ACTIVITY.transcript!;
    expect(
      classifyTranscriptRecord(claude, {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "[Request interrupted by user for tool use]",
            },
          ],
        },
      }),
    ).toEqual({ state: "idle", prompt: null });
    expect(
      classifyTranscriptRecord(claude, {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "ok" }],
        },
      }),
    ).toEqual({ state: null, prompt: null });
    expect(
      classifyTranscriptRecord(claude, {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "fix the build" }],
        },
      }),
    ).toEqual({ state: null, prompt: null });

    const codex = CODEX_ACTIVITY.transcript!;
    const event = (type: string, extra: Record<string, unknown> = {}) => ({
      type: "event_msg",
      payload: { type, ...extra },
    });
    expect(
      [
        event("task_started"),
        event("user_message", { message: "  add a test  " }),
        event("token_count"),
        event("turn_aborted"),
        event("task_complete"),
      ].map((record) => classifyTranscriptRecord(codex, record)),
    ).toEqual([
      { state: "working", prompt: null },
      { state: "working", prompt: "add a test" },
      { state: null, prompt: null },
      { state: "idle", prompt: null },
      { state: "idle", prompt: null },
    ]);
  });

  it("reads only records appended after launch when resuming, across partial writes", () => {
    const file = path.join(tempDir(), "session.jsonl");
    writeFileSync(file, `${JSON.stringify({ old: true })}\n`);
    const resumed = new JsonlTail(true);
    const fresh = new JsonlTail(false);
    expect(resumed.readRecords(file)).toEqual([]);
    expect(fresh.readRecords(file)).toEqual([{ old: true }]);

    appendFileSync(file, `${JSON.stringify({ n: 1 })}\n{"n":`);
    expect(resumed.readRecords(file)).toEqual([{ n: 1 }]);
    appendFileSync(file, `2}\nnot json\n`);
    expect(resumed.readRecords(file)).toEqual([{ n: 2 }]);
    expect(readFileSync(file, "utf8")).toContain("not json");
    expect(new JsonlTail(true).readRecords(path.join(file, "missing"))).toEqual(
      [],
    );
  });

  it("reports each turn once, new prompts once, and idle on exit", () => {
    const tracker = new NativeActivityTracker();
    expect(tracker.apply({ state: "idle", prompt: null })).toBeNull();
    expect(tracker.apply({ state: "working", prompt: null })).toEqual({
      state: "working",
      prompt: null,
    });
    expect(tracker.apply({ state: "working", prompt: null })).toBeNull();
    expect(tracker.apply({ state: "working", prompt: "first" })).toEqual({
      state: "working",
      prompt: "first",
    });
    expect(tracker.apply({ state: "working", prompt: "first" })).toBeNull();
    expect(tracker.apply({ state: "idle", prompt: null })).toEqual({
      state: "idle",
      prompt: null,
    });
    expect(tracker.finish()).toBeNull();
    expect(tracker.heartbeat()).toBeNull();
    tracker.apply({ state: "working", prompt: "first" });
    expect(tracker.heartbeat()).toEqual({ state: "working", prompt: null });
    expect(tracker.finish()).toEqual({ state: "idle", prompt: null });
  });
});
