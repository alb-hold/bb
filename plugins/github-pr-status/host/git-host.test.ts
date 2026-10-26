import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostPullRequestAction } from "../contract.js";
import { installFakeGh, makeTempDir } from "../test/fake-gh.js";
import {
  getPullRequestForCurrentBranch,
  parseGitHubPullRequestView,
  runPullRequestActionForCurrentBranch,
} from "./git-host.js";

const TOKEN_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;
type TokenKey = (typeof TOKEN_KEYS)[number];

const execFileAsync = promisify(execFile);
const GITHUB_REMOTE = "https://github.com/acme/bb.git";
const ACTION_REPO = "github.com/acme/bb";

beforeEach(() => {
  vi.stubEnv("GH_REPO", undefined);
  vi.stubEnv("GH_HOST", undefined);
  for (const key of TOKEN_KEYS) vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubTokens(keys: readonly TokenKey[]): Record<TokenKey, string> {
  const values = {} as Record<TokenKey, string>;
  for (const key of TOKEN_KEYS) {
    values[key] = `${key}-${randomUUID()}`;
    if (keys.includes(key)) vi.stubEnv(key, values[key]);
  }
  return values;
}

async function makeGitRepository(
  remotes: Record<string, string>,
  config: Record<string, string> = {},
): Promise<string> {
  const cwd = await makeTempDir("bb-pr-target-");
  await execFileAsync("git", ["init", "--quiet"], { cwd });
  for (const [name, url] of Object.entries(remotes)) {
    await execFileAsync("git", ["remote", "add", name, url], { cwd });
  }
  for (const [key, value] of Object.entries(config)) {
    await execFileAsync("git", ["config", key, value], { cwd });
  }
  return cwd;
}

function runLookup(cwd: string) {
  return getPullRequestForCurrentBranch({
    cwd,
    localBranch: "bb/pr-target",
    refresh: true,
  });
}

function runAction(
  cwd: string,
  action: HostPullRequestAction = { operation: "ready" },
  localBranch = "bb/pr-target",
) {
  return runPullRequestActionForCurrentBranch({ cwd, localBranch, action });
}

function branchPr(overrides: Record<string, unknown> = {}) {
  return {
    ...JSON.parse(
      ghJson({
        reviewRequests: { totalCount: 0 },
        headRefOid: "a".repeat(40),
      }),
    ),
    autoMergeRequest: null,
    isInMergeQueue: false,
    isCrossRepository: false,
    headRepositoryOwner: { login: "acme" },
    ...overrides,
  };
}

function branchResponse(nodes: unknown[]): string {
  return JSON.stringify({
    data: {
      p0: { defaultBranchRef: { name: "main" }, pullRequests: { nodes } },
    },
  });
}

function expectOnlyToken(
  env: Record<string, string | null>,
  key: TokenKey,
  value: string,
) {
  expect(env).toEqual(
    Object.fromEntries(
      TOKEN_KEYS.map((name) => [name, name === key ? value : null]),
    ),
  );
}

type Configure = "none" | "gh-host" | "hosts-yml";

async function configureHost(host: string, configure: Configure) {
  if (configure === "gh-host") vi.stubEnv("GH_HOST", host);
  if (configure === "hosts-yml")
    await writeFile(
      join(process.env.GH_CONFIG_DIR ?? "", "hosts.yml"),
      `${host}:\n  user: test-user\n`,
    );
}

const DESTINATIONS: readonly (readonly [
  string,
  string,
  Configure,
  readonly TokenKey[],
  TokenKey,
])[] = [
  ["github.com", "github.com", "none", TOKEN_KEYS, "GH_TOKEN"],
  [
    "github.com with only GITHUB_TOKEN set",
    "github.com",
    "none",
    ["GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"],
    "GITHUB_TOKEN",
  ],
  [
    "a configured GHE tenant",
    "acme.ghe.com",
    "gh-host",
    TOKEN_KEYS,
    "GH_TOKEN",
  ],
  [
    "a configured enterprise host",
    "ghe.example",
    "hosts-yml",
    TOKEN_KEYS,
    "GH_ENTERPRISE_TOKEN",
  ],
  [
    "a configured enterprise host with only GITHUB_ENTERPRISE_TOKEN set",
    "ghe.example",
    "hosts-yml",
    ["GH_TOKEN", "GITHUB_TOKEN", "GITHUB_ENTERPRISE_TOKEN"],
    "GITHUB_ENTERPRISE_TOKEN",
  ],
];

const REJECTED_REMOTES: readonly (readonly [
  string,
  Record<string, string>,
  Record<string, string>,
])[] = [
  ["no remote", {}, {}],
  ["a malformed remote", { origin: "not a remote URL" }, {}],
  [
    "ambiguous unranked remotes",
    {
      alpha: "https://github.com/acme/a.git",
      beta: "https://github.com/acme/b.git",
    },
    {},
  ],
  [
    "two gh-resolved remotes",
    {
      origin: "https://github.com/acme/a.git",
      upstream: "https://github.com/acme/b.git",
    },
    {
      "remote.origin.gh-resolved": "base",
      "remote.upstream.gh-resolved": "base",
    },
  ],
];

function ghJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 42,
    title: "Add pull request section",
    state: "OPEN",
    url: "https://github.com/acme/bb/pull/42",
    isDraft: false,
    baseRefName: "main",
    headRefName: "bb/add-pr-section",
    headRefOid: null,
    updatedAt: "2026-06-16T12:30:00Z",
    statusCheckRollup: [],
    reviewDecision: null,
    reviewRequests: [],
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    ...overrides,
  });
}

