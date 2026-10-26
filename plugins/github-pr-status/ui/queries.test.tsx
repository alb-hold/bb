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
import {
  isEnvironmentPullRequestStale,
  useEnvironmentPullRequest,
} from "./queries";
import { readEnvironmentPullRequestResults } from "../producer";
import githubPrStatusPlugin from "../server";

const keyedQuery = vi.hoisted(() => ({
  data: {} as Record<string, EnvironmentPullRequest>,
  refetch: vi.fn(async () => {}),
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
    refetch: keyedQuery.refetch,
  };
}

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_useRpcKeyedQuery: useMockKeyedQuery,
  experimental_useRpcMutation: () => ({ mutate: vi.fn(), isPending: false }),
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
      headRefOid: "a".repeat(40),
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
        : {
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
          },
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
  vi.useRealTimers();
  keyedQuery.refetch.mockClear();
  keyedQuery.calls.length = 0;
  keyedQuery.data = {};
  keyedQuery.rpcCall = null;
});

describe("isEnvironmentPullRequestStale", () => {
  it.each([
    ["open", row("open"), 30_000, false],
    ["open", row("open"), 30_001, true],
    ["draft", row("draft"), 30_001, true],
    ["absent", { outcome: "absent" } as const, 30_001, true],
    [
      "unavailable",
      { outcome: "unavailable", message: "Host is suspended" } as const,
      30_001,
      true,
    ],
    ["merged", row("merged"), 30_001, false],
    ["merged", row("merged"), 3_600_001, true],
    ["closed", row("closed"), 3_600_000, false],
    ["closed", row("closed"), 3_600_001, true],
  ])(
    "treats a %s row loaded %i ms ago as stale: %s",
    (_, value, age, stale) => {
      expect(isEnvironmentPullRequestStale(value, 0, age)).toBe(stale);
    },
  );
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
    ).toEqual(["upstream", "view"]);
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

  it("refetches a cached row on mount and when the page shows after 30 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    keyedQuery.data = { "env-open": row("open") };
    renderHook(() => useEnvironmentPullRequest("env-open"));
    await settle();
    expect(keyedQuery.refetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 20_000);
    await showPage();
    expect(keyedQuery.refetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 15_000);
    await showPage();
    expect(keyedQuery.refetch).toHaveBeenCalledTimes(2);
  });

  it("keeps a merged row for an hour before a visible page refetches it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    keyedQuery.data = { "env-merged": row("merged") };
    renderHook(() => useEnvironmentPullRequest("env-merged"));
    await settle();
    keyedQuery.refetch.mockClear();

    vi.setSystemTime(Date.now() + 10 * 60_000);
    await showPage();
    expect(keyedQuery.refetch).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 51 * 60_000);
    await showPage();
    expect(keyedQuery.refetch).toHaveBeenCalledTimes(1);
  });

  it("sends one refetch when many rows show at once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    keyedQuery.data = { "env-a": row("open"), "env-b": row("open") };
    renderHook(() => {
      useEnvironmentPullRequest("env-a");
      useEnvironmentPullRequest("env-b");
    });
    await settle();
    expect(keyedQuery.refetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 31_000);
    await showPage();
    expect(keyedQuery.refetch).toHaveBeenCalledTimes(2);
  });

  it("refetches only when an environment starts showing, not for each extra view", async () => {
    keyedQuery.data = { "env-shared": row("open") };
    const banner = renderHook(() => useEnvironmentPullRequest("env-shared"));
    await settle();
    expect(keyedQuery.refetch).toHaveBeenCalledTimes(1);

    const infoRow = renderHook(() => useEnvironmentPullRequest("env-shared"));
    await settle();
    expect(keyedQuery.refetch).toHaveBeenCalledTimes(1);

    banner.unmount();
    infoRow.unmount();
    await settle();
    renderHook(() => useEnvironmentPullRequest("env-shared"));
    await settle();
    expect(keyedQuery.refetch).toHaveBeenCalledTimes(2);
  });

  it("keeps an environment shown when its view remounts in one commit", async () => {
    keyedQuery.data = { "env-remount": row("open") };
    function View() {
      useEnvironmentPullRequest("env-remount");
      return null;
    }
    const { rerender } = render(<View key="thr_a" />);
    await settle();
    keyedQuery.refetch.mockClear();

    rerender(<View key="thr_b" />);
    await settle();
    expect(keyedQuery.refetch).not.toHaveBeenCalled();
  });

  it("does not refetch on mount before the row has loaded", async () => {
    renderHook(() => useEnvironmentPullRequest("env-new"));
    await settle();
    expect(keyedQuery.refetch).not.toHaveBeenCalled();
  });
});
