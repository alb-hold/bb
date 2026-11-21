import type { PluginsArea } from "./plugins.js";
import type { createRetiredEnvironmentPullRequests } from "./retired-environment-pull-requests.js";
import { createRetiredEnvironmentReads } from "./retired-environment-reads.js";

type PullRequests = ReturnType<typeof createRetiredEnvironmentPullRequests>;

export function createRetiredEnvironmentMembers(
  callRpc: PluginsArea["callRpc"],
) {
  let loaded: PullRequests | undefined;
  async function pullRequests() {
    if (loaded) return loaded;
    const { createRetiredEnvironmentPullRequests } =
      await import("./retired-environment-pull-requests.js");
    return loaded ??= createRetiredEnvironmentPullRequests(callRpc);
  }

  const actions: PullRequests = {
    async pullRequest(args) {
      return (await pullRequests()).pullRequest(args);
    },
    async markPullRequestReady(args) {
      return (await pullRequests()).markPullRequestReady(args);
    },
    async markPullRequestDraft(args) {
      return (await pullRequests()).markPullRequestDraft(args);
    },
    async mergePullRequest(args) {
      return (await pullRequests()).mergePullRequest(args);
    },
  };
  return { ...createRetiredEnvironmentReads(callRpc), ...actions };
}
