// @vitest-environment jsdom

import { cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import {
  environmentPullRequestSchema,
  type EnvironmentPullRequest,
  type PullRequest,
} from "../contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEnvironmentPullRequest } from "./queries";
import { readEnvironmentPullRequestResults } from "../producer";
import githubPrStatusPlugin from "../server";

const keyedQuery = vi.hoisted(() => ({
  data: {} as Record<string, EnvironmentPullRequest>,
  refetch: vi.fn(async (_keys: readonly string[]) => {}),
  refresh: vi.fn(async (_input: { environmentId: string }) => ({
    ok: true as const,
  })),
  calls: [] as Array<{ method: string; keys: readonly string[] }>,
  rpcCall: null as
    | ((input: { method: string; keys: readonly string[] }) => Promise<unknown>)
    | null,
}));

function useMockKeyedQuery(input: { method: string; keys: readonly string[] }) {
  keyedQuery.calls.push(input);
  const [rpcData, setRpcData] = useState<Record<string, unknown>>({});
  const method = input.method;
  const encodedKeys = input.keys.join("\u0000");
  useEffect(() => {
    let active = true;
    if (keyedQuery.rpcCall === null)
      return () => {
        active = false;
      };
    void keyedQuery
      .rpcCall({
        method,
        keys: encodedKeys === "" ? [] : encodedKeys.split("\u0000"),
      })
      .then((result) => {
        if (active) setRpcData(result as Record<string, unknown>);
      });
    return () => {
      active = false;
    };
  }, [encodedKeys, method]);
  return {
    data: keyedQuery.rpcCall === null ? keyedQuery.data : rpcData,
    error: null,
    isLoading: false,
    isFetching: false,
    refetch: () => keyedQuery.refetch(input.keys),
  };
}

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_useRpcKeyedQuery: useMockKeyedQuery,
  experimental_useRpcMutation: (options: { method: string }) => ({
    mutate:
      options.method === "refresh"
        ? (input: { environmentId: string }) => keyedQuery.refresh(input)
        : vi.fn(),
    isPending: false,
  }),
}));

function row(state: PullRequest["state"]): EnvironmentPullRequest {
  return {
    outcome: "available",
    pullRequest: {
      number: 7,
      title: "Ship it",
      state,
      url: "https://github.com/acme/bb/pull/7",
      baseRefName: "main",
      headRefName: "bb/ship",
      updatedAt: "2026-10-22T00:00:00Z",
      autoMerge: false,
      inMergeQueue: false,
      checks: {
        state: "passing",
        totalCount: 1,
        passedCount: 1,
        failedCount: 0,
        pendingCount: 0,
      },
      review: { state: "none", reviewRequestCount: 0 },
      mergeability: {
        state: "mergeable",
        mergeStateStatus: "CLEAN",
        mergeable: "MERGEABLE",
      },
      attention: "ready_to_merge",
    },
  };
}

type Environment = Awaited<
  ReturnType<BbPluginApi["sdk"]["environments"]["get"]>
>;

function rpcEnvironment(): Environment {
  return {
    id: "env-rpc",
    createdAt: 1,
    name: null,
    projectId: "project-1",
    hostId: "host-1",
    path: "/work/env-rpc",
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
    updatedAt: 1,
    workspaceProvisionType: "managed-worktree",
  };
}

