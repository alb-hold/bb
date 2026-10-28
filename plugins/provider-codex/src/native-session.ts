import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";

type CodexNativeTerminal = NonNullable<
  PluginProviderDeclaration["experimental_nativeTerminal"]
>;

export const CODEX_NATIVE_SESSION: CodexNativeTerminal["session"] = {
  kind: "discovered",
  resumeArgs: ["resume", "{sessionId}"],
  transcripts: "sessions/{yyyy}/{mm}/{dd}/rollout-*.jsonl",
  header: {
    match: { type: "session_meta" },
    discoveryMatch: { "payload.source": "cli" },
    id: "payload.id",
    cwd: "payload.cwd",
    startedAt: "payload.timestamp",
  },
};

export const CODEX_NATIVE_ACTIVITY: NonNullable<
  CodexNativeTerminal["activity"]
> = {
  transcript: {
    questions: {
      open: [
        {
          match: {
            equals: {
              type: "response_item",
              "payload.type": "function_call",
              "payload.name": "request_user_input",
            },
          },
          id: "payload.call_id",
          label: "Codex is asking a question",
        },
      ],
      close: [
        {
          match: {
            equals: {
              type: "response_item",
              "payload.type": "function_call_output",
            },
          },
          id: "payload.call_id",
        },
      ],
    },
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
};
