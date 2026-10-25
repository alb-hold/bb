// @vitest-environment jsdom

import { cleanup, render, renderHook } from "@testing-library/react";
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

const keyedQuery = vi.hoisted(() => ({
  data: {} as Record<string, EnvironmentPullRequest>,
  refetch: vi.fn(async () => {}),
  calls: [] as Array<{ method: string; keys: readonly string[] }>,
}));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_useRpcKeyedQuery: (input: {
    method: string;
    keys: readonly string[];
  }) => {
    keyedQuery.calls.push(input);
    return {
      data: keyedQuery.data,
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: keyedQuery.refetch,
    };
  },
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
  it("consumes producer outcomes by environment id at the RPC boundary", () => {
    const producerOutput = {
      "env-available": environmentPullRequestSchema.parse(row("open")),
      "env-absent": environmentPullRequestSchema.parse({ outcome: "absent" }),
      "env-unavailable": environmentPullRequestSchema.parse({
        outcome: "unavailable",
        message: "Host is suspended",
      }),
    };
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
