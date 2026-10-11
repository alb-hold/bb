import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  providerNativeTerminalActivitySchema,
  type ProviderNativeTerminal,
} from "@bb/domain";
import { afterEach, describe, expect, it } from "vitest";
import { NativeActivityReader } from "../native-activity-reader.js";

const CODEX_CLI: ProviderNativeTerminal = {
  executable: "codex",
  launchArgs: ["--no-daemon"],
  modelArgs: ["-c", 'model="{model}"'],
  pastePlaceholders: [],
  sessionRoot: { env: "CODEX_HOME", home: ".codex" },
  session: {
    kind: "discovered",
    resumeArgs: ["resume", "{sessionId}"],
    transcripts: "sessions/{yyyy}/{mm}/{dd}/rollout-*.jsonl",
    header: {
      match: { type: "session_meta" },
      id: "payload.id",
      cwd: "payload.cwd",
      startedAt: "payload.timestamp",
    },
  },
  activity: providerNativeTerminalActivitySchema.parse({
    transcript: {
      working: [
        { equals: { type: "event_msg", "payload.type": "task_started" } },
      ],
      idle: [
        { equals: { type: "event_msg", "payload.type": "task_complete" } },
      ],
      prompt: [
        {
          match: {
            equals: {
              type: "event_msg",
              "payload.type": "item_completed",
              "payload.item.type": "UserMessage",
            },
          },
          text: "payload.item.content.0.text",
        },
      ],
    },
  }),
};

const CLAUDE_CLI: ProviderNativeTerminal = {
  executable: "claude",
  launchArgs: [],
  modelArgs: ["--model", "{model}"],
  pastePlaceholders: [],
  sessionRoot: { env: "CLAUDE_CONFIG_DIR", home: ".claude" },
  session: {
    kind: "assigned",
    startArgs: ["--session-id", "{sessionId}"],
    resumeArgs: ["--resume", "{sessionId}"],
    transcript: "projects/*/{sessionId}.jsonl",
  },
  activity: providerNativeTerminalActivitySchema.parse({
    hooks: {
      args: ["--settings", "{settings}"],
      working: ["UserPromptSubmit"],
      idle: ["Stop"],
      promptField: "prompt",
    },
  }),
};

const SESSION_ID = "019a1f3e-0000-7000-8000-000000000001";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "bb-native-reader-"));
  roots.push(root);
  return root;
}

function jsonl(records: unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

function codexTurn(prompt: string): unknown[] {
  return [
    { type: "event_msg", payload: { type: "task_started" } },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "UserMessage",
          content: [{ type: "text", text: prompt }],
        },
      },
    },
    { type: "event_msg", payload: { type: "task_complete" } },
  ];
}

function writeRollout(home: string, records: unknown[]): string {
  const dir = path.join(home, ".codex", "sessions", "2026", "10", "11");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-x-${SESSION_ID}.jsonl`);
  const header = {
    type: "session_meta",
    payload: {
      id: SESSION_ID,
      cwd: "/work/a",
      timestamp: "2026-10-11T10:00:00Z",
    },
  };
  writeFileSync(file, jsonl([header, ...records]));
  return file;
}

describe("NativeActivityReader", () => {
  it("reports a resumed turn written before the first poll, not the turns before launch", () => {
    const home = tempHome();
    const file = writeRollout(home, codexTurn("an earlier prompt"));
    const reader = new NativeActivityReader(CODEX_CLI, { HOME: home }, null, {
      kind: "resume",
      id: SESSION_ID,
    });
    appendFileSync(file, jsonl(codexTurn("the resumed prompt")));

    expect(reader.read()).toEqual([
      { state: "working", prompt: null },
      { state: "working", prompt: "the resumed prompt" },
      { state: "idle", prompt: null },
    ]);
    expect(reader.read()).toEqual([]);
  });

  it("never reads a resumed transcript it could not measure at launch", () => {
    const home = tempHome();
    const reader = new NativeActivityReader(CODEX_CLI, { HOME: home }, null, {
      kind: "resume",
      id: SESSION_ID,
    });
    writeRollout(home, [
      ...codexTurn("an earlier prompt"),
      ...codexTurn("the resumed prompt"),
    ]);

    expect(reader.read()).toEqual([]);
    expect(reader.finish()).toBeNull();
  });

  it("reads a started session's transcript that appears after launch from its first record", () => {
    const home = tempHome();
    const reader = new NativeActivityReader(CODEX_CLI, { HOME: home }, null, {
      kind: "start",
      id: SESSION_ID,
    });
    writeRollout(home, codexTurn("the first prompt"));

    expect(reader.read()).toEqual([
      { state: "working", prompt: null },
      { state: "working", prompt: "the first prompt" },
      { state: "idle", prompt: null },
    ]);
  });

  it("reads a session discovered after launch from its first record", () => {
    const home = tempHome();
    const reader = new NativeActivityReader(CODEX_CLI, { HOME: home }, null, {
      kind: "discover",
    });
    writeRollout(home, codexTurn("the first prompt").slice(0, 2));
    expect(reader.read()).toEqual([]);

    reader.sessionDiscovered(SESSION_ID);
    expect(reader.read()).toEqual([
      { state: "working", prompt: null },
      { state: "working", prompt: "the first prompt" },
    ]);
    expect(reader.heartbeat()).toEqual({ state: "working", prompt: null });
    expect(reader.finish()).toEqual({ state: "idle", prompt: null });
    expect(reader.heartbeat()).toBeNull();
  });

  it("reads hook events while the assigned transcript does not exist yet", () => {
    const home = tempHome();
    const events = path.join(home, "events.jsonl");
    writeFileSync(events, "");
    const reader = new NativeActivityReader(
      CLAUDE_CLI,
      { HOME: home },
      events,
      { kind: "start", id: SESSION_ID },
    );
    appendFileSync(
      events,
      jsonl([
        { hook_event_name: "UserPromptSubmit", prompt: "fix the build" },
        { hook_event_name: "Stop" },
      ]),
    );

    expect(reader.read()).toEqual([
      { state: "working", prompt: "fix the build" },
      { state: "idle", prompt: null },
    ]);
  });
});
