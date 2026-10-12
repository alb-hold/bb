import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  providerNativeTerminalActivitySchema,
  type ProviderNativeTerminal,
} from "@bb/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  measureResumedTranscript,
  NativeActivityReader,
} from "../native-activity-reader.js";
import { createFakePluginHost } from "../../../../packages/plugin-sdk/src/testing/fake-plugin-host.js";
import claudeCodePlugin from "../../../../plugins/provider-claude-code/server.js";

const CODEX_CLI: ProviderNativeTerminal = {
  executable: "codex",
  launchArgs: ["--no-daemon"],
  modelArgs: ["-c", 'model="{model}"'],
  imageArgs: ["--image", "{image}"],
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
  imageArgs: [],
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
      working: ["UserPromptSubmit", "PreToolUse"],
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

function claudeFixture(extraWorking: boolean = false) {
  const host = createFakePluginHost({ pluginId: "provider-claude-code" });
  claudeCodePlugin(host.bb);
  const declaration = host.harness.registrations.providerRegistrations.find(
    (entry) => entry.id === "claude-code",
  );
  const cli = declaration?.experimental_nativeTerminal;
  if (cli === undefined) throw new Error("Claude native declaration missing");
  const activity = cli.activity;
  if (activity?.transcript === undefined)
    throw new Error("Claude transcript missing");
  const native = extraWorking
    ? {
        ...cli,
        activity: {
          ...activity,
          transcript: {
            ...activity.transcript,
            working: [{ equals: { type: "assistant", isSidechain: false } }],
          },
        },
      }
    : cli;
  const home = tempHome();
  const dir = path.join(home, ".claude", "projects", "work");
  mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, `${SESSION_ID}.jsonl`);
  const events = path.join(home, "hooks.jsonl");
  writeFileSync(
    transcript,
    jsonl([
      {
        type: "user",
        uuid: "user-1",
        parentUuid: null,
        promptId: "turn-1",
        origin: { kind: "human" },
        message: { content: "first prompt" },
      },
      {
        type: "assistant",
        isSidechain: false,
        uuid: "answer-1",
        parentUuid: "user-1",
        message: {
          id: "message-1",
          content: [{ type: "text", text: "first answer" }],
        },
      },
    ]),
  );
  writeFileSync(
    events,
    jsonl([
      {
        hook_event_name: "UserPromptSubmit",
        prompt_id: "turn-1",
        prompt: "first prompt",
      },
    ]),
  );
  const reader = new NativeActivityReader(native, { HOME: home }, events, {
    kind: "start",
    id: SESSION_ID,
  });
  expect(reader.read()).toEqual([{ state: "working", prompt: "first prompt" }]);
  return {
    reader,
    hook: (records: unknown[]) => appendFileSync(events, jsonl(records)),
    append: (records: unknown[]) => appendFileSync(transcript, jsonl(records)),
  };
}

function finalClaudeStop(fixture: ReturnType<typeof claudeFixture>) {
  fixture.hook([
    { hook_event_name: "Stop", prompt_id: "turn-1", stop_hook_active: false },
  ]);
  fixture.append([
    {
      type: "system",
      subtype: "stop_hook_summary",
      isSidechain: false,
      hasOutput: false,
      uuid: "end-1",
      parentUuid: "answer-1",
    },
  ]);
  expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
  expect(fixture.reader.heartbeat()).toBeNull();
}