describe("parseGitHubPullRequestView", () => {
  it("parses a well-formed open PR", () => {
    expect(parseGitHubPullRequestView(ghJson())).toEqual({
      number: 42,
      title: "Add pull request section",
      state: "OPEN",
      url: "https://github.com/acme/bb/pull/42",
      isDraft: false,
      baseRefName: "main",
      headRefName: "bb/add-pr-section",
      headRefOid: null,
      updatedAt: "2026-06-16T12:30:00Z",
      autoMerge: false,
      inMergeQueue: null,
      checks: [],
      reviewDecision: null,
      reviewRequestCount: 0,
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
    });
  });

  it("preserves the draft flag and merged/closed states", () => {
    expect(parseGitHubPullRequestView(ghJson({ isDraft: true }))?.isDraft).toBe(
      true,
    );
    expect(parseGitHubPullRequestView(ghJson({ state: "MERGED" }))?.state).toBe(
      "MERGED",
    );
    expect(parseGitHubPullRequestView(ghJson({ state: "CLOSED" }))?.state).toBe(
      "CLOSED",
    );
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseGitHubPullRequestView(`\n  ${ghJson()}\n`)?.number).toBe(42);
  });

  it("normalizes checks, review requests, and mergeability", () => {
    expect(
      parseGitHubPullRequestView(
        ghJson({
          statusCheckRollup: [
            {
              __typename: "CheckRun",
              name: "typecheck",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              detailsUrl: "https://github.com/acme/bb/actions/runs/1",
              startedAt: "2026-06-16T12:20:00Z",
            },
            {
              __typename: "StatusContext",
              context: "ci/build",
              state: "FAILURE",
              targetUrl: "https://ci.example.test/build/42",
              createdAt: "2026-06-16T12:21:00Z",
            },
            {
              __typename: "CheckRun",
              workflowName: "lint",
              status: "IN_PROGRESS",
              conclusion: null,
              startedAt: "2026-06-16T12:22:00Z",
            },
          ],
          reviewDecision: "REVIEW_REQUIRED",
          reviewRequests: [
            { requestedReviewer: { login: "octocat" } },
            { requestedReviewer: { login: "hubot" } },
          ],
          mergeStateStatus: "DIRTY",
          mergeable: "CONFLICTING",
        }),
      ),
    ).toMatchObject({
      checks: [
        {
          name: "typecheck",
          status: "completed",
          conclusion: "success",
          url: "https://github.com/acme/bb/actions/runs/1",
          startedAt: "2026-06-16T12:20:00Z",
        },
        {
          name: "ci/build",
          status: "completed",
          conclusion: "failure",
          url: "https://ci.example.test/build/42",
          startedAt: "2026-06-16T12:21:00Z",
        },
        {
          name: "lint",
          status: "in_progress",
          conclusion: null,
          url: null,
          startedAt: "2026-06-16T12:22:00Z",
        },
      ],
      reviewDecision: "REVIEW_REQUIRED",
      reviewRequestCount: 2,
      mergeStateStatus: "DIRTY",
      mergeable: "CONFLICTING",
    });
  });

  it.each([
    ["empty output", ""],
    ["whitespace only", "   \n"],
    ["non-JSON", "no pull requests found for branch"],
    ["a JSON array", "[]"],
  ])("returns null for %s", (_label, stdout) => {
    expect(parseGitHubPullRequestView(stdout)).toBeNull();
  });

  it.each([
    ["an unknown state", ghJson({ state: "QUEUED" })],
    [
      "a missing field",
      JSON.stringify({ number: 1, title: "x", state: "OPEN" }),
    ],
    ["a non-positive number", ghJson({ number: 0 })],
    ["an invalid updatedAt", ghJson({ updatedAt: "yesterday" })],
    ["a non-url", ghJson({ url: "not-a-url" })],
  ])("returns null for %s", (_label, stdout) => {
    expect(parseGitHubPullRequestView(stdout)).toBeNull();
  });
});

