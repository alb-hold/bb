import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeTerminalThread, createTerminalSession, setNativeTerminalThreadTerminal, listNativeParentNotices, getThread } from "@bb/db";
import { seedThread, seedThreadFixture } from "../../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../../helpers/test-app.js";
import { recordNativeTerminalActivity } from "../../../src/services/threads/native-terminal-activity.js";

function nativeChildFixture(harness: TestAppHarness, policy: "auto" | "off" | "stuck") {
  const { thread: parent, host, session, project, environment } = seedThreadFixture(harness, { thread: { status: "active" } });
  const child = seedThread(harness.deps, { projectId: project.id, environmentId: environment.id, parentThreadId: parent.id, parentNotifications: policy, title: "Native worker" });
  for (const thread of [parent, child]) {
    createNativeTerminalThread(harness.db, { threadId: thread.id, providerId: thread.providerId, nativeSessionId: `native-${thread.id}`, initialPrompt: thread.id === parent.id ? "Coordinate children" : null, initialImages: [], model: null });
    if (thread.id === parent.id) continue;
    const terminal = createTerminalSession(harness.db, { cols: 80, rows: 24, environmentId: environment.id, hostId: host.id, daemonSessionId: session.id, initialCwd: "/tmp", status: "running", threadId: thread.id, title: "Native" });
    setNativeTerminalThreadTerminal(harness.db, { threadId: thread.id, terminalSessionId: terminal.id });
  }
  return { parent, child };
}

afterEach(() => vi.useRealTimers());

describe("native child turn notifications", () => {
  it.each(["auto", "off", "stuck"] as const)("respects %s and reports each completed native turn once", async (policy) => {
    await withTestHarness(async (harness) => {
      const { parent, child } = nativeChildFixture(harness, policy);
      vi.useFakeTimers();
      const report = (state: "working" | "idle") => recordNativeTerminalActivity(harness.deps, { threadId: child.id, confirms: true, state });
      report("idle");
      await vi.advanceTimersByTimeAsync(2_100);
      expect(listNativeParentNotices(harness.db, parent.id)).toHaveLength(0);
      report("working");
      report("working");
      expect(getThread(harness.db, child.id)?.status).toBe("active");
      report("idle");
      await vi.advanceTimersByTimeAsync(2_100);
      const notices = listNativeParentNotices(harness.db, parent.id);
      expect(notices).toHaveLength(policy === "auto" ? 1 : 0);
      if (policy === "auto") expect(notices[0]?.text).toContain("Native worker turn ended.");
      report("idle");
      await vi.advanceTimersByTimeAsync(31_000);
      report("idle");
      await vi.advanceTimersByTimeAsync(2_100);
      expect(listNativeParentNotices(harness.db, parent.id)).toHaveLength(policy === "auto" ? 1 : 0);
    });
  });

  it.each(["auto", "stuck", "off"] as const)("preserves native question attention notifications for %s", async (policy) => {
    await withTestHarness(async (harness) => {
      const { parent, child } = nativeChildFixture(harness, policy);
      vi.useFakeTimers();
      recordNativeTerminalActivity(harness.deps, { threadId: child.id, confirms: true, state: "waiting", questions: [{ id: "decision", prompt: "Which target should I use?" }] });
      await vi.advanceTimersByTimeAsync(2_100);
      const notices = listNativeParentNotices(harness.db, parent.id);
      expect(notices).toHaveLength(policy === "off" ? 0 : 1);
      if (policy !== "off") expect(notices[0]?.text).toContain("Which target should I use?");
    });
  });
});
import {
  buildChildThreadNeedsAttentionInput,
  buildChildThreadTurnStatusBatchInput,
  type ChildThreadNotificationSource,
  type ChildThreadTurnNotificationBatchItem,
} from "../../../src/services/threads/child-thread-notifications.js";

interface TestThreadArgs {
  id: string;
  title: string | null;
}

function testThread(args: TestThreadArgs): ChildThreadNotificationSource {
  return {
    id: args.id,
    projectId: "proj_alpha",
    title: args.title,
  };
}

