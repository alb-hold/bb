import type {
  ProviderNativeTerminal,
  ProviderNativeTerminalActivity,
} from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  classifyHookRecord,
  classifyTranscriptRecord,
  nativeActivityHookSettings,
  NativeActivityTracker,
  type NativeActivityReport,
} from "../native-activity.js";

interface PluginTestHost {
  bb: unknown;
  harness: {
    registrations: {
      providerRegistrations: {
        id: string;
        experimental_nativeTerminal?: ProviderNativeTerminal;
      }[];
    };
  };
}

const {
  createFakePluginHost,
}: {
  createFakePluginHost(options: { pluginId: string }): PluginTestHost;
} = await import(
  new URL(
    "../../../../packages/plugin-sdk/src/testing/fake-plugin-host.ts",
    import.meta.url,
  ).href
);
const { default: claudeCodePlugin }: { default(bb: unknown): void } =
  await import(
    new URL(
      "../../../../plugins/provider-claude-code/server.ts",
      import.meta.url,
    ).href
  );
const { default: codexPlugin }: { default(bb: unknown): void } = await import(
  new URL("../../../../plugins/provider-codex/server.ts", import.meta.url).href
);

function declaredActivity(
  providerId: "claude-code" | "codex",
): ProviderNativeTerminalActivity {
  const host = createFakePluginHost({ pluginId: `provider-${providerId}` });
  (providerId === "codex" ? codexPlugin : claudeCodePlugin)(host.bb);
  const activity = host.harness.registrations.providerRegistrations.find(
    (entry) => entry.id === providerId,
  )?.experimental_nativeTerminal?.activity;
  if (activity === undefined) throw new Error(`${providerId} has no activity`);
  return activity;
}

const CLAUDE = declaredActivity("claude-code");
const CODEX = declaredActivity("codex");

function claudeTranscript(record: unknown) {
  return classifyTranscriptRecord(CLAUDE.transcript!, record);
}

function codexTranscript(record: unknown) {
  return classifyTranscriptRecord(CODEX.transcript!, record);
}

function askUserQuestion(id: string, question: string) {
  return {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id,
          name: "AskUserQuestion",
          input: {
            questions: [
              { question, header: "Merge", multiSelect: false, options: [] },
            ],
          },
        },
      ],
    },
  };
}

function toolResult(id: string) {
  return {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id }] },
  };
}

function waiting(
  report: NativeActivityReport | null,
): { id: string; prompt: string }[] {
  if (report?.state !== "waiting") {
    throw new Error(`expected a waiting report, got ${JSON.stringify(report)}`);
  }
  return report.questions;
}

