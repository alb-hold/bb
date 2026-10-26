import type { EnvironmentPullRequest } from "./contract.js";

export async function readEnvironmentPullRequestResults(
  keys: readonly string[],
  read: (key: string) => Promise<EnvironmentPullRequest>,
): Promise<Record<string, EnvironmentPullRequest>> {
  const results = await Promise.all(
    keys.map(async (key) => [key, await read(key)] as const),
  );
  return Object.fromEntries(results);
}
