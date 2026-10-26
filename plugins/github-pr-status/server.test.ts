import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
  type ExperimentalFakeHostRpcCall,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  environmentPullRequestSchema,
  type GitHubPullRequestView,
} from "./contract.js";
import plugin, { environmentChangeEffect } from "./server.js";

type Environment = Awaited<
  ReturnType<BbPluginApi["sdk"]["environments"]["get"]>
>;

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    name: null,
    projectId: "project-1",
    hostId: "host-1",
    path: "/work/env-1",
    isGitRepo: true,
    isWorktree: true,
    branchName: "bb/pr",
    baseBranch: null,
    defaultBranch: "main",
    mergeBaseBranch: null,
    status: "ready",
    environmentProviderId: "git-worktree",
    lifecycle: { phase: "active", retireAt: null, teardown: null },
    hostLifecycle: "active",
    environmentProviderSelection: null,
    environmentProviderInstanceKey: null,
    managed: true,
    workspaceProvisionType: "worktree",
    ...overrides,
  } as Environment;
}

function view(
  overrides: Partial<GitHubPullRequestView> = {},
): GitHubPullRequestView {
  return {
    number: 7,
    title: "Ship it",
    state: "OPEN",
    url: "https://github.com/acme/bb/pull/7",
    isDraft: false,
    autoMerge: false,
    inMergeQueue: false,
    baseRefName: "main",
    headRefName: "bb/pr",
    headRefOid: null,
    updatedAt: "2026-10-01T00:00:00Z",
    checks: [],
    reviewDecision: null,
    reviewRequestCount: 0,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    ...overrides,
  };
}

async function setup(options: {
  environments?: Record<string, Environment>;
  host?: Parameters<typeof makeHostResponse>[0];
  callHost?: (call: ExperimentalFakeHostRpcCall) => unknown;
  listThreadEvents?: BbPluginApi["sdk"]["threads"]["events"]["list"];
}) {
  const environments = options.environments ?? { "env-1": environment() };
  const sdkCalls: string[] = [];
  const whileWatchedHandlers = new Map<
    string,
    Parameters<BbPluginApi["rpc"]["experimental_whileWatched"]>[1]
  >();
  const fake = createFakePluginHost({
    pluginId: "bb--github-pr-status",
    sdk: {
      subscribe: () => () => {},
      threads: {
        events: { list: options.listThreadEvents ?? (async () => []) },
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => {
          sdkCalls.push(`environments.get ${environmentId}`);
          const found = environments[environmentId];
          if (found === undefined) {
            throw Object.assign(new Error("Environment not found"), {
              status: 404,
            });
          }
          return found;
        },
      },
      hosts: {
        get: async () => {
          sdkCalls.push("hosts.get");
          return makeHostResponse(options.host);
        },
      },
    },
    experimental_callHostRpc:
      options.callHost ??
      ((call) =>
        call.method === "upstream"
          ? { oid: null, branchName: "bb/pr" }
          : call.method === "view"
            ? { outcome: "found", pullRequest: view() }
            : { ok: true }),
  });
  vi.spyOn(fake.bb.rpc, "experimental_whileWatched").mockImplementation(
    (method, handler) => {
      whileWatchedHandlers.set(method, handler);
    },
  );
  await plugin(fake.bb);
  return Object.assign(fake, {
    sdkCalls,
    async watchPullRequests(environmentId: string) {
      const handler = whileWatchedHandlers.get("pullRequests");
      if (handler === undefined)
        throw new Error(
          "pullRequests while-watched handler was not registered",
        );
      const controller = new AbortController();
      await handler({ key: environmentId }, controller.signal);
      return () => controller.abort();
    },
  });
}

