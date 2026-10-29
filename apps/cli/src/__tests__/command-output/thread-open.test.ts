import { describe, expect, it, vi } from "vitest";
import type { Environment, Thread } from "@bb/domain";
import type { ThreadOpenSkipReason } from "@bb/server-contract";
import {
  setupCommandOutputTestEnvironment,
  collectLogLines,
  collectLogPayloads,
  getHelpOutput,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import * as fixtures from "../helpers/command-output-fixtures.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

interface OpenThreadResult {
  deliveredClients: number;
  skipReason: ThreadOpenSkipReason | null;
}

type OpenThreadHandler = (
  request: unknown,
) => Promise<OpenThreadResult> | OpenThreadResult;

function stubThreadOpenApi(args: {
  environments?: Record<string, Environment>;
  open?: OpenThreadHandler;
  threads?: Record<string, Thread>;
}) {
  const getThread = vi.fn(async (request: unknown) => {
    const threadId = (request as { param: { id: string } }).param.id;
    const thread = args.threads?.[threadId];
    if (!thread) {
      throw new Error(`missing test thread ${threadId}`);
    }
    return thread;
  });
  const getEnvironment = vi.fn(async (request: unknown) => {
    const environmentId = (request as { param: { id: string } }).param.id;
    const environment = args.environments?.[environmentId];
    if (!environment) {
      throw new Error(`missing test environment ${environmentId}`);
    }
    return environment;
  });
  const openThread = vi.fn(args.open ??
      (async () => ({ deliveredClients: 0, skipReason: null })));
  stubServerApi({
    "v1.threads.:id.$get": getThread,
    "v1.environments.:id.$get": getEnvironment,
    "v1.threads.:id.open.$post": openThread,
  });
  return { getEnvironment, getThread, openThread };
}

describe("bb thread open command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it("uses BB_THREAD_ID and opens a thread-relative workspace path", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-current");
    const { openThread } = stubThreadOpenApi({
      open: async () => ({ deliveredClients: 2, skipReason: null }),
    });

    await runCommand(["thread", "open", "reports/status.md"], register);

    expect(openThread).toHaveBeenCalledWith({
      param: { id: "thread-current" },
      json: {
        callerThreadId: "thread-current",
        file: {
          source: "workspace",
          path: "reports/status.md",
          lineNumber: null,
        },
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Thread: thread-current",
      "Split: replace",
      "Source: workspace",
      "Path: reports/status.md",
      "Request sent to 2 open bb app clients; receipt and application are not confirmed.",
    ]);
  });

  it("resolves an absolute workspace path through the target thread environment", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-workspace");
    const thread = fixtures.makeThread({
      id: "thread-workspace",
      projectId: "proj-workspace",
      providerId: "codex",
      environmentId: "env-workspace",
    });
    const environment = fixtures.makeEnvironment({
      id: "env-workspace",
      projectId: "proj-workspace",
      hostId: "host-test-001",
      path: "/Users/sawyerhood/project/workspaces/thread-workspace",
    });
    const { getEnvironment, getThread, openThread } = stubThreadOpenApi({
      environments: { "env-workspace": environment },
      open: async () => ({ deliveredClients: 1, skipReason: null }),
      threads: { "thread-workspace": thread },
    });

    await runCommand(
      [
        "thread",
        "open",
        "/Users/sawyerhood/project/workspaces/thread-workspace/reports/status.md",
        "--line",
        "7",
      ],
      register,
    );

    expect(getThread).toHaveBeenCalledWith({
      param: { id: "thread-workspace" },
    });
    expect(getEnvironment).toHaveBeenCalledWith({
      param: { id: "env-workspace" },
    });
    expect(openThread).toHaveBeenCalledWith({
      param: { id: "thread-workspace" },
      json: {
        callerThreadId: "thread-workspace",
        file: {
          source: "workspace",
          path: "reports/status.md",
          lineNumber: 7,
        },
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Thread: thread-workspace",
      "Split: replace",
      "Source: workspace",
      "Path: reports/status.md",
      "Line: 7",
      "Request sent to 1 open bb app client; receipt and application are not confirmed.",
    ]);
  });

  it("opens an absolute thread-storage path for the current thread", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-storage");
    vi.stubEnv("BB_THREAD_STORAGE", "/tmp/bb-thread-storage/thread-storage");
    const { getEnvironment, getThread, openThread } = stubThreadOpenApi({
      open: async () => ({ deliveredClients: 1, skipReason: null }),
    });

    await runCommand(
      [
        "thread",
        "open",
        "/tmp/bb-thread-storage/thread-storage/reports/preview.html",
      ],
      register,
    );

    expect(getThread).not.toHaveBeenCalled();
    expect(getEnvironment).not.toHaveBeenCalled();
    expect(openThread).toHaveBeenCalledWith({
      param: { id: "thread-storage" },
      json: {
        callerThreadId: "thread-storage",
        file: {
          source: "thread-storage",
          path: "reports/preview.html",
          lineNumber: null,
        },
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Thread: thread-storage",
      "Split: replace",
      "Source: thread-storage",
      "Path: reports/preview.html",
      "Request sent to 1 open bb app client; receipt and application are not confirmed.",
    ]);
  });

  it("requires an explicit thread id outside a BB thread", async () => {
    stubThreadOpenApi({});

    await expect(runCommand(["thread", "open"], register)).rejects.toThrow(
      "process.exit:1",
    );
  });

  it("returns the opened path as JSON", async () => {
    const { openThread } = stubThreadOpenApi({
      open: async () => ({ deliveredClients: 3, skipReason: null }),
    });

    await runCommand(
      ["thread", "open", "thread-explicit", "reports/status.md", "--json"],
      register,
    );

    expect(openThread).toHaveBeenCalledWith({
      param: { id: "thread-explicit" },
      json: {
        file: {
          source: "workspace",
          path: "reports/status.md",
          lineNumber: null,
        },
      },
    });
    const payloads = collectLogPayloads(vi.mocked(console.log));
    expect(payloads.join("\n")).toContain('"threadId": "thread-explicit"');
    expect(payloads.join("\n")).toContain('"split": "replace"');
    expect(payloads.join("\n")).toContain('"source": "workspace"');
    expect(payloads.join("\n")).toContain('"path": "reports/status.md"');
    expect(payloads.join("\n")).toContain('"deliveredClients": 3');
  });

  it("does not offer the removed flags in help", async () => {
    const help = await getHelpOutput(["thread", "open"], register);

    expect(help).not.toContain("--preview");
    expect(help).not.toContain("--source");
    expect(help).not.toContain("--self");
  });

  it("opens a thread in a split without requiring a file path", async () => {
    const { openThread } = stubThreadOpenApi({
      open: async () => ({ deliveredClients: 2, skipReason: null }),
    });

    await runCommand(
      ["thread", "open", "thread-split", "--split", "right"],
      register,
    );

    expect(openThread).toHaveBeenCalledWith({
      param: { id: "thread-split" },
      json: { split: "right", file: null },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Thread: thread-split",
      "Split: right",
      "Request sent to 2 open bb app clients; receipt and application are not confirmed.",
    ]);
  });

  it("opens another thread from a lone thread id inside a BB thread", async () => {
    vi.stubEnv("BB_THREAD_ID", "thr_currentabc");
    const { openThread } = stubThreadOpenApi({});

    await runCommand(["thread", "open", "thr_2thread345"], register);

    expect(openThread).toHaveBeenCalledWith({
      param: { id: "thr_2thread345" },
      json: { callerThreadId: "thr_currentabc", file: null },
    });
  });

  it("opens a ./-prefixed file named like a thread id in the current thread", async () => {
    vi.stubEnv("BB_THREAD_ID", "thr_currentabc");
    const { openThread } = stubThreadOpenApi({});

    await runCommand(["thread", "open", "./thr_2thread345"], register);

    expect(openThread).toHaveBeenCalledWith({
      param: { id: "thr_currentabc" },
      json: {
        callerThreadId: "thr_currentabc",
        file: { source: "workspace", path: "thr_2thread345", lineNumber: null },
      },
    });
  });

  it("opens a file in another thread inside a BB thread", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-current");
    const { openThread } = stubThreadOpenApi({});

    await runCommand(
      ["thread", "open", "thread-other", "reports/status.md"],
      register,
    );

    expect(openThread).toHaveBeenCalledWith({
      param: { id: "thread-other" },
      json: {
        callerThreadId: "thread-current",
        file: {
          source: "workspace",
          path: "reports/status.md",
          lineNumber: null,
        },
      },
    });
  });

  it("rejects an invalid split placement before calling the server", async () => {
    const { openThread } = stubThreadOpenApi({});

    await expect(
      runCommand(
        ["thread", "open", "thread-split", "--split", "diagonal"],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(openThread).not.toHaveBeenCalled();
  });

  it("sends to every open app client with --all and names no caller", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-current");
    const { openThread } = stubThreadOpenApi({
      open: async () => ({ deliveredClients: 3, skipReason: null }),
    });

    await runCommand(
      ["thread", "open", "thread-other", "reports/status.md", "--all"],
      register,
    );

    expect(openThread).toHaveBeenCalledWith({
      param: { id: "thread-other" },
      json: {
        all: true,
        file: {
          source: "workspace",
          path: "reports/status.md",
          lineNumber: null,
        },
      },
    });
  });

  it("exits non-zero and names --all when no client views the caller thread", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-current");
    stubThreadOpenApi({
      open: async () => ({
        deliveredClients: 0,
        skipReason: "no_client_viewing_caller_thread",
      }),
    });

    await expect(
      runCommand(["thread", "open", "thread-other"], register),
    ).rejects.toThrow("process.exit:1");

    expect(collectLogLines(vi.mocked(console.log))).toEqual([]);
    expect(
      vi
        .mocked(console.error)
        .mock.calls.map((call) => call.join(" "))
        .join("\n"),
    ).toContain("Pass --all to send to every open bb app client");
  });

  it("reports the skip reason in JSON and exits non-zero outside a thread", async () => {
    stubThreadOpenApi({
      open: async () => ({
        deliveredClients: 0,
        skipReason: "no_caller_thread",
      }),
    });

    await expect(
      runCommand(["thread", "open", "thread-other", "--json"], register),
    ).rejects.toThrow("process.exit:1");

    const payloads = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(payloads).toContain('"skipReason": "no_caller_thread"');
    expect(payloads).toContain('"deliveredClients": 0');
  });
});