function renderBatchMessage(args: {
  items: ChildThreadTurnNotificationBatchItem[];
}): string {
  const [input] = buildChildThreadTurnStatusBatchInput(args);
  if (!input || input.type !== "text") {
    throw new Error("Expected one text input");
  }
  return input.text;
}

describe("child thread notifications", () => {
  it("keeps final output for a single completed outcome", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child",
            title: "Fix checkout flow",
          }),
          terminalOutput: "Implemented the requested change.",
          turnStatus: "completed",
        },
      ],
    });

    expect(message).toContain(
      [
        "@thread:thr_child completed:",
        "",
        "Implemented the requested change.",
      ].join("\n"),
    );
    expect(message).not.toContain("Child thread updates:");
  });

  it("omits output for a single failed outcome", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child",
            title: "Patch deploy script",
          }),
          terminalOutput: "Deploy script failed on preflight.",
          turnStatus: "failed",
        },
      ],
    });

    expect(message).toContain(
      [
        "@thread:thr_child failed.",
        "",
        "Review the thread before deciding next steps.",
      ].join("\n"),
    );
    expect(message).not.toContain("Deploy script failed on preflight.");
  });

  it("omits terminal output for a single interrupted outcome", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child",
            title: "Fix checkout flow",
          }),
          terminalOutput: "Stopped after writing the checkout summary.",
          turnStatus: "interrupted",
        },
      ],
    });

    expect(message).toContain(
      [
        "@thread:thr_child was interrupted.",
        "",
        "Review the thread before deciding next steps.",
      ].join("\n"),
    );
    expect(message).not.toContain("Child thread updates:");
    expect(message).not.toContain(
      "Stopped after writing the checkout summary.",
    );
  });

  it("renders multiple child outcomes as status-only bullet lines", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_one",
            title: "Fix checkout flow",
          }),
          terminalOutput: "Checkout flow is fixed.",
          turnStatus: "completed",
        },
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_two",
            title: "Patch deploy script",
          }),
          terminalOutput: "Deploy script failed on preflight.",
          turnStatus: "failed",
        },
      ],
    });

    expect(message).toContain(
      [
        "[bb system]",
        "",
        "Child thread updates:",
        "",
        "- @thread:thr_child_one completed.",
        "- @thread:thr_child_two failed.",
      ].join("\n"),
    );
    expect(message).not.toContain("Checkout flow is fixed.");
    expect(message).not.toContain("Deploy script failed on preflight.");
  });

  it("builds mention ranges for batched outcome thread references", () => {
    const input = buildChildThreadTurnStatusBatchInput({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_one",
            title: "Fix checkout flow",
          }),
          terminalOutput: "Checkout flow is fixed.",
          turnStatus: "completed",
        },
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_two",
            title: null,
          }),
          terminalOutput: "Deploy script failed.",
          turnStatus: "failed",
        },
      ],
    });

    expect(input).toHaveLength(1);
    const [textInput] = input;
    if (!textInput || textInput.type !== "text") {
      throw new Error("Expected one text input");
    }
    expect(textInput).toEqual({
      type: "text",
      text: expect.stringContaining("@thread:thr_child_one"),
      mentions: [
        {
          start: expect.any(Number),
          end: expect.any(Number),
          resource: {
            kind: "thread",
            label: "Fix checkout flow",
            projectId: "proj_alpha",
            threadId: "thr_child_one",
          },
        },
        {
          start: expect.any(Number),
          end: expect.any(Number),
          resource: {
            kind: "thread",
            label: "thr_child_two",
            projectId: "proj_alpha",
            threadId: "thr_child_two",
          },
        },
      ],
    });
    expect(textInput.text).toContain("@thread:thr_child_two");
    expect(textInput.text).toContain("Child thread updates:");
    expect(
      textInput.mentions.map((mention) =>
        textInput.text.slice(mention.start, mention.end),
      ),
    ).toEqual(["@thread:thr_child_one", "@thread:thr_child_two"]);
  });

  it("does not render raw title suffixes next to rich thread mentions", () => {
    const nestedToken = "@thread:thr_child_two";
    const input = buildChildThreadTurnStatusBatchInput({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_one",
            title: `Title mentions ${nestedToken}`,
          }),
          terminalOutput: "Checkout flow is fixed.",
          turnStatus: "completed",
        },
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_two",
            title: "Second thread",
          }),
          terminalOutput: "Deploy script failed.",
          turnStatus: "failed",
        },
      ],
    });

    expect(input).toHaveLength(1);
    const [textInput] = input;
    if (!textInput || textInput.type !== "text") {
      throw new Error("Expected one text input");
    }

    const secondLineTokenStart = textInput.text.lastIndexOf(nestedToken);
    expect(textInput.text).not.toContain("Title mentions");
    expect(textInput.mentions.map((mention) => mention.start)).toEqual([
      textInput.text.indexOf("@thread:thr_child_one"),
      secondLineTokenStart,
    ]);
    expect(
      textInput.mentions.map((mention) =>
        textInput.text.slice(mention.start, mention.end),
      ),
    ).toEqual(["@thread:thr_child_one", nestedToken]);
  });

  it("renders a final output fallback for a completed child without output", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child",
            title: "Patch deploy script",
          }),
          terminalOutput: null,
          turnStatus: "completed",
        },
      ],
    });

    expect(message).toContain(
      [
        "@thread:thr_child completed:",
        "",
        "No final output was recorded.",
      ].join("\n"),
    );
  });

  it("flags a still-running workflow on a single completed outcome", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 1,
          childThread: testThread({
            id: "thr_child",
            title: "Rebalance archetypes",
          }),
          terminalOutput: "Kicked off the balance pass.",
          turnStatus: "completed",
        },
      ],
    });

    expect(message).toContain(
      [
        "@thread:thr_child completed, with 1 workflow still running:",
        "",
        "Kicked off the balance pass.",
        "",
        "A workflow it started is still running, so this output is not its final result. The thread will report again when the workflow finishes.",
      ].join("\n"),
    );
  });

  it("pluralizes and flags still-running workflows across batched outcomes", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 2,
          childThread: testThread({
            id: "thr_child_one",
            title: "Rebalance archetypes",
          }),
          terminalOutput: "Kicked off two workflows.",
          turnStatus: "completed",
        },
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_two",
            title: "Patch deploy script",
          }),
          terminalOutput: "Deploy script failed on preflight.",
          turnStatus: "failed",
        },
      ],
    });

    expect(message).toContain(
      [
        "Child thread updates:",
        "",
        "- @thread:thr_child_one completed, with 2 workflows still running.",
        "- @thread:thr_child_two failed.",
        "",
        "Threads with a workflow still running have not finished; they will report again when their workflow does.",
      ].join("\n"),
    );
  });

  it("builds mention ranges for needs-attention thread references", () => {
    const input = buildChildThreadNeedsAttentionInput({
      blockerSummary: null,
      childThread: testThread({
        id: "thr_child",
        title: "Backend cleanup",
      }),
    });

    expect(input).toHaveLength(1);
    const [textInput] = input;
    if (!textInput || textInput.type !== "text") {
      throw new Error("Expected one text input");
    }
    const threadMention = "@thread:thr_child";
    const mentionStart = textInput.text.indexOf(threadMention);
    expect(textInput.mentions).toEqual([
      {
        start: mentionStart,
        end: mentionStart + threadMention.length,
        resource: {
          kind: "thread",
          label: "Backend cleanup",
          projectId: "proj_alpha",
          threadId: "thr_child",
        },
      },
    ]);
    expect(textInput.text).toContain(
      "Review the blocker. If you can resolve it from existing context, reply to the thread with guidance.",
    );
  });

  it("renders needs-attention blocker summaries when provided", () => {
    const input = buildChildThreadNeedsAttentionInput({
      blockerSummary: ["Blocked on command approval:", "git push"].join("\n"),
      childThread: testThread({
        id: "thr_child",
        title: "Backend cleanup",
      }),
    });

    const [textInput] = input;
    if (!textInput || textInput.type !== "text") {
      throw new Error("Expected one text input");
    }

    expect(textInput.text).toContain(
      ["Blocked on command approval:", "git push"].join("\n"),
    );
    expect(textInput.text).not.toContain(
      "It is blocked on a pending interaction.",
    );
  });
});
