// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const keyedQueryCalls = vi.hoisted(() => [] as unknown[]);

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_useRpcKeyedQuery: (input: unknown) => {
    keyedQueryCalls.push(input);
    return { data: undefined };
  },
}));

import { useThreadListPullRequest } from "./pull-request-query.js";

afterEach(() => {
  cleanup();
  keyedQueryCalls.length = 0;
});

describe("useThreadListPullRequest", () => {
  it("sends the sidebar PR chip query to the GitHub PR status plugin", () => {
    const { result } = renderHook(() =>
      useThreadListPullRequest("environment-1"),
    );

    expect(keyedQueryCalls).toHaveLength(1);
    expect(keyedQueryCalls[0]).toMatchObject({
      pluginId: "bb--github-pr-status",
      method: "pullRequests",
      keys: ["environment-1"],
      enabled: true,
    });
    expect(result.current).toBeNull();
  });
});