describe("native terminal questions", () => {
  it("reports an unanswered Claude AskUserQuestion as waiting and clears it on its tool result", () => {
    const tracker = new NativeActivityTracker();
    tracker.apply({ state: "working", prompt: "merge it" });
    const open = tracker.apply(
      claudeTranscript(askUserQuestion("toolu_ask", "Merge now?")),
    );
    expect(waiting(open)).toEqual([{ id: "toolu_ask", prompt: "Merge now?" }]);
    expect(tracker.heartbeat()).toEqual(open);
    expect(tracker.apply(claudeTranscript(toolResult("toolu_bash")))).toBeNull();
    expect(tracker.heartbeat()).toEqual(open);
    expect(tracker.apply(claudeTranscript(toolResult("toolu_ask")))).toEqual({
      state: "working",
      prompt: null,
    });
    expect(tracker.heartbeat()).toEqual({ state: "working", prompt: null });
  });

  it("keeps a question open across working signals without a new prompt", () => {
    const tracker = new NativeActivityTracker();
    tracker.apply({ state: "working", prompt: "go" });
    const open = tracker.apply(
      claudeTranscript(askUserQuestion("toolu_ask", "Which branch?")),
    );
    expect(tracker.apply({ state: "working", prompt: null })).toBeNull();
    expect(tracker.heartbeat()).toEqual(open);
  });

  it("clears every open question on a new prompt, an interrupt and exit", () => {
    for (const clear of [
      (tracker: NativeActivityTracker) =>
        tracker.apply({ state: "working", prompt: "never mind" }),
      (tracker: NativeActivityTracker) =>
        tracker.apply(
          claudeTranscript({
            type: "user",
            message: {
              content: [
                {
                  type: "text",
                  text: "[Request interrupted by user for tool use]",
                },
              ],
            },
          }),
        ),
      (tracker: NativeActivityTracker) => tracker.finish(),
    ]) {
      const tracker = new NativeActivityTracker();
      tracker.apply({ state: "working", prompt: "go" });
      tracker.apply(claudeTranscript(askUserQuestion("toolu_a", "A?")));
      tracker.apply(claudeTranscript(askUserQuestion("toolu_b", "B?")));
      const cleared = clear(tracker);
      expect(cleared).not.toBeNull();
      expect(cleared?.state).not.toBe("waiting");
      expect(tracker.heartbeat()?.state).not.toBe("waiting");
    }
  });

  it("tracks parallel questions and reports the remainder when one is answered", () => {
    const tracker = new NativeActivityTracker();
    tracker.apply({ state: "working", prompt: "go" });
    tracker.apply(claudeTranscript(askUserQuestion("toolu_a", "A?")));
    tracker.apply(claudeTranscript(askUserQuestion("toolu_b", "B?")));
    expect(
      waiting(tracker.apply(claudeTranscript(toolResult("toolu_a")))),
    ).toEqual([{ id: "toolu_b", prompt: "B?" }]);
  });

  it("reports Claude plan approval with its fixed label", () => {
    const tracker = new NativeActivityTracker();
    tracker.apply({ state: "working", prompt: "plan it" });
    const open = tracker.apply(
      claudeTranscript({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_plan",
              name: "ExitPlanMode",
              input: {},
            },
          ],
        },
      }),
    );
    expect(waiting(open)).toEqual([
      {
        id: "toolu_plan",
        prompt: "Claude Code is waiting for you to approve its plan",
      },
    ]);
  });

  it("ignores ordinary Claude tool calls", () => {
    expect(
      claudeTranscript({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_x", name: "Bash", input: {} },
          ],
        },
      }),
    ).toEqual({ state: null, prompt: null });
  });

  it("opens a Claude permission request from its hook and clears it on that tool's result", () => {
    const hooks = CLAUDE.hooks!;
    const settings = JSON.parse(
      nativeActivityHookSettings(hooks, "/tmp/e.jsonl"),
    );
    expect(Object.keys(settings.hooks)).toEqual(
      expect.arrayContaining([
        "PermissionRequest",
        "PostToolUse",
        "PostToolUseFailure",
        "PermissionDenied",
      ]),
    );
    const tracker = new NativeActivityTracker();
    tracker.apply({ state: "working", prompt: "go" });
    const open = tracker.apply(
      classifyHookRecord(hooks, {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "rm -rf build" },
      }),
    );
    expect(waiting(open)).toEqual([
      {
        id: "permission:Bash#1",
        prompt: "Claude Code needs permission to use: Bash",
      },
    ]);
    expect(
      tracker.apply(
        classifyHookRecord(hooks, {
          hook_event_name: "PostToolUse",
          tool_name: "Read",
          tool_use_id: "toolu_read",
        }),
      ),
    ).toBeNull();
    expect(
      tracker.apply(
        classifyHookRecord(hooks, {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_use_id: "toolu_bash",
        }),
      ),
    ).toEqual({ state: "working", prompt: null });
    tracker.apply(
      classifyHookRecord(hooks, {
        hook_event_name: "PermissionRequest",
        tool_name: "Edit",
      }),
    );
    expect(
      tracker.apply(
        classifyHookRecord(hooks, {
          hook_event_name: "PermissionDenied",
          tool_name: "Edit",
        }),
      ),
    ).toEqual({ state: "working", prompt: null });
  });

  it.each([
    ["hook before the transcript record", true],
    ["transcript record before the hook", false],
  ])(
    "shows one waiting entry for a real AskUserQuestion that also fires PermissionRequest (%s)",
    (_name, hookFirst) => {
      const hooks = CLAUDE.hooks!;
      const tracker = new NativeActivityTracker();
      tracker.apply({ state: "working", prompt: "deploy" });
      const permissionRequest = () =>
        tracker.apply(
          classifyHookRecord(hooks, {
            hook_event_name: "PermissionRequest",
            tool_name: "AskUserQuestion",
            tool_input: { questions: [{ question: "Which target?" }] },
          }),
        );
      const transcriptRecord = () =>
        tracker.apply(
          claudeTranscript(askUserQuestion("toolu_ask", "Which target?")),
        );
      let last: NativeActivityReport | null;
      if (hookFirst) {
        permissionRequest();
        last = transcriptRecord();
      } else {
        transcriptRecord();
        last = permissionRequest();
      }
      const open = last ?? tracker.heartbeat();
      expect(waiting(open)).toEqual([
        { id: "toolu_ask", prompt: "Which target?" },
      ]);
      expect(
        tracker.apply(
          classifyHookRecord(hooks, {
            hook_event_name: "PostToolUse",
            tool_name: "AskUserQuestion",
            tool_use_id: "toolu_ask",
          }),
        ),
      ).toBeNull();
      expect(tracker.apply(claudeTranscript(toolResult("toolu_ask")))).toEqual({
        state: "working",
        prompt: null,
      });
      expect(tracker.heartbeat()).toEqual({ state: "working", prompt: null });
    },
  );

  it("OPEN FINDING (not fixed): a Bash completion closes the oldest open Bash prompt, whichever tool call it belongs to", () => {
    const hooks = CLAUDE.hooks!;
    const tracker = new NativeActivityTracker();
    tracker.apply({ state: "working", prompt: "go" });
    const prompt = () =>
      tracker.apply(
        classifyHookRecord(hooks, {
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
        }),
      );
    prompt();
    prompt();
    const afterCompletion = tracker.apply(
      classifyHookRecord(hooks, {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_of_the_second_prompt",
      }),
    );
    expect(waiting(afterCompletion)).toEqual([
      {
        id: "permission:Bash#2",
        prompt: "Claude Code needs permission to use: Bash",
      },
    ]);
  });

  it("does not add a permission entry for plan approval, which the transcript already reports", () => {
    const hooks = CLAUDE.hooks!;
    const tracker = new NativeActivityTracker();
    tracker.apply({ state: "working", prompt: "plan it" });
    expect(
      tracker.apply(
        classifyHookRecord(hooks, {
          hook_event_name: "PermissionRequest",
          tool_name: "ExitPlanMode",
        }),
      ),
    ).toBeNull();
    expect(tracker.heartbeat()).toEqual({ state: "working", prompt: null });
  });

  it("reports a blocking Codex request_user_input and clears it on its output", () => {
    const tracker = new NativeActivityTracker();
    tracker.apply(
      codexTranscript({ type: "event_msg", payload: { type: "task_started" } }),
    );
    const open = tracker.apply(
      codexTranscript({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_ask",
          arguments: "{}",
        },
      }),
    );
    expect(waiting(open)).toEqual([
      { id: "call_ask", prompt: "Codex is asking a question" },
    ]);
    expect(
      tracker.apply(
        codexTranscript({
          type: "response_item",
          payload: { type: "function_call_output", call_id: "call_sleep" },
        }),
      ),
    ).toBeNull();
    expect(
      tracker.apply(
        codexTranscript({
          type: "response_item",
          payload: { type: "function_call_output", call_id: "call_ask" },
        }),
      ),
    ).toEqual({ state: "working", prompt: null });
  });

  it("does not treat Codex's non-blocking request_user_input_async as waiting", () => {
    expect(
      codexTranscript({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input_async",
          call_id: "call_async",
          arguments: "{}",
        },
      }),
    ).toEqual({ state: null, prompt: null });
  });

  it("settles a Codex turn that ends while a question is open", () => {
    const tracker = new NativeActivityTracker();
    tracker.apply(
      codexTranscript({ type: "event_msg", payload: { type: "task_started" } }),
    );
    tracker.apply(
      codexTranscript({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "c",
        },
      }),
    );
    expect(
      tracker.apply(
        codexTranscript({
          type: "event_msg",
          payload: { type: "turn_aborted" },
        }),
      ),
    ).toEqual({ state: "idle", prompt: null });
  });
});