describe("runPullRequestActionForCurrentBranch", () => {
  it.each(REJECTED_REMOTES)(
    "action fails closed with %s and starts no gh process",
    async (_label, remotes, config) => {
      const gh = await installFakeGh({});
      stubTokens(TOKEN_KEYS);
      const cwd = await makeGitRepository(remotes, config);

      await expect(runAction(cwd)).resolves.toMatchObject({ ok: false });
      expect(await gh.readCalls()).toEqual([]);
    },
  );

  it(`action fails closed for an unconfigured evil.ghe.com remote and starts no gh process`, async () => {
    const gh = await installFakeGh({});
    stubTokens(TOKEN_KEYS);
    const cwd = await makeGitRepository({
      origin: "https://evil.ghe.com/acme/bb.git",
    });

    await expect(runAction(cwd)).resolves.toMatchObject({ ok: false });
    expect(await gh.readCalls()).toEqual([]);
  });

  it.each(DESTINATIONS)(
    "action pins %s to its repository with one gh process",
    async (_label, host, configure, present) => {
      const gh = await installFakeGh({});
      stubTokens(present);
      await configureHost(host, configure);
      const cwd = await makeGitRepository({
        origin: `https://${host}/acme/bb.git`,
      });

      await expect(runAction(cwd)).resolves.toEqual({ ok: true });
      expect(await gh.readCalls()).toEqual([
        ["pr", "ready", "bb/pr-target", "--repo", `${host}/acme/bb`],
      ]);
    },
  );

  it.each(DESTINATIONS)(
    "action gives %s only its selected credential",
    async (_label, host, configure, present, selected) => {
      const gh = await installFakeGh({});
      const tokens = stubTokens(present);
      await configureHost(host, configure);
      const cwd = await makeGitRepository({
        origin: `https://${host}/acme/bb.git`,
      });

      await expect(runAction(cwd)).resolves.toEqual({ ok: true });
      const invocations = await gh.readInvocations();
      expect(invocations).toHaveLength(1);
      expectOnlyToken(invocations[0]!.env, selected, tokens[selected]);
    },
  );

  it(`action targets the upstream repository with the fork head selector`, async () => {
    const gh = await installFakeGh({});
    const cwd = await makeGitRepository(
      {
        origin: "https://github.com/me/bb.git",
        upstream: "https://github.com/acme/bb.git",
      },
      { "remote.pushdefault": "origin" },
    );

    await expect(runAction(cwd)).resolves.toEqual({ ok: true });
    expect(await gh.readCalls()).toEqual([
      ["pr", "ready", "me:bb/pr-target", "--repo", ACTION_REPO],
    ]);
  });

  it.each([
    ["ready", { operation: "ready" }, ["pr", "ready", "bb/pr-action"]],
    [
      "draft",
      { operation: "draft" },
      ["pr", "ready", "bb/pr-action", "--undo"],
    ],
    [
      "merge",
      { operation: "merge", method: "merge" },
      ["pr", "merge", "bb/pr-action", "--merge"],
    ],
    [
      "squash",
      { operation: "merge", method: "squash" },
      ["pr", "merge", "bb/pr-action", "--squash"],
    ],
    [
      "rebase",
      { operation: "merge", method: "rebase" },
      ["pr", "merge", "bb/pr-action", "--rebase"],
    ],
  ] satisfies readonly [string, HostPullRequestAction, readonly string[]][])(
    "runs gh pr %s with an explicit branch selector pinned to the resolved repository",
    async (_label, action, expectedArgs) => {
      const gh = await installFakeGh({});
      const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

      await expect(runAction(cwd, action, "bb/pr-action")).resolves.toEqual({
        ok: true,
      });

      expect(await gh.readCalls()).toEqual([
        [...expectedArgs, "--repo", ACTION_REPO],
      ]);
    },
  );

  it("reports the gh failure detail", async () => {
    await installFakeGh({
      "pr merge": { stderr: "Pull request is not mergeable\n", exit: 1 },
    });
    const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

    await expect(
      runAction(cwd, { operation: "merge", method: "squash" }, "bb/pr-action"),
    ).resolves.toEqual({
      ok: false,
      message:
        "gh pr merge bb/pr-action --squash --repo github.com/acme/bb failed: Pull request is not mergeable",
    });
  });
});

