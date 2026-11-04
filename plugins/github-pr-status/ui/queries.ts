import { useState } from "react";
import { toast } from "sonner";
import {
  githubPrStatusRpcContract,
  type PullRequest,
  type PullRequestMergeMethod,
} from "../contract";
import { useRefetchOnShowAndFocus } from "./refetch-on-show";
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
} from "@get-bb/plugin-sdk/app";

export interface EnvironmentPullRequestState {
  isLoading: boolean;
  pullRequest: PullRequest | null;
}

export function useEnvironmentPullRequest(
  environmentId: string | null | undefined,
  options: { enabled?: boolean } = {},
): EnvironmentPullRequestState {
  const enabled = (options.enabled ?? true) && Boolean(environmentId);
  const query = useRpcKeyedQuery({
    contract: githubPrStatusRpcContract,
    method: "pullRequests",
    keys: enabled && environmentId ? [environmentId] : [],
    enabled,
  });
  const row = environmentId ? query.data?.[environmentId] : undefined;
  const refresh = useRpcMutation({
    contract: githubPrStatusRpcContract,
    method: "refresh",
  });
  const shown = enabled && environmentId ? environmentId : null;
  useRefetchOnShowAndFocus({
    shown,
    loaded: row !== undefined,
    refetch: query.refetch,
    refreshOnShow: () => {
      if (shown !== null)
        refresh.mutate({ environmentId: shown }).catch(() => {});
    },
  });

  return {
    isLoading: enabled && query.error === null && row === undefined,
    pullRequest: row?.outcome === "available" ? row.pullRequest : null,
  };
}

const MERGE_METHOD_STORAGE_KEY = "bb.pullRequest.mergeMethod";

function isMergeMethod(value: string | null): value is PullRequestMergeMethod {
  return value === "merge" || value === "squash" || value === "rebase";
}

function readMergeMethod(): PullRequestMergeMethod {
  const stored = window.localStorage.getItem(MERGE_METHOD_STORAGE_KEY);
  return isMergeMethod(stored) ? stored : "merge";
}

const MERGE_LOADING_TITLES: Record<PullRequestMergeMethod, string> = {
  merge: "Merging pull request",
  squash: "Squash merging pull request",
  rebase: "Rebase merging pull request",
};

interface ActionToastCopy {
  loading: string;
  failure: string;
  fallback: string;
}

const UPDATE_FAILURE = {
  failure: "Failed to update pull request",
  fallback: "Pull request was not updated",
};

async function runWithToast(
  copy: ActionToastCopy,
  run: () => Promise<{ message: string }>,
): Promise<void> {
  const toastId = toast.loading(copy.loading);
  try {
    const response = await run();
    toast.success(response.message, { id: toastId });
  } catch (error) {
    toast.error(copy.failure, {
      id: toastId,
      description:
        error instanceof Error && error.message.trim().length > 0
          ? error.message.trim()
          : copy.fallback,
    });
  }
}

export function usePullRequestActions(environmentId: string) {
  const markReady = useRpcMutation({
    contract: githubPrStatusRpcContract,
    method: "markReady",
  });
  const markDraft = useRpcMutation({
    contract: githubPrStatusRpcContract,
    method: "markDraft",
  });
  const merge = useRpcMutation({
    contract: githubPrStatusRpcContract,
    method: "merge",
  });
  const [mergeMethod, setMergeMethod] = useState(readMergeMethod);
  return {
    isPending: markReady.isPending || markDraft.isPending || merge.isPending,
    mergeMethod,
    markReady: (identity: DisplayedPullRequestIdentity) =>
      runWithToast(
        { loading: "Marking pull request ready", ...UPDATE_FAILURE },
        () => markReady.mutate({ environmentId, ...identity }),
      ),
    markDraft: (identity: DisplayedPullRequestIdentity) =>
      runWithToast(
        { loading: "Converting pull request to draft", ...UPDATE_FAILURE },
        () => markDraft.mutate({ environmentId, ...identity }),
      ),
    merge: (
      method: PullRequestMergeMethod,
      identity: DisplayedPullRequestIdentity,
    ) => {
      window.localStorage.setItem(MERGE_METHOD_STORAGE_KEY, method);
      setMergeMethod(method);
      return runWithToast(
        {
          loading: MERGE_LOADING_TITLES[method],
          failure: "Failed to merge pull request",
          fallback: "Pull request was not merged",
        },
        () => merge.mutate({ environmentId, method, ...identity }),
      );
    },
  };
}

export interface DisplayedPullRequestIdentity {
  expectedHeadOid: string | null;
  expectedHost: string | null;
  expectedRepository: string | null;
  expectedNumber: number;
  expectedBaseRef: string;
}

export function displayedPullRequestIdentity(
  pullRequest: PullRequest,
): DisplayedPullRequestIdentity {
  const displayedUrl = new URL(pullRequest.url);
  const [owner, repository] = displayedUrl.pathname.split("/").slice(1, 3);
  return {
    expectedHeadOid: pullRequest.headRefOid,
    expectedHost: displayedUrl.host,
    expectedRepository:
      owner && repository
        ? `${owner}/${repository.replace(/\.git$/u, "")}`
        : null,
    expectedNumber: pullRequest.number,
    expectedBaseRef: pullRequest.baseRefName,
  };
}

export type DisplayedPullRequestAction =
  | "ready"
  | "draft"
  | PullRequestMergeMethod;

export function runDisplayedPullRequestAction(
  actions: ReturnType<typeof usePullRequestActions>,
  pullRequest: PullRequest,
  action: DisplayedPullRequestAction,
): void {
  const identity = displayedPullRequestIdentity(pullRequest);
  if (action === "ready") void actions.markReady(identity);
  else if (action === "draft") void actions.markDraft(identity);
  else void actions.merge(action, identity);
}