async function bootRpcPlugin() {
  const fake = createFakePluginHost({
    pluginId: "bb--github-pr-status",
    sdk: {
      subscribe: () => () => {},
      threads: { events: { list: async () => [] } },
      environments: { get: async () => rpcEnvironment() },
      hosts: { get: async () => makeHostResponse() },
    },
    experimental_callHostRpc: (call) =>
      call.method === "upstream"
        ? { oid: null, branchName: "bb/pr" }
        : (call.input as { reads: unknown[] }).reads.map(() => ({
            outcome: "found",
            pullRequest: {
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
              updatedAt: "2026-10-22T00:00:00Z",
              checks: [],
              reviewDecision: null,
              reviewRequestCount: 0,
              mergeStateStatus: "CLEAN",
              mergeable: "MERGEABLE",
            },
          })),
  });
  await githubPrStatusPlugin(fake.bb);
  return fake;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function showPage(): Promise<void> {
  document.dispatchEvent(new Event("visibilitychange"));
  await settle();
}

afterEach(() => {
  cleanup();
  keyedQuery.refetch.mockClear();
  keyedQuery.refresh.mockClear();
  keyedQuery.calls.length = 0;
  keyedQuery.data = {};
  keyedQuery.rpcCall = null;
});

describe("useEnvironmentPullRequest refreshes", () => {
  it("reads registered server RPC output through the environment-keyed consumer", async () => {
    const fake = await bootRpcPlugin();
    keyedQuery.rpcCall = ({ method, keys }) =>
      fake.harness.callRpc(method, { keys });

    const result = renderHook(() => useEnvironmentPullRequest("env-rpc"));

    await waitFor(() =>
      expect(result.result.current.pullRequest?.number).toBe(7),
    );
    expect(keyedQuery.calls[0]).toMatchObject({
      method: "pullRequests",
      keys: ["env-rpc"],
    });
    expect(
      fake.harness.experimental_hostRpcCalls.map((call) => call.method),
    ).toEqual(["upstream", "views"]);
    await fake.harness.dispose();
  });

  it("consumes the producer's outcomes by environment id at the RPC boundary", async () => {
    const rows: Record<string, EnvironmentPullRequest> = {
      "env-available": row("open"),
      "env-absent": { outcome: "absent" },
      "env-unavailable": {
        outcome: "unavailable",
        message: "Host is suspended",
      },
    };
    const produced = await readEnvironmentPullRequestResults(
      ["env-available", "env-absent", "env-unavailable"],
      async (environmentId) => rows[environmentId]!,
    );
    const producerOutput = Object.fromEntries(
      Object.entries(produced).map(([environmentId, value]) => [
        environmentId,
        environmentPullRequestSchema.parse(value),
      ]),
    );
    keyedQuery.data = producerOutput;

    const available = renderHook(() =>
      useEnvironmentPullRequest("env-available"),
    );
    const absent = renderHook(() => useEnvironmentPullRequest("env-absent"));
    const unavailable = renderHook(() =>
      useEnvironmentPullRequest("env-unavailable"),
    );

    expect(available.result.current.pullRequest?.number).toBe(7);
    expect(absent.result.current).toEqual({
      isLoading: false,
      pullRequest: null,
    });
    expect(unavailable.result.current).toEqual({
      isLoading: false,
      pullRequest: null,
    });
    expect(keyedQuery.calls.slice(0, 3).map((call) => call.keys)).toEqual([
      ["env-available"],
      ["env-absent"],
      ["env-unavailable"],
    ]);
  });

  it("owns its environment-keyed query in the plugin RPC contract", () => {
    renderHook(() => useEnvironmentPullRequest("env-1"));

    expect(keyedQuery.calls[0]).toMatchObject({
      method: "pullRequests",
      keys: ["env-1"],
    });
  });

  it("re-checks GitHub when a thread's PR first shows, before its row has loaded", async () => {
    renderHook(() => useEnvironmentPullRequest("env-new"));
    await settle();
    expect(keyedQuery.refresh.mock.calls).toEqual([
      [{ environmentId: "env-new" }],
    ]);
    expect(keyedQuery.refetch).not.toHaveBeenCalled();
  });

  it("re-checks GitHub when a cached row shows again, then refetches each time the page shows", async () => {
    keyedQuery.data = { "env-open": row("open") };
    renderHook(() => useEnvironmentPullRequest("env-open"));
    await settle();
    expect(keyedQuery.refresh).toHaveBeenCalledTimes(1);
    expect(keyedQuery.refetch).not.toHaveBeenCalled();

    await showPage();
    await showPage();
    expect(keyedQuery.refetch.mock.calls).toEqual([
      [["env-open"]],
      [["env-open"]],
    ]);
    expect(keyedQuery.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refetch while the page is hidden", async () => {
    keyedQuery.data = { "env-hidden": row("open") };
    renderHook(() => useEnvironmentPullRequest("env-hidden"));
    await settle();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    try {
      await showPage();
      expect(keyedQuery.refetch).not.toHaveBeenCalled();
    } finally {
      visibility.mockRestore();
    }
  });

  it("re-checks only when an environment starts showing, not for each extra view", async () => {
    keyedQuery.data = { "env-shared": row("open") };
    const banner = renderHook(() => useEnvironmentPullRequest("env-shared"));
    await settle();
    expect(keyedQuery.refresh).toHaveBeenCalledTimes(1);

    const infoRow = renderHook(() => useEnvironmentPullRequest("env-shared"));
    await settle();
    expect(keyedQuery.refresh).toHaveBeenCalledTimes(1);

    banner.unmount();
    infoRow.unmount();
    await settle();
    renderHook(() => useEnvironmentPullRequest("env-shared"));
    await settle();
    expect(keyedQuery.refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps an environment shown when its view remounts in one commit", async () => {
    keyedQuery.data = { "env-remount": row("open") };
    function View() {
      useEnvironmentPullRequest("env-remount");
      return null;
    }
    const { rerender } = render(<View key="thr_a" />);
    await settle();
    keyedQuery.refresh.mockClear();

    rerender(<View key="thr_b" />);
    await settle();
    expect(keyedQuery.refresh).not.toHaveBeenCalled();
  });
});
