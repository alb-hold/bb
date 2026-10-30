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
});
