import { describe, expect, it } from "vitest";
import { claudeCodeVisibilityMetadata } from "./visibility.js";
import { createClaudeDeltaHarness } from "./delta-test-harness.js";
import type { JsonRpcMessage } from "@get-bb/plugin-sdk/provider-bridge";

describe("claude-code visibility raw events", () => {
  it.each([
    {
      name: "user string text",
      type: "user",
      content: "A message typed mid-session",
      kind: "sdk/user:text",
      coverage: "noise",
    },
    {
      name: "user empty string",
      type: "user",
      content: "",
      kind: "sdk/user:text",
      coverage: "noise",
    },
    {
      name: "user text blocks",
      type: "user",
      content: [{ type: "text", text: "A message typed mid-session" }],
      kind: "sdk/user:text",
      coverage: "noise",
    },
    {
      name: "user tool result",
      type: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
      kind: "sdk/user:tool_result",
      coverage: "normalized",
    },
    {
      name: "user empty array",
      type: "user",
      content: [],
      kind: "sdk/user",
      coverage: "unknown",
    },
    {
      name: "assistant string text",
      type: "assistant",
      content: "Assistant text",
      kind: "sdk/assistant",
      coverage: "unknown",
    },
  ])("classifies $name", ({ type, content, kind, coverage }) => {
    expect(
      claudeCodeVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          message: { type, message: { role: type, content } },
        },
      }),
    ).toEqual({ kind, coverage });
  });

  it.each(["A message typed mid-session", ""])(
    "does not emit an unhandled timeline event for a user string echo %j",
    (content) => {
      const harness = createClaudeDeltaHarness();
      expect(
        harness.translate({
          jsonrpc: "2.0",
          method: "sdk/message",
          params: {
            threadId: "thread-1",
            message: {
              type: "user",
              message: { role: "user", content },
              session_id: "session-1",
              parent_tool_use_id: null,
              uuid: "message-1",
              timestamp: "2026-10-30T10:45:43.655Z",
            },
          },
        }),
      ).toEqual([]);
    },
  );

  it("classifies shared handled non-sdk envelopes as normalized", () => {
    expect(
      claudeCodeVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "thread/contextWindowUsage/updated",
        params: {
          threadId: "t1",
          contextWindowUsage: {
            usedTokens: 12,
            modelContextWindow: 100,
            estimated: false,
          },
        },
      }),
    ).toEqual({
      kind: "thread/contextWindowUsage/updated",
      coverage: "normalized",
    });

    expect(
      claudeCodeVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "error",
        params: {
          message: "provider failed",
        },
      }),
    ).toEqual({
      kind: "error",
      coverage: "normalized",
    });
  });

  it("classifies Claude stream ping events as noise", () => {
    expect(
      claudeCodeVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          threadId: "thread-1",
          message: {
            type: "stream_event",
            event: {
              type: "ping",
            },
            session_id: "session-1",
            parent_tool_use_id: null,
            uuid: "message-1",
          },
        },
      } satisfies JsonRpcMessage),
    ).toEqual({
      kind: "sdk/stream_event:ping",
      coverage: "noise",
    });
  });

  it("classifies Claude command lifecycle events as noise", () => {
    expect(
      claudeCodeVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          threadId: "thread-1",
          message: {
            type: "command_lifecycle",
            command_uuid: "command-1",
            state: "started",
            uuid: "message-1",
            session_id: "session-1",
          },
        },
      } satisfies JsonRpcMessage),
    ).toEqual({
      kind: "sdk/command_lifecycle",
      coverage: "noise",
    });
  });

  it("classifies Claude conversation resets as normalized", () => {
    expect(
      claudeCodeVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          threadId: "thread-1",
          message: {
            type: "conversation_reset",
            session_id: "session-1",
          },
        },
      } satisfies JsonRpcMessage),
    ).toEqual({
      kind: "sdk/conversation_reset",
      coverage: "normalized",
    });
  });

  it("classifies Claude thinking token system events as noise", () => {
    expect(
      claudeCodeVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          threadId: "thread-1",
          message: {
            type: "system",
            subtype: "thinking_tokens",
            estimated_tokens: 24,
            estimated_tokens_delta: 23,
            uuid: "message-1",
            session_id: "session-1",
          },
        },
      } satisfies JsonRpcMessage),
    ).toEqual({
      kind: "sdk/system:thinking_tokens",
      coverage: "noise",
    });
  });

  it("classifies server_tool_use and advisor_tool_result stream starts and assistant blocks without unhandled leakage", () => {
    expect(
      claudeCodeVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          threadId: "thr_6s73ie6hee",
          message: {
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "server_tool_use",
                id: "srvtoolu_014RZuJFuVAaAda7uVEeHYYP",
                name: "advisor",
                input: {},
              },
            },
            session_id: "2d550f77-b591-488e-be9c-5a5b69fe1261",
            parent_tool_use_id: null,
            uuid: "a0c34105-3f63-4a89-8de0-55a1d3afd2d3",
          },
        },
      } satisfies JsonRpcMessage),
    ).toEqual({
      kind: "sdk/stream_event:content_block_start:server_tool_use",
      coverage: "noise",
    });

    expect(
      claudeCodeVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          threadId: "thr_6s73ie6hee",
          message: {
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: 2,
              content_block: {
                type: "advisor_tool_result",
                tool_use_id: "srvtoolu_014RZuJFuVAaAda7uVEeHYYP",
                content: {
                  type: "advisor_redacted_result",
                  encrypted_content: "REDACTED_CIPHERTEXT",
                },
              },
            },
            session_id: "2d550f77-b591-488e-be9c-5a5b69fe1261",
            parent_tool_use_id: null,
            uuid: "0456eb9d-5f29-4764-9e1a-2db67dcadea0",
          },
        },
      } satisfies JsonRpcMessage),
    ).toEqual({
      kind: "sdk/stream_event:content_block_start:advisor_tool_result",
      coverage: "noise",
    });

    expect(
      claudeCodeVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          threadId: "thr_6s73ie6hee",
          message: {
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "server_tool_use",
                  id: "srvtoolu_014RZuJFuVAaAda7uVEeHYYP",
                  name: "advisor",
                  input: {},
                },
                {
                  type: "advisor_tool_result",
                  tool_use_id: "srvtoolu_014RZuJFuVAaAda7uVEeHYYP",
                  content: {
                    type: "advisor_redacted_result",
                    encrypted_content: "REDACTED_CIPHERTEXT",
                  },
                },
              ],
            },
          },
        },
      } satisfies JsonRpcMessage),
    ).toEqual({
      kind: "sdk/assistant:advisor_tool_result+server_tool_use",
      coverage: "normalized",
    });
  });

  it("classifies system informational events as normalized when warning and noise otherwise", () => {
    expect(
      claudeCodeVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          threadId: "thr_6s73ie6hee",
          message: {
            type: "system",
            subtype: "informational",
            content: "A hook didn't answer in time, so it didn't check this action.",
            level: "warning",
          },
        },
      } satisfies JsonRpcMessage),
    ).toEqual({
      kind: "sdk/system:informational",
      coverage: "normalized",
    });

    expect(
      claudeCodeVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "sdk/message",
        params: {
          threadId: "thr_6s73ie6hee",
          message: {
            type: "system",
            subtype: "informational",
            content: "Routine notice",
            level: "info",
          },
        },
      } satisfies JsonRpcMessage),
    ).toEqual({
      kind: "sdk/system:informational",
      coverage: "noise",
    });
  });
});
