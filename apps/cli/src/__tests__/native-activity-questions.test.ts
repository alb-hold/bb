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
    expect(
      tracker.apply(claudeTranscript(toolResult("toolu_bash"))),
    ).toBeNull();
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
    const tracker = new NativeActivityTracker("n0");
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
        id: "permission:Bash#n0.1",
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
          tool_input: { command: "rm -rf build" },
        }),
      ),
    ).toEqual({ state: "working", prompt: null });
    tracker.apply(
      classifyHookRecord(hooks, {
        hook_event_name: "PermissionRequest",
        tool_name: "Edit",
        tool_input: { file_path: "/tmp/a.ts" },
      }),
    );
    expect(
      tracker.apply(
        classifyHookRecord(hooks, {
          hook_event_name: "PermissionDenied",
          tool_name: "Edit",
          tool_input: { file_path: "/tmp/a.ts" },
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

  it("gives the first prompt of a new holder a different id than the previous holder used, so a reopened session cannot collide", () => {
    const hooks = CLAUDE.hooks!;
    const ask = (tracker: NativeActivityTracker) =>
      waiting(
        tracker.apply(
          classifyHookRecord(hooks, {
            hook_event_name: "PermissionRequest",
            tool_name: "Bash",
          }),
        ),
      );
    const first = ask(new NativeActivityTracker("aaaaaaaaaaaaaaaa"));
    const second = ask(new NativeActivityTracker("bbbbbbbbbbbbbbbb"));
    expect(first?.map((question) => question.id)).toEqual([
      "permission:Bash#aaaaaaaaaaaaaaaa.1",
    ]);
    expect(second?.map((question) => question.id)).toEqual([
      "permission:Bash#bbbbbbbbbbbbbbbb.1",
    ]);
  });

  it("keeps a prompt's id stable within one holder, in the report and in the heartbeat", () => {
    const hooks = CLAUDE.hooks!;
    const tracker = new NativeActivityTracker("cccccccccccccccc");
    const opened = waiting(
      tracker.apply(
        classifyHookRecord(hooks, {
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
        }),
      ),
    );
    expect(waiting(tracker.heartbeat())).toEqual(opened);
    expect(waiting(tracker.heartbeat())).toEqual(opened);
  });

  it("draws one random nonce per holder process and keeps ids within the opaque id limit for a very long tool name", () => {
    const hooks = CLAUDE.hooks!;
    const longTool = `mcp__${"x".repeat(400)}`;
    const ask = (tracker: NativeActivityTracker) =>
      waiting(
        tracker.apply(
          classifyHookRecord(hooks, {
            hook_event_name: "PermissionRequest",
            tool_name: longTool,
            tool_input: { value: 1 },
          }),
        ),
      );
    const one = ask(new NativeActivityTracker());
    const two = ask(new NativeActivityTracker());
    const idOne = one?.[0]?.id ?? "";
    expect(idOne.length).toBeLessThanOrEqual(256);
    expect(idOne).toMatch(/#[0-9a-f]{16}\.1$/u);
    expect(two?.[0]?.id).toBe(idOne);
    const tracker = new NativeActivityTracker();
    ask(tracker);
    expect(
      tracker.apply(
        classifyHookRecord(hooks, {
          hook_event_name: "PostToolUse",
          tool_name: longTool,
          tool_input: { value: 1 },
        }),
      ),
    ).toEqual({ state: "working", prompt: null });
  });

  it("gives two tool names that share their first 200 characters distinct ids, so the second prompt is not suppressed", () => {
    const hooks = CLAUDE.hooks!;
    const shared = `mcp__${"y".repeat(250)}`;
    const tracker = new NativeActivityTracker("dddddddddddddddd");
    tracker.apply(
      classifyHookRecord(hooks, {
        hook_event_name: "PermissionRequest",
        tool_name: `${shared}_one`,
      }),
    );
    const both = waiting(
      tracker.apply(
        classifyHookRecord(hooks, {
          hook_event_name: "PermissionRequest",
          tool_name: `${shared}_two`,
        }),
      ),
    );
    expect(both).toHaveLength(2);
    expect(new Set(both.map((question) => question.id)).size).toBe(2);
    expect(both.every((question) => question.id.length <= 256)).toBe(true);
  });

  describe("completions closing the prompt of their own tool call", () => {
    const hooks = CLAUDE.hooks!;
    const bash = (command: string) => ({ command, description: "run" });
    function holder() {
      const tracker = new NativeActivityTracker("n0");
      tracker.apply({ state: "working", prompt: "go" });
      const hook = (record: Record<string, unknown>) =>
        tracker.apply(classifyHookRecord(hooks, record));
      const call = (id: string, input: unknown) => ({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: id,
        tool_input: input,
      });
      const ask = (input: unknown) => ({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: input,
      });
      const done = (id: string, input?: unknown, event = "PostToolUse") => ({
        hook_event_name: event,
        tool_name: "Bash",
        tool_use_id: id,
        ...(input === undefined ? {} : { tool_input: input }),
      });
      return { tracker, hook, call, ask, done };
    }

    it("closes only the prompt its completion belongs to when two Bash prompts are completed out of order, and the other stays Needs input", () => {
      const { hook, call, ask, done, tracker } = holder();
      hook(call("toolu_1", bash("make build")));
      hook(ask(bash("make build")));
      hook(call("toolu_2", bash("rm -rf dist")));
      hook(ask(bash("rm -rf dist")));
      const afterSecond = hook(done("toolu_2", bash("rm -rf dist")));
      expect(waiting(afterSecond)).toEqual([
        {
          id: "permission:Bash#n0.1",
          prompt: "Claude Code needs permission to use: Bash",
        },
      ]);
      expect(waiting(tracker.heartbeat())).toEqual([
        {
          id: "permission:Bash#n0.1",
          prompt: "Claude Code needs permission to use: Bash",
        },
      ]);
      expect(hook(done("toolu_1", bash("make build")))).toEqual({
        state: "working",
        prompt: null,
      });
    });

    it("ends exactly one of two Bash prompts with the same command and input, because they are indistinguishable to the user and closing either is correct", () => {
      const { hook, call, ask, done } = holder();
      hook(call("toolu_1", bash("make build")));
      hook(ask(bash("make build")));
      hook(call("toolu_2", bash("make build")));
      hook(ask(bash("make build")));
      const afterOne = hook(done("toolu_2", bash("make build")));
      expect(waiting(afterOne)).toHaveLength(1);
      expect(hook(done("toolu_1", bash("make build")))).toEqual({
        state: "working",
        prompt: null,
      });
    });

    it("closes its own prompt by tool call id when the input was rewritten after the prompt", () => {
      const { hook, call, ask, done, tracker } = holder();
      hook(call("toolu_1", bash("npm test")));
      hook(ask(bash("npm test")));
      hook(call("toolu_2", bash("make build")));
      hook(ask(bash("make build")));
      const afterRewritten = hook(done("toolu_2", bash("make build --fast")));
      expect(waiting(afterRewritten)).toEqual([
        {
          id: "permission:Bash#n0.1",
          prompt: "Claude Code needs permission to use: Bash",
        },
      ]);
      expect(waiting(tracker.heartbeat())).toHaveLength(1);
    });

    it("closes the prompt by the rewritten input when another hook rewrote the input before the prompt, and still closes nothing for an auto-allowed call with the announced input", () => {
      const { hook, call, ask, done, tracker } = holder();
      hook(call("toolu_1", bash("make build")));
      hook(ask(bash("make build")));
      hook(call("toolu_2", bash("npm test")));
      hook(ask(bash("npm run lint")));
      expect(hook(done("toolu_auto", bash("npm test")))).toBeNull();
      hook(call("toolu_3", bash("npm test")));
      expect(hook(done("toolu_3", bash("npm test")))).toBeNull();
      expect(waiting(tracker.heartbeat())).toHaveLength(2);
      const afterRewritten = hook(done("toolu_2", bash("npm run lint")));
      expect(waiting(afterRewritten)).toEqual([
        {
          id: "permission:Bash#n0.1",
          prompt: "Claude Code needs permission to use: Bash",
        },
      ]);
    });

    it("closes nothing for a completion that has no key or matches no prompt, and keeps the question until a report names it or the turn ends", () => {
      const { hook, call, ask, done, tracker } = holder();
      hook(call("toolu_1", bash("make build")));
      hook(ask(bash("make build")));
      expect(
        hook({ hook_event_name: "PostToolUse", tool_name: "Bash" }),
      ).toBeNull();
      expect(hook(done("toolu_other", bash("ls")))).toBeNull();
      hook(call("toolu_auto", bash("pwd")));
      expect(hook(done("toolu_auto", bash("pwd")))).toBeNull();
      expect(hook(done("toolu_auto2"))).toBeNull();
      expect(waiting(tracker.heartbeat())).toHaveLength(1);
      expect(tracker.apply({ state: "idle", prompt: null })).toEqual({
        state: "idle",
        prompt: null,
      });
      expect(tracker.heartbeat()).toBeNull();
    });

    it("falls back to the input match for a prompt whose tool call was never announced", () => {
      const { hook, ask, done } = holder();
      hook(ask(bash("make build")));
      expect(hook(done("toolu_1", bash("make build")))).toEqual({
        state: "working",
        prompt: null,
      });
    });
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