describe("NativeActivityReader", () => {
  it("keeps a blocked Stop and assistant-only continuation working until the final Stop outcome", () => {
    const fixture = claudeFixture();
    fixture.hook([
      { hook_event_name: "Stop", prompt_id: "turn-1", stop_hook_active: false },
    ]);
    fixture.reader.read();
    fixture.append([
      {
        type: "user",
        isMeta: true,
        promptId: "turn-1",
        uuid: "feedback-1",
        parentUuid: "answer-1",
        message: {
          content:
            "Stop hook feedback:\nWrite two more sentences without tools.",
        },
      },
      {
        type: "system",
        subtype: "stop_hook_summary",
        isSidechain: false,
        hasOutput: true,
        uuid: "blocked-1",
        parentUuid: "feedback-1",
      },
      {
        type: "assistant",
        isSidechain: false,
        uuid: "answer-2",
        parentUuid: "blocked-1",
        message: {
          id: "message-2",
          content: [{ type: "text", text: "Two more sentences." }],
        },
      },
    ]);
    fixture.reader.read();
    expect(fixture.reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
    expect(fixture.reader.read()).toEqual([]);
    expect(fixture.reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
    fixture.hook([
      { hook_event_name: "Stop", prompt_id: "turn-1", stop_hook_active: true },
    ]);
    fixture.append([
      {
        type: "system",
        subtype: "stop_hook_summary",
        isSidechain: false,
        hasOutput: false,
        uuid: "end-2",
        parentUuid: "answer-2",
      },
    ]);
    expect(fixture.reader.read()).toEqual([{ state: "idle", prompt: null }]);
    expect(fixture.reader.heartbeat()).toBeNull();
  });

  it("keeps final idle when an already-seen assistant message flushes late with a later timestamp", () => {
    const fixture = claudeFixture(true);
    finalClaudeStop(fixture);
    fixture.append([
      {
        type: "assistant",
        isSidechain: false,
        uuid: "answer-1",
        parentUuid: "user-1",
        timestamp: "2099-01-01T00:00:00Z",
        message: {
          id: "message-1",
          content: [{ type: "text", text: "first answer" }],
        },
      },
      {
        type: "assistant",
        isSidechain: false,
        uuid: "late-block-1",
        parentUuid: "answer-1",
        message: {
          id: "message-1",
          content: [{ type: "text", text: "late content block" }],
        },
      },
    ]);
    expect(fixture.reader.read()).toEqual([]);
    expect(fixture.reader.heartbeat()).toBeNull();
  });

  it("starts a new prompt after idle despite delayed completion records from the previous prompt", () => {
    const fixture = claudeFixture();
    finalClaudeStop(fixture);
    fixture.hook([
      {
        hook_event_name: "UserPromptSubmit",
        prompt_id: "turn-2",
        prompt: "second prompt",
      },
    ]);
    fixture.append([
      {
        type: "user",
        uuid: "late-interrupt-1",
        parentUuid: "answer-1",
        message: {
          content: [{ type: "text", text: "[Request interrupted by user]" }],
        },
      },
      {
        type: "system",
        subtype: "stop_hook_summary",
        isSidechain: false,
        hasOutput: false,
        uuid: "late-end-1",
        parentUuid: "answer-1",
      },
    ]);
    expect(fixture.reader.read()).toEqual([
      { state: "working", prompt: "second prompt" },
    ]);
    expect(fixture.reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
  });

  it("recognizes a new assistant continuation chained after a completed turn without another prompt hook", () => {
    const fixture = claudeFixture();
    finalClaudeStop(fixture);
    fixture.append([
      {
        type: "assistant",
        isSidechain: false,
        uuid: "background-1",
        parentUuid: "end-1",
        message: {
          id: "background-message",
          content: [{ type: "text", text: "Background task completed." }],
        },
      },
    ]);
    expect(fixture.reader.read()).toEqual([{ state: "working", prompt: null }]);
    expect(fixture.reader.heartbeat()).toEqual({
      state: "working",
      prompt: null,
    });
  });

  it("reports a resumed turn written before the first poll, not the turns before launch", async () => {
    const home = tempHome();
    const file = writeRollout(home, codexTurn("an earlier prompt"));
    const sizeBeforeLaunch = statSync(file).size;
    const baseline = await measureResumedTranscript(
      CODEX_CLI,
      { HOME: home },
      SESSION_ID,
    );
    const reader = new NativeActivityReader(CODEX_CLI, { HOME: home }, null, {
      kind: "resume",
      id: SESSION_ID,
      ...baseline,
    });
    appendFileSync(file, jsonl(codexTurn("the resumed prompt")));

    expect(baseline).toEqual({
      transcriptFile: file,
      offset: sizeBeforeLaunch,
    });
    expect(reader.read()).toEqual([
      { state: "working", prompt: null },
      { state: "working", prompt: "the resumed prompt" },
      { state: "idle", prompt: null },
    ]);
    expect(reader.read()).toEqual([]);
  });

  it("keeps the first resumed turn when the transcript ended mid-record before launch", async () => {
    const home = tempHome();
    const file = writeRollout(home, codexTurn("an earlier prompt"));
    appendFileSync(file, '{"type":"event_msg","payload":{"type":"task_');
    const baseline = await measureResumedTranscript(
      CODEX_CLI,
      { HOME: home },
      SESSION_ID,
    );
    const reader = new NativeActivityReader(CODEX_CLI, { HOME: home }, null, {
      kind: "resume",
      id: SESSION_ID,
      ...baseline,
    });
    appendFileSync(file, jsonl(codexTurn("the resumed prompt")));

    expect(reader.read()).toEqual([
      { state: "working", prompt: null },
      { state: "working", prompt: "the resumed prompt" },
      { state: "idle", prompt: null },
    ]);
  });

  it("drops the rest of a record begun before launch and keeps the resumed turn after it", async () => {
    const home = tempHome();
    const file = writeRollout(home, []);
    appendFileSync(file, '{"type":"event_msg","payload":{"type":"task_');
    const baseline = await measureResumedTranscript(
      CODEX_CLI,
      { HOME: home },
      SESSION_ID,
    );
    const reader = new NativeActivityReader(CODEX_CLI, { HOME: home }, null, {
      kind: "resume",
      id: SESSION_ID,
      ...baseline,
    });
    appendFileSync(
      file,
      `started"}}\n${jsonl(codexTurn("the resumed prompt"))}`,
    );

    expect(reader.read()).toEqual([
      { state: "working", prompt: null },
      { state: "working", prompt: "the resumed prompt" },
      { state: "idle", prompt: null },
    ]);
  });

  it("retries a failed baseline measurement before launch and keeps the size it then measures", async () => {
    const home = tempHome();
    const file = writeRollout(home, codexTurn("an earlier prompt"));
    const sizeBeforeLaunch = statSync(file).size;
    const measured: number[] = [];
    const baseline = await measureResumedTranscript(
      CODEX_CLI,
      { HOME: home },
      SESSION_ID,
      {
        delayMs: 0,
        measure: (filePath) => {
          measured.push(measured.length + 1);
          return measured.length < 3 ? null : statSync(filePath).size;
        },
      },
    );
    const reader = new NativeActivityReader(CODEX_CLI, { HOME: home }, null, {
      kind: "resume",
      id: SESSION_ID,
      ...baseline,
    });
    appendFileSync(file, jsonl(codexTurn("the resumed prompt")));

    expect(measured).toEqual([1, 2, 3]);
    expect(baseline).toEqual({
      transcriptFile: file,
      offset: sizeBeforeLaunch,
    });
    expect(reader.read()).toEqual([
      { state: "working", prompt: null },
      { state: "working", prompt: "the resumed prompt" },
      { state: "idle", prompt: null },
    ]);
  });

  it("refuses to resume when no baseline can be measured before launch", async () => {
    const home = tempHome();
    writeRollout(home, codexTurn("an earlier prompt"));
    let attempts = 0;

    await expect(
      measureResumedTranscript(CODEX_CLI, { HOME: home }, SESSION_ID, {
        attempts: 4,
        delayMs: 0,
        measure: () => {
          attempts += 1;
          return null;
        },
      }),
    ).rejects.toThrow(
      `could not read the codex transcript of session ${SESSION_ID}`,
    );
    expect(attempts).toBe(4);
    await expect(
      measureResumedTranscript(CODEX_CLI, { HOME: tempHome() }, SESSION_ID, {
        attempts: 2,
        delayMs: 0,
      }),
    ).rejects.toThrow("so it did not resume it");
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
    appendFileSync(events, jsonl([{ hook_event_name: "PreToolUse" }]));
    expect(reader.read()).toEqual([{ state: "working", prompt: null }]);
    appendFileSync(
      events,
      jsonl(
        Array.from({ length: 100 }, () => ({ hook_event_name: "PreToolUse" })),
      ),
    );
    expect(reader.read()).toEqual([]);
    appendFileSync(
      events,
      jsonl([{ hook_event_name: "Stop", stop_hook_active: true }]),
    );
    expect(reader.read()).toEqual([{ state: "idle", prompt: null }]);
    expect(reader.read()).toEqual([]);
    expect(reader.heartbeat()).toBeNull();
  });
});