describe("GitHub PR Status server", () => {
  it.each([
    ["available", { outcome: "found", pullRequest: view() }],
    ["absent", { outcome: "none" }],
    ["unavailable", { outcome: "unavailable", message: "Host suspended" }],
  ] as const)(
    "emits a schema-valid %s row keyed by environment id",
    async (_outcome, lookup) => {
      const fake = await setup({
        callHost: (call) =>
          call.method === "upstream"
            ? { oid: null, branchName: "bb/pr" }
            : lookup,
      });

      const result = z.record(z.string(), environmentPullRequestSchema).parse(
        await fake.harness.callRpc("pullRequests", {
          keys: ["env-1"],
        }),
      );

      expect(Object.keys(result)).toEqual(["env-1"]);
      expect(environmentPullRequestSchema.parse(result["env-1"])).toEqual(
        result["env-1"],
      );
      if (_outcome === "available")
        expect(result["env-1"]?.outcome).toBe("available");
      if (_outcome === "absent")
        expect(result["env-1"]).toEqual({ outcome: "absent" });
      if (_outcome === "unavailable")
        expect(result["env-1"]?.outcome).toBe("unavailable");
    },
  );

  afterEach(() => vi.useRealTimers());

  it("keeps identical snapshots unchanged across a real plugin database reload", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = await setup({});
    await fake.harness.callRpc("pullRequests", {
      keys: ["env-1"],
    });
    const next = await fake.harness.reload(plugin);
    const before = next.bb.storage
      .database()
      .prepare("SELECT total_changes() AS n")
      .get();
    vi.setSystemTime(Date.now() + 11_000);
    await next.harness.callRpc("pullRequests", {
      keys: ["env-1"],
    });
    expect(
      next.bb.storage.database().prepare("SELECT total_changes() AS n").get(),
    ).toEqual(before);
    await next.harness.dispose();
  });

  it.each([
    ["stale snapshot shape", JSON.stringify({ number: 7 })],
    ["malformed snapshot JSON", "{invalid"],
  ])("discards %s on reload and refetches", async (_, content) => {
    const fake = await setup({});
    await fake.harness.callRpc("pullRequests", {
      keys: ["env-1"],
    });
    fake.bb.storage
      .database()
      .prepare("UPDATE snapshots SET content = ?")
      .run(content);

    const next = await fake.harness.reload(plugin);
    expect(
      next.bb.storage.database().prepare("SELECT url FROM snapshots").all(),
    ).toEqual([]);
    await expect(
      next.harness.callRpc("pullRequests", { keys: ["env-1"] }),
    ).resolves.toMatchObject({
      "env-1": {
        outcome: "available",
        pullRequest: { number: 7, title: "Ship it" },
      },
    });
    expect(
      next.harness.experimental_hostRpcCalls.filter(
        (call) => call.method === "view",
      ),
    ).toHaveLength(1);
    await next.harness.dispose();
  });

  it("serves cached rows without looking up the environment or machine again", async () => {
    const fake = await setup({});
    await fake.harness.callRpc("pullRequests", { keys: ["env-1"] });
    fake.sdkCalls.length = 0;
    await expect(
      fake.harness.callRpc("pullRequests", { keys: ["env-1"] }),
    ).resolves.toMatchObject({
      "env-1": { outcome: "available", pullRequest: { number: 7 } },
    });
    expect(fake.sdkCalls).toEqual([]);
    expect(
      fake.harness.experimental_hostRpcCalls.filter(
        (call) => call.method === "view",
      ),
    ).toHaveLength(1);
  });

  it("reads every requested environment in one call", async () => {
    const fake = await setup({
      environments: {
        "env-1": environment(),
        "env-plain": environment({ id: "env-plain", isGitRepo: false }),
        "env-asleep": environment({ id: "env-asleep", hostId: "host-2" }),
      },
      callHost: (call) => {
        if (call.hostId === "host-2") throw new Error("Host is suspended");
        if (call.method === "upstream")
          return { oid: null, branchName: "bb/pr" };
        return { outcome: "found", pullRequest: view() };
      },
    });

    await expect(
      fake.harness.callRpc("pullRequests", {
        keys: ["env-1", "env-plain", "env-asleep", "env-missing"],
      }),
    ).resolves.toEqual({
      "env-1": {
        outcome: "available",
        pullRequest: expect.objectContaining({
          number: 7,
          state: "open",
          attention: "none",
        }),
      },
      "env-plain": { outcome: "absent" },
      "env-asleep": { outcome: "unavailable", message: "Host is suspended" },
      "env-missing": { outcome: "absent" },
    });
    expect(
      fake.harness.experimental_hostRpcCalls.filter(
        (call) => call.method === "view",
      ),
    ).toMatchObject([
      {
        method: "view",
        input: { path: "/work/env-1", url: null, refresh: false },
        hostId: "host-1",
      },
    ]);
  });

  it("invalidates a watched environment's pull request after a completed turn", async () => {
    const fake = await setup({});
    const stopWatching = await fake.watchPullRequests("env-1");
    await fake.harness.callRpc("pullRequests", { keys: ["env-1"] });
    expect(
      fake.harness.experimental_hostRpcCalls.filter(
        (call) => call.method === "view",
      ),
    ).toHaveLength(1);

    fake.harness.experimental_rpcInvalidations.length = 0;
    const emitted = await fake.harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ environmentId: "env-1" }),
      lastAssistantText: null,
    });

    expect(emitted.errors).toEqual([]);
    expect(fake.harness.experimental_rpcInvalidations).toContainEqual([
      "environment:env-1",
    ]);
    await fake.harness.callRpc("pullRequests", { keys: ["env-1"] });
    expect(
      fake.harness.experimental_hostRpcCalls.filter(
        (call) => call.method === "view",
      ),
    ).toHaveLength(1);
    stopWatching();
  });

  it("does nothing for an unwatched environment after a completed turn", async () => {
    const fake = await setup({});
    await fake.harness.callRpc("pullRequests", { keys: ["env-1"] });
    fake.harness.experimental_rpcInvalidations.length = 0;

    const emitted = await fake.harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ environmentId: "env-1" }),
      lastAssistantText: null,
    });

    expect(emitted.errors).toEqual([]);
    expect(fake.harness.experimental_rpcInvalidations).toEqual([]);
    expect(
      fake.harness.experimental_hostRpcCalls.filter(
        (call) => call.method === "view",
      ),
    ).toHaveLength(1);
  });

  it("does not call GitHub when a watched existing PR completes a turn without gh", async () => {
    const fake = await setup({});
    const stopWatching = await fake.watchPullRequests("env-1");
    await fake.harness.callRpc("pullRequests", { keys: ["env-1"] });
    fake.harness.experimental_rpcInvalidations.length = 0;

    const emitted = await fake.harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ environmentId: "env-1" }),
      lastAssistantText: null,
    });
    expect(emitted.errors).toEqual([]);
    await fake.harness.callRpc("pullRequests", { keys: ["env-1"] });
    expect(
      fake.harness.experimental_hostRpcCalls.filter(
        (call) => call.method === "view",
      ),
    ).toHaveLength(1);
    expect(fake.harness.sdk.callsTo("threads.events.list")).toHaveLength(1);
    stopWatching();
  });

  it("refreshes and invalidates when thread event lookup rejects", async () => {
    const fake = await setup({
      listThreadEvents: async () => {
        throw new Error("event history unavailable");
      },
    });
    const stopWatching = await fake.watchPullRequests("env-1");
    await fake.harness.callRpc("pullRequests", { keys: ["env-1"] });
    fake.harness.experimental_rpcInvalidations.length = 0;

    const emitted = await fake.harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ environmentId: "env-1" }),
      lastAssistantText: null,
    });

    expect(emitted.errors).toEqual([]);
    expect(fake.harness.experimental_rpcInvalidations).toContainEqual([
      "environment:env-1",
    ]);
    await vi.waitFor(() =>
      expect(
        fake.harness.experimental_hostRpcCalls.filter(
          (call) => call.method === "view",
        ),
      ).toHaveLength(2),
    );
    stopWatching();
  });

  it("refreshes and invalidates the watched PR after a failed turn that ran gh", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(1_000_000));
    let pullRequest = view();
    const listThreadEvents: BbPluginApi["sdk"]["threads"]["events"]["list"] =
      async () => [
        {
          id: "event-1",
          scope: { kind: "turn", turnId: "turn-1" },
          threadId: "thread-1",
          seq: 2,
          createdAt: 1,
          type: "item/started",
          data: {
            providerThreadId: "provider-thread-1",
            item: {
              type: "commandExecution",
              id: "item-1",
              command: "gh pr edit 7 --title Updated",
              cwd: "/work/env-1",
              status: "completed",
              approvalStatus: null,
            },
          },
        },
      ];
    const fake = await setup({
      listThreadEvents,
      callHost: (call) =>
        call.method === "upstream"
          ? { oid: null, branchName: "bb/pr" }
          : call.method === "view"
            ? { outcome: "found", pullRequest }
            : { ok: true },
    });
    const stopWatching = await fake.watchPullRequests("env-1");
    await fake.harness.callRpc("pullRequests", { keys: ["env-1"] });
    fake.harness.experimental_rpcInvalidations.length = 0;
    pullRequest = view({ title: "Updated" });
    vi.setSystemTime(new Date(1_011_000));

    const emitted = await fake.harness.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ environmentId: "env-1" }),
      error: "failed after updating the pull request",
    });

    expect(emitted.errors).toEqual([]);
    expect(fake.harness.experimental_rpcInvalidations).toContainEqual([
      "environment:env-1",
    ]);
    await expect(
      fake.harness.callRpc("pullRequests", { keys: ["env-1"] }),
    ).resolves.toMatchObject({
      "env-1": { outcome: "available", pullRequest: { title: "Updated" } },
    });
    expect(
      fake.harness.experimental_hostRpcCalls.filter(
        (call) => call.method === "view",
      ),
    ).toHaveLength(2);
    stopWatching();
  });

  it("refreshes and invalidates when thread event lookup rejects", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(1_000_000));
    const listThreadEvents = vi.fn(async () => {
      throw new Error("events unavailable");
    });
    const fake = await setup({ listThreadEvents });
    const stopWatching = await fake.watchPullRequests("env-1");
    await fake.harness.callRpc("pullRequests", { keys: ["env-1"] });
    expect(
      fake.harness.experimental_hostRpcCalls.filter(
        (call) => call.method === "view",
      ),
    ).toHaveLength(1);

    fake.harness.experimental_rpcInvalidations.length = 0;
    vi.setSystemTime(new Date(1_011_000));
    const emitted = await fake.harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ environmentId: "env-1" }),
      lastAssistantText: null,
    });

    expect(emitted.errors).toEqual([]);
    expect(listThreadEvents).toHaveBeenCalledOnce();
    expect(fake.harness.experimental_rpcInvalidations).toContainEqual([
      "environment:env-1",
    ]);
    await fake.harness.callRpc("pullRequests", { keys: ["env-1"] });
    expect(
      fake.harness.experimental_hostRpcCalls.filter(
        (call) => call.method === "view",
      ),
    ).toHaveLength(2);
    stopWatching();
  });

  it("refuses actions without calling a machine that isn't available", async () => {
    const fake = await setup({
      host: {
        name: "Sandbox",
        status: "disconnected",
        lifecycle: {
          phase: "suspended",
          suspendedAt: 1,
          message: null,
          pendingLog: "",
          teardown: null,
        },
      },
    });

    await expect(
      fake.harness.callRpc("merge", {
        environmentId: "env-1",
        method: "squash",
        expectedHeadOid: "a".repeat(40),
        expectedHost: "github.com",
        expectedRepository: "acme/bb",
        expectedNumber: 7,
        expectedBaseRef: "main",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("Sandbox isn't available"),
    });
    expect(fake.harness.experimental_hostRpcCalls).toEqual([]);
  });

  it("checks the current pull request state before running an action", async () => {
    const fake = await setup({});

    await expect(
      fake.harness.callRpc("markReady", { environmentId: "env-1" }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Pull request is not a draft",
    });
    await expect(
      fake.harness.callRpc("merge", {
        environmentId: "env-1",
        method: "rebase",
        expectedHeadOid: "a".repeat(40),
        expectedHost: "github.com",
        expectedRepository: "acme/bb",
        expectedNumber: 7,
        expectedBaseRef: "main",
      }),
    ).resolves.toEqual({ message: "Pull request merge started" });
    expect(
      fake.harness.experimental_hostRpcCalls.filter(
        (call) => call.method === "act",
      ),
    ).toMatchObject([
      {
        input: {
          path: "/work/env-1",
          action: {
            operation: "merge",
            method: "rebase",
            expectedHeadOid: "a".repeat(40),
          },
        },
        hostId: "host-1",
      },
    ]);
  });

  it("returns the gh failure as a refusal and the CLI prints it", async () => {
    const fake = await setup({
      callHost: (call) =>
        call.method === "upstream"
          ? { oid: null, branchName: "bb/pr" }
          : call.method === "upstream"
            ? { oid: null, branchName: "bb/pr" }
            : call.method === "view"
              ? { outcome: "found", pullRequest: view({ isDraft: true }) }
              : { ok: false, message: "gh pr ready failed: HTTP 403" },
    });

    await expect(
      fake.harness.callRpc("markReady", { environmentId: "env-1" }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "gh pr ready failed: HTTP 403",
    });
    await expect(
      fake.harness.runCli(["ready", "env-1"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("gh pr ready failed: HTTP 403"),
    });
  });

  it("the CLI refuses a merge without the reviewed head commit and starts no host action", async () => {
    const fake = await setup({});

    await expect(
      fake.harness.runCli(["merge", "env-1"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining(
        "Merge needs the head commit you reviewed: pass --expected-head-oid <oid> (shown as 'Head commit' by `bb pull-request`)",
      ),
    });
    expect(
      fake.harness.experimental_hostRpcCalls.filter(
        (call) => call.method === "act",
      ),
    ).toEqual([]);
  });

  it("the CLI prints the host's changed-since-shown refusal for a mismatched head commit", async () => {
    const fake = await setup({
      callHost: (call) =>
        call.method === "upstream"
          ? { oid: null, branchName: "bb/pr" }
          : call.method === "view"
            ? { outcome: "found", pullRequest: view() }
            : {
                ok: false,
                message:
                  "The pull request changed since it was shown. Refresh it and try again",
              },
    });

    await expect(
      fake.harness.runCli([
        "merge",
        "env-1",
        "--expected-head-oid",
        "b".repeat(40),
        "--expected-host",
        "github.com",
        "--expected-repository",
        "acme/bb",
        "--expected-number",
        "7",
        "--expected-base-ref",
        "main",
      ]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining(
        "The pull request changed since it was shown. Refresh it and try again",
      ),
    });
  });

  it.each([
    [["status-changed"], "refresh"],
    [["environment-created"], "refresh"],
    [["environment-deleted"], "refresh"],
    [["metadata-changed"], "branch"],
    [["git-refs-changed", "metadata-changed"], "branch"],
    [["git-refs-changed"], "invalidate"],
    [["work-status-changed"], null],
    [["thread-storage-changed", "diff-viewed-changed"], null],
  ] as const)(
    "maps environment changes %j to %s, re-checking only where main did",
    (changes, effect) => {
      expect(environmentChangeEffect(changes)).toBe(effect);
    },
  );
});