describe("getPullRequestForCurrentBranch", () => {
  it.each(REJECTED_REMOTES)(
    "lookup fails closed with %s and starts no gh process",
    async (_label, remotes, config) => {
      const gh = await installFakeGh({});
      stubTokens(TOKEN_KEYS);
      const cwd = await makeGitRepository(remotes, config);

      await expect(runLookup(cwd)).resolves.toMatchObject({
        outcome: "unavailable",
      });
      expect(await gh.readCalls()).toEqual([]);
    },
  );

  it(`lookup guard: an unconfigured evil.ghe.com remote starts no gh process`, async () => {
    const gh = await installFakeGh({});
    stubTokens(TOKEN_KEYS);
    const cwd = await makeGitRepository({
      origin: "https://evil.ghe.com/acme/bb.git",
    });

    await expect(runLookup(cwd)).resolves.toMatchObject({
      outcome: "unavailable",
    });
    expect(await gh.readCalls()).toEqual([]);
  });

  it.each(DESTINATIONS)(
    "lookup pins %s to its host and repository with one gh process",
    async (_label, host, configure, present) => {
      const gh = await installFakeGh({
        "api graphql": { stdout: branchResponse([branchPr()]) },
      });
      stubTokens(present);
      await configureHost(host, configure);
      const cwd = await makeGitRepository({
        origin: `https://${host}/acme/bb.git`,
      });

      await expect(runLookup(cwd)).resolves.toMatchObject({
        outcome: "found",
      });
      const invocations = await gh.readInvocations();
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.args.slice(0, 4)).toEqual([
        "api",
        "graphql",
        "--hostname",
        host,
      ]);
      expect((await gh.readQueries())[0]).toContain(
        'repository(owner: "acme", name: "bb")',
      );
    },
  );

  it.each(DESTINATIONS)(
    "lookup gives %s only its selected credential",
    async (_label, host, configure, present, selected) => {
      const gh = await installFakeGh({
        "api graphql": { stdout: branchResponse([branchPr()]) },
      });
      const tokens = stubTokens(present);
      await configureHost(host, configure);
      const cwd = await makeGitRepository({
        origin: `https://${host}/acme/bb.git`,
      });

      await expect(runLookup(cwd)).resolves.toMatchObject({
        outcome: "found",
      });
      const invocations = await gh.readInvocations();
      expect(invocations).toHaveLength(1);
      expectOnlyToken(invocations[0]!.env, selected, tokens[selected]);
    },
  );

  async function lookup() {
    return runLookup(await makeGitRepository({ origin: GITHUB_REMOTE }));
  }

  const autoMerge = { enabledAt: "2026-06-16T12:30:00Z" };

  it.each([
    [
      "queued",
      branchPr({ autoMergeRequest: autoMerge, isInMergeQueue: true }),
      true,
    ],
    [
      "not queued",
      branchPr({ autoMergeRequest: autoMerge, isInMergeQueue: false }),
      false,
    ],
    [
      "a missing queue field",
      branchPr({ autoMergeRequest: autoMerge, isInMergeQueue: undefined }),
      null,
    ],
    [
      "a wrong-typed queue field",
      branchPr({ autoMergeRequest: autoMerge, isInMergeQueue: "true" }),
      null,
    ],
  ])(
    "preserves auto-merge and reports %s from the branch read",
    async (_name, pr, inMergeQueue) => {
      await installFakeGh({
        "api graphql": { stdout: branchResponse([pr]) },
      });
      await expect(lookup()).resolves.toMatchObject({
        outcome: "found",
        pullRequest: { number: 42, autoMerge: true, inMergeQueue },
      });
    },
  );

  it("retries without the merge queue field when the server lacks it", async () => {
    const gh = await installFakeGh({
      "api graphql": {
        stdout: branchResponse([branchPr({ isInMergeQueue: undefined })]),
        whenQueryIncludes: {
          text: "isInMergeQueue",
          response: {
            stdout: JSON.stringify({
              errors: [
                {
                  message:
                    "Field 'isInMergeQueue' doesn't exist on type 'PullRequest'",
                },
              ],
            }),
            exit: 1,
          },
        },
      },
    });
    await expect(lookup()).resolves.toMatchObject({
      outcome: "found",
      pullRequest: { number: 42, inMergeQueue: null },
    });
    expect(await gh.readQueries()).toHaveLength(2);
  });

  it("skips the queue state for drafts", async () => {
    const gh = await installFakeGh({
      "api graphql": {
        stdout: branchResponse([
          branchPr({ isDraft: true, isInMergeQueue: true }),
        ]),
      },
    });
    await expect(lookup()).resolves.toMatchObject({
      outcome: "found",
      pullRequest: { isDraft: true, inMergeQueue: false },
    });
    expect((await gh.readCalls()).map((call) => call.slice(0, 2))).toEqual([
      ["api", "graphql"],
    ]);
  });

  it("returns none when the branch has no pull request", async () => {
    await installFakeGh({ "api graphql": { stdout: branchResponse([]) } });
    await expect(lookup()).resolves.toEqual({ outcome: "none" });
  });

  it("returns unavailable with the stderr detail for an auth failure", async () => {
    await installFakeGh({
      "api graphql": {
        stderr: "gh: To get started with GitHub CLI, please run: gh auth login",
        exit: 4,
      },
    });
    await expect(lookup()).resolves.toEqual({
      outcome: "unavailable",
      message: expect.stringContaining("gh auth login"),
    });
  });

  it("returns unavailable for unparseable gh output", async () => {
    await installFakeGh({ "api graphql": { stdout: "not json at all" } });
    await expect(lookup()).resolves.toEqual({
      outcome: "unavailable",
      message: expect.stringContaining("gh api graphql failed"),
    });
  });
});
