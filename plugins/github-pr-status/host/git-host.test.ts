import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
  action:
    | HostPullRequestAction
    | {
        operation: "merge";
        method: "merge" | "squash" | "rebase";
        expectedHeadOid: string | null;
        expectedHost?: string;
        expectedRepository?: string;
        expectedNumber?: number;
        expectedBaseRef?: string;
      } = { operation: "ready" },
  localBranch = "bb/pr-target",
) {
  const hasDisplayedIdentity =
    action.operation === "merge" &&
    (action.expectedHost !== undefined ||
      action.expectedRepository !== undefined ||
      action.expectedNumber !== undefined ||
      action.expectedBaseRef !== undefined);
  const resolvedAction =
    action.operation === "merge"
      ? {
          ...action,
          expectedHost: hasDisplayedIdentity
            ? (action.expectedHost ?? null)
            : "github.com",
          expectedRepository: hasDisplayedIdentity
            ? (action.expectedRepository ?? null)
            : "acme/bb",
          expectedNumber: hasDisplayedIdentity
            ? (action.expectedNumber ?? null)
            : 42,
          expectedBaseRef: hasDisplayedIdentity
            ? (action.expectedBaseRef ?? null)
            : "main",
        }
      : action;
  return runPullRequestActionForCurrentBranch({
    cwd,
    localBranch,
    action: resolvedAction,
  });
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
  TokenKey | null,
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
    "a configured enterprise host named by GH_HOST",
    "ghe.example",
    "gh-host",
    TOKEN_KEYS,
    "GH_ENTERPRISE_TOKEN",
  ],
  [
    "a configured enterprise host named by GH_HOST with only GITHUB_ENTERPRISE_TOKEN set",
    "ghe.example",
    "gh-host",
    ["GH_TOKEN", "GITHUB_TOKEN", "GITHUB_ENTERPRISE_TOKEN"],
    "GITHUB_ENTERPRISE_TOKEN",
  ],
  [
    "a hosts.yml enterprise host that GH_HOST does not name",
    "ghe.example",
    "hosts-yml",
    TOKEN_KEYS,
    null,
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

const HEAD_OID = "a".repeat(40);

async function actionGh(
  extra: Record<
    string,
    { stdout?: string; stderr?: string; exit?: number }
  > = {},
) {
  return installFakeGh({
    "api graphql": { stdout: branchResponse([branchPr()]) },
    ...extra,
  });
}

async function actionCalls(gh: { readCalls(): Promise<string[][]> }) {
  return (await gh.readCalls()).filter((call) => call[0] === "pr");
}

async function actionInvocations(gh: {
  readInvocations(): Promise<
    {
      args: string[];
      env: Record<string, string | null>;
      tokenKeys: string[];
    }[]
  >;
}) {
  return (await gh.readInvocations()).filter((call) => call.args[0] === "pr");
}

describe("runPullRequestActionForCurrentBranch", () => {
  it.each(REJECTED_REMOTES)(
    "action fails closed with %s and starts no gh process",
    async (_label, remotes, config) => {
      const gh = await actionGh();
      stubTokens(TOKEN_KEYS);
      const cwd = await makeGitRepository(remotes, config);

      await expect(runAction(cwd)).resolves.toMatchObject({ ok: false });
      expect(await gh.readCalls()).toEqual([]);
    },
  );

  it(`action fails closed for an unconfigured evil.ghe.com remote and starts no gh process`, async () => {
    const gh = await actionGh();
    stubTokens(TOKEN_KEYS);
    const cwd = await makeGitRepository({
      origin: "https://evil.ghe.com/acme/bb.git",
    });

    await expect(runAction(cwd)).resolves.toMatchObject({ ok: false });
    expect(await gh.readCalls()).toEqual([]);
  });

  it.each(DESTINATIONS)(
    "action pins %s to its repository and the read pull request number",
    async (_label, host, configure, present) => {
      const gh = await actionGh();
      stubTokens(present);
      await configureHost(host, configure);
      const cwd = await makeGitRepository({
        origin: `https://${host}/acme/bb.git`,
      });

      await expect(runAction(cwd)).resolves.toEqual({ ok: true });
      expect(await actionCalls(gh)).toEqual([
        ["pr", "ready", "--repo", `${host}/acme/bb`, "--", "42"],
      ]);
    },
  );

  it.each(DESTINATIONS)(
    "action gives %s only its selected credential",
    async (_label, host, configure, present, selected) => {
      const gh = await actionGh();
      const tokens = stubTokens(present);
      await configureHost(host, configure);
      const cwd = await makeGitRepository({
        origin: `https://${host}/acme/bb.git`,
      });

      await expect(runAction(cwd)).resolves.toEqual({ ok: true });
      const invocations = await actionInvocations(gh);
      expect(invocations).toHaveLength(1);
      expectTokens(invocations[0]!.env, selected, tokens);
    },
  );

  it(`action targets the upstream repository with the fork pull request number`, async () => {
    const gh = await installFakeGh({
      "api graphql": {
        stdout: branchResponse([
          branchPr({
            number: 9,
            isCrossRepository: true,
            headRepositoryOwner: { login: "me" },
          }),
        ]),
      },
    });
    const cwd = await makeGitRepository(
      {
        origin: "https://github.com/me/bb.git",
        upstream: "https://github.com/acme/bb.git",
      },
      { "remote.pushdefault": "origin" },
    );

    await expect(runAction(cwd)).resolves.toEqual({ ok: true });
    expect(await actionCalls(gh)).toEqual([
      ["pr", "ready", "--repo", ACTION_REPO, "--", "9"],
    ]);
  });

  it.each([
    ["ready", { operation: "ready" }, ["pr", "ready"]],
    ["draft", { operation: "draft" }, ["pr", "ready", "--undo"]],
    [
      "merge",
      {
        operation: "merge",
        method: "merge",
        expectedHeadOid: HEAD_OID,
        expectedHost: "github.com",
        expectedRepository: "acme/bb",
        expectedNumber: 42,
        expectedBaseRef: "main",
      },
      ["pr", "merge", "--merge", "--match-head-commit", HEAD_OID],
    ],
    [
      "squash",
      {
        operation: "merge",
        method: "squash",
        expectedHeadOid: HEAD_OID,
        expectedHost: "github.com",
        expectedRepository: "acme/bb",
        expectedNumber: 42,
        expectedBaseRef: "main",
      },
      ["pr", "merge", "--squash", "--match-head-commit", HEAD_OID],
    ],
    [
      "rebase",
      {
        operation: "merge",
        method: "rebase",
        expectedHeadOid: HEAD_OID,
        expectedHost: "github.com",
        expectedRepository: "acme/bb",
        expectedNumber: 42,
        expectedBaseRef: "main",
      },
      ["pr", "merge", "--rebase", "--match-head-commit", HEAD_OID],
    ],
  ] satisfies readonly [string, HostPullRequestAction, readonly string[]][])(
    "runs gh pr %s with the read pull request number pinned to the resolved repository",
    async (_label, action, expectedArgs) => {
      const gh = await actionGh();
      const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

      await expect(runAction(cwd, action, "bb/pr-action")).resolves.toEqual({
        ok: true,
      });

      expect(await actionCalls(gh)).toEqual([
        [...expectedArgs, "--repo", ACTION_REPO, "--", "42"],
      ]);
    },
  );

  it("reports the gh failure detail", async () => {
    await actionGh({
      "pr merge": { stderr: "Pull request is not mergeable\n", exit: 1 },
    });
    const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

    await expect(
      runAction(
        cwd,
        { operation: "merge", method: "squash", expectedHeadOid: HEAD_OID },
        "bb/pr-action",
      ),
    ).resolves.toEqual({
      ok: false,
      message: `gh pr merge --squash --match-head-commit ${HEAD_OID} --repo github.com/acme/bb -- 42 failed: Pull request is not mergeable`,
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
      expectTokens(invocations[0]!.env, selected, tokens);
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

function repoFlag(args: string[]): string | undefined {
  return args[args.indexOf("--repo") + 1];
}

const ACTIONS: readonly (readonly [string, HostPullRequestAction])[] = [
  [
    "merge",
    {
      operation: "merge",
      method: "merge",
      expectedHeadOid: HEAD_OID,
      expectedHost: "github.com",
      expectedRepository: "acme/bb",
      expectedNumber: 42,
      expectedBaseRef: "main",
    },
  ],
  ["ready", { operation: "ready" }],
  ["draft", { operation: "draft" }],
];

const TOKEN_EDGES: readonly (readonly [
  string,
  string,
  Configure,
  readonly TokenKey[],
  TokenKey | null,
])[] = [
  [
    "a configured enterprise host with only GH_TOKEN and GITHUB_TOKEN set",
    "ghe.example",
    "hosts-yml",
    ["GH_TOKEN", "GITHUB_TOKEN"],
    null,
  ],
  ["github.com with no token set", "github.com", "none", [], null],
  [
    "a configured GHE tenant with only GITHUB_TOKEN set",
    "acme.ghe.com",
    "gh-host",
    ["GITHUB_TOKEN"],
    "GITHUB_TOKEN",
  ],
];

function expectTokens(
  env: Record<string, string | null>,
  selected: TokenKey | null,
  tokens: Record<TokenKey, string>,
) {
  expect(
    Object.fromEntries(TOKEN_KEYS.map((name) => [name, env[name]])),
  ).toEqual(
    Object.fromEntries(
      TOKEN_KEYS.map((name) => [name, name === selected ? tokens[name] : null]),
    ),
  );
}

describe("action selector and routing edge cases (test-change-reason: bind merges to the displayed PR identity)", () => {
  it.each(ACTIONS)(
    "action refuses an upstream branch that looks like an option for %s and starts no gh process",
    async (_label, action) => {
      const gh = await actionGh();
      const cwd = await makeGitRepository(
        {
          origin: "https://github.com/me/bb.git",
          upstream: "https://github.com/acme/bb.git",
          "review-fork": "https://github.com/acme/bb.git",
        },
        {
          "branch.bb/pr-target.remote": "review-fork",
          "branch.bb/pr-target.merge": "refs/heads/--admin",
        },
      );

      await expect(runAction(cwd, action)).resolves.toMatchObject({
        ok: false,
      });
      expect(await gh.readCalls()).toEqual([]);
    },
  );

  it.each(ACTIONS)(
    "action puts the pull request number of a normal upstream branch after the separator for %s",
    async (_label, action) => {
      const gh = await actionGh();
      const cwd = await makeGitRepository(
        {
          origin: "https://github.com/me/bb.git",
          upstream: "https://github.com/acme/bb.git",
          "review-fork": "https://github.com/acme/bb.git",
        },
        {
          "branch.bb/pr-target.remote": "review-fork",
          "branch.bb/pr-target.merge": "refs/heads/feature/ok",
        },
      );

      await expect(runAction(cwd, action)).resolves.toEqual({ ok: true });
      const [args] = await actionCalls(gh);
      expect(args?.slice(-4)).toEqual(["--repo", ACTION_REPO, "--", "42"]);
      expect((await gh.readQueries())[0]).toContain(
        'headRefName: "feature/ok"',
      );
    },
  );

  it.each([
    ["a leading dash", "--admin"],
    ["a single leading dash", "-x"],
    ["a space", "a b"],
    ["a tab", "a\tb"],
    ["a control character", "a\u0001b"],
    ["a newline", "a\nb"],
  ])(
    "action refuses a local branch with %s and starts no gh process",
    async (_label, localBranch) => {
      const gh = await actionGh();
      const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

      await expect(
        runAction(
          cwd,
          { operation: "merge", method: "merge", expectedHeadOid: HEAD_OID },
          localBranch,
        ),
      ).resolves.toMatchObject({ ok: false });
      expect(await gh.readCalls()).toEqual([]);
    },
  );

  it.each(ACTIONS)(
    "action keeps options before the separator and the number last for %s",
    async (_label, action) => {
      const gh = await actionGh();
      const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

      await expect(runAction(cwd, action)).resolves.toEqual({ ok: true });
      const [args] = await actionCalls(gh);
      expect(args?.slice(-4)).toEqual(["--repo", ACTION_REPO, "--", "42"]);
    },
  );

  it.each(["42", "#42"])(
    "action passes the read pull request number for branch %s instead of the branch name",
    async (branch) => {
      const gh = await installFakeGh({
        "api graphql": {
          stdout: branchResponse([branchPr({ number: 7 })]),
        },
      });
      const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

      await expect(
        runAction(
          cwd,
          {
            operation: "merge",
            method: "squash",
            expectedHeadOid: HEAD_OID,
            expectedHost: "github.com",
            expectedRepository: "acme/bb",
            expectedNumber: 7,
            expectedBaseRef: "main",
          },
          branch,
        ),
      ).resolves.toEqual({ ok: true });
      const [args] = await actionCalls(gh);
      expect(args?.at(-1)).toBe("7");
      expect(args).not.toContain(branch);
    },
  );

  it("action merges only the head commit that the read reported", async () => {
    const oid = "b".repeat(40);
    const gh = await installFakeGh({
      "api graphql": {
        stdout: branchResponse([branchPr({ headRefOid: oid })]),
      },
    });
    const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

    await expect(
      runAction(cwd, {
        operation: "merge",
        method: "merge",
        expectedHeadOid: oid,
      }),
    ).resolves.toEqual({ ok: true });
    const [args] = await actionCalls(gh);
    expect(args).toContain("--match-head-commit");
    expect(args?.[args.indexOf("--match-head-commit") + 1]).toBe(oid);
  });

  it("action refuses to merge a pull request that changed since it was shown", async () => {
    const shown = "a".repeat(40);
    const fresh = "b".repeat(40);
    const gh = await installFakeGh({
      "api graphql": {
        stdout: branchResponse([branchPr({ headRefOid: fresh })]),
      },
    });
    const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

    await expect(
      runAction(cwd, {
        operation: "merge",
        method: "merge",
        expectedHeadOid: shown,
      }),
    ).resolves.toEqual({
      ok: false,
      message:
        "The pull request changed since it was shown. Refresh it and try again",
    });
    expect(await actionCalls(gh)).toEqual([]);
  });

  it("action refuses a different PR number and base at the same displayed head", async () => {
    const gh = await installFakeGh({
      "api graphql": {
        stdout: branchResponse([
          branchPr({
            number: 43,
            url: "https://github.com/acme/bb/pull/43",
            baseRefName: "release",
          }),
        ]),
      },
    });
    const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

    await expect(
      runAction(
        cwd,
        JSON.parse(
          JSON.stringify({
            operation: "merge",
            method: "merge",
            expectedHeadOid: HEAD_OID,
            expectedHost: "github.com",
            expectedRepository: "acme/bb",
            expectedNumber: 42,
            expectedBaseRef: "main",
          }),
        ),
      ),
    ).resolves.toEqual({
      ok: false,
      message:
        "Pull request number changed since it was shown; refusing to merge",
    });
    expect(await actionCalls(gh)).toEqual([]);
  });

  it.each([
    ["host", { expectedHost: "github.enterprise" }, "github.com"],
    ["owner/repo", { expectedRepository: "other/repo" }, "acme/bb"],
    ["number", { expectedNumber: 41 }, 42],
    ["base ref", { expectedBaseRef: "develop" }, "main"],
  ])(
    "action refuses a mismatched displayed %s",
    async (field, shown, _fresh) => {
      const gh = await actionGh();
      const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });
      const identity = {
        expectedHost: "github.com",
        expectedRepository: "acme/bb",
        expectedNumber: 42,
        expectedBaseRef: "main",
        ...shown,
      };
      await expect(
        runAction(
          cwd,
          JSON.parse(
            JSON.stringify({
              operation: "merge",
              method: "merge",
              expectedHeadOid: HEAD_OID,
              ...identity,
            }),
          ),
        ),
      ).resolves.toEqual({
        ok: false,
        message: `Pull request ${field} changed since it was shown; refusing to merge`,
      });
      expect(await actionCalls(gh)).toEqual([]);
    },
  );

  it.each([
    ["host", "expectedHost"],
    ["owner/repo", "expectedRepository"],
    ["number", "expectedNumber"],
    ["base ref", "expectedBaseRef"],
  ])("action refuses a missing displayed %s", async (field, key) => {
    const gh = await actionGh();
    const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });
    const identity = Object.fromEntries(
      Object.entries({
        expectedHost: "github.com",
        expectedRepository: "acme/bb",
        expectedNumber: 42,
        expectedBaseRef: "main",
      }).filter(([name]) => name !== key),
    );
    await expect(
      runAction(
        cwd,
        JSON.parse(
          JSON.stringify({
            operation: "merge",
            method: "merge",
            expectedHeadOid: HEAD_OID,
            ...identity,
          }),
        ),
      ),
    ).resolves.toEqual({
      ok: false,
      message: `Missing displayed pull request ${field}; refusing to merge`,
    });
    expect(await actionCalls(gh)).toEqual([]);
    expect(await gh.readCalls()).toEqual([]);
  });

  it("action merges with the displayed head commit when the read still reports it", async () => {
    const shown = "c".repeat(40);
    const gh = await installFakeGh({
      "api graphql": {
        stdout: branchResponse([branchPr({ headRefOid: shown })]),
      },
    });
    const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

    await expect(
      runAction(cwd, {
        operation: "merge",
        method: "squash",
        expectedHeadOid: shown,
      }),
    ).resolves.toEqual({ ok: true });
    expect(await actionCalls(gh)).toEqual([
      [
        "pr",
        "merge",
        "--squash",
        "--match-head-commit",
        shown,
        "--repo",
        ACTION_REPO,
        "--",
        "42",
      ],
    ]);
  });

  it("action refuses to merge without a displayed head commit", async () => {
    const gh = await actionGh();
    const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

    await expect(
      runAction(cwd, {
        operation: "merge",
        method: "merge",
        expectedHeadOid: null,
      }),
    ).resolves.toEqual({
      ok: false,
      message:
        "The pull request changed since it was shown. Refresh it and try again",
    });
    expect(await actionCalls(gh)).toEqual([]);
  });

  it.each([
    "--admin",
    "ABCDEF" + "a".repeat(34),
    "a".repeat(39),
    "a".repeat(41),
  ])(
    "action refuses to merge when the shown and read head commit %s is not a commit id",
    async (oid) => {
      const gh = await installFakeGh({
        "api graphql": {
          stdout: branchResponse([branchPr({ headRefOid: oid })]),
        },
      });
      const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

      await expect(
        runAction(cwd, {
          operation: "merge",
          method: "merge",
          expectedHeadOid: oid,
        }),
      ).resolves.toMatchObject({ ok: false });
      expect(await actionCalls(gh)).toEqual([]);
    },
  );

  it("action accepts a 64 character head commit id", async () => {
    const oid = "d".repeat(64);
    const gh = await installFakeGh({
      "api graphql": {
        stdout: branchResponse([branchPr({ headRefOid: oid })]),
      },
    });
    const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

    await expect(
      runAction(cwd, {
        operation: "merge",
        method: "merge",
        expectedHeadOid: oid,
      }),
    ).resolves.toEqual({ ok: true });
    expect((await actionCalls(gh))[0]).toContain(oid);
  });

  it.each([
    ["a no-break space", "a\u00a0b"],
    ["an em space", "a\u2003b"],
    ["a line separator", "a\u2028b"],
  ])(
    "action refuses a local branch with %s and starts no gh process",
    async (_label, localBranch) => {
      const gh = await actionGh();
      const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

      await expect(
        runAction(cwd, undefined, localBranch),
      ).resolves.toMatchObject({
        ok: false,
      });
      expect(await gh.readCalls()).toEqual([]);
    },
  );

  it("action refuses to merge when the read reports no head commit", async () => {
    const gh = await installFakeGh({
      "api graphql": {
        stdout: branchResponse([branchPr({ headRefOid: null })]),
      },
    });
    const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

    await expect(
      runAction(cwd, {
        operation: "merge",
        method: "merge",
        expectedHeadOid: HEAD_OID,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(await actionCalls(gh)).toEqual([]);
  });

  it("action reports no pull request when the read finds none", async () => {
    const gh = await installFakeGh({
      "api graphql": { stdout: branchResponse([]) },
    });
    const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

    await expect(runAction(cwd)).resolves.toMatchObject({ ok: false });
    expect(await actionCalls(gh)).toEqual([]);
  });

  it("action pins a remote that carries a port and gives it the enterprise token named by GH_HOST", async () => {
    const gh = await actionGh();
    const tokens = stubTokens(TOKEN_KEYS);
    await configureHost("ghe.example:8443", "gh-host");
    const cwd = await makeGitRepository({
      origin: "https://ghe.example:8443/acme/bb.git",
    });

    await expect(runAction(cwd)).resolves.toEqual({ ok: true });
    const [call] = await actionInvocations(gh);
    expect(repoFlag(call!.args)).toBe("ghe.example:8443/acme/bb");
    expectTokens(call!.env, "GH_ENTERPRISE_TOKEN", tokens);
  });

  it("action ignores ambient GH_HOST and GH_REPO and keeps the remote's pin and credential", async () => {
    const gh = await actionGh();
    const tokens = stubTokens(TOKEN_KEYS);
    vi.stubEnv("GH_HOST", "other.example");
    vi.stubEnv("GH_REPO", ACTION_REPO);
    const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

    await expect(runAction(cwd)).resolves.toEqual({ ok: true });
    const [call] = await actionInvocations(gh);
    expect(repoFlag(call!.args)).toBe(ACTION_REPO);
    expect(call!.env.GH_REPO).toBeNull();
    expectTokens(call!.env, "GH_TOKEN", tokens);
  });

  it.each(TOKEN_EDGES)(
    "action gives %s the expected credential",
    async (_label, host, configure, present, selected) => {
      const gh = await actionGh();
      const tokens = stubTokens(present);
      await configureHost(host, configure);
      const cwd = await makeGitRepository({
        origin: `https://${host}/acme/bb.git`,
      });

      await expect(runAction(cwd)).resolves.toEqual({ ok: true });
      const [call] = await actionInvocations(gh);
      expectTokens(call!.env, selected, tokens);
    },
  );

  it.each(TOKEN_EDGES)(
    "lookup gives %s the expected credential",
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
      const [call] = await gh.readInvocations();
      expectTokens(call!.env, selected, tokens);
    },
  );

  it("action normalizes an uppercase remote to a lowercase host in the pinned repository", async () => {
    const gh = await actionGh();
    const cwd = await makeGitRepository({
      origin: "https://GitHub.COM/Acme/BB.git",
    });

    await expect(runAction(cwd)).resolves.toEqual({ ok: true });
    const [args] = await actionCalls(gh);
    expect(repoFlag(args!)).toBe("github.com/Acme/BB");
  });

  it("lookup normalizes an uppercase remote to a lowercase host", async () => {
    const gh = await installFakeGh({
      "api graphql": { stdout: branchResponse([branchPr()]) },
    });
    const cwd = await makeGitRepository({
      origin: "https://GitHub.COM/Acme/BB.git",
    });

    await expect(runLookup(cwd)).resolves.toMatchObject({ outcome: "found" });
    const [call] = await gh.readInvocations();
    expect(call!.args.slice(0, 4)).toEqual([
      "api",
      "graphql",
      "--hostname",
      "github.com",
    ]);
    expect((await gh.readQueries())[0]).toContain(
      'repository(owner: "Acme", name: "BB")',
    );
  });

  it("action qualifies a fork head on a configured enterprise host", async () => {
    const gh = await installFakeGh({
      "api graphql": {
        stdout: branchResponse([
          branchPr({
            number: 9,
            isCrossRepository: true,
            headRepositoryOwner: { login: "me" },
          }),
        ]),
      },
    });
    const tokens = stubTokens(TOKEN_KEYS);
    await configureHost("ghe.example", "gh-host");
    const cwd = await makeGitRepository(
      {
        origin: "https://ghe.example/me/bb.git",
        upstream: "https://ghe.example/acme/bb.git",
      },
      { "remote.pushdefault": "origin" },
    );

    await expect(runAction(cwd)).resolves.toEqual({ ok: true });
    const [call] = await actionInvocations(gh);
    expect(call!.args.at(-1)).toBe("9");
    expect(repoFlag(call!.args)).toBe("ghe.example/acme/bb");
    expectTokens(call!.env, "GH_ENTERPRISE_TOKEN", tokens);
  });

  it("an enterprise token is withheld from a hosts.yml host that GH_HOST does not name", async () => {
    const gh = await actionGh();
    const tokens = stubTokens(TOKEN_KEYS);
    await writeFile(
      join(process.env.GH_CONFIG_DIR ?? "", "hosts.yml"),
      "corp-a.example:\n  user: a\ncorp-b.example:\n  user: b\n",
    );
    const cwd = await makeGitRepository({
      origin: "https://corp-b.example/acme/bb.git",
    });

    await expect(runAction(cwd)).resolves.toEqual({ ok: true });
    const [call] = await actionInvocations(gh);
    expectTokens(call!.env, null, tokens);
  });

  it("an enterprise token is withheld from a hosts.yml host on the lookup path", async () => {
    const gh = await installFakeGh({
      "api graphql": { stdout: branchResponse([branchPr()]) },
    });
    const tokens = stubTokens(TOKEN_KEYS);
    await writeFile(
      join(process.env.GH_CONFIG_DIR ?? "", "hosts.yml"),
      "corp-a.example:\n  user: a\ncorp-b.example:\n  user: b\n",
    );
    const cwd = await makeGitRepository({
      origin: "https://corp-b.example/acme/bb.git",
    });

    await expect(runLookup(cwd)).resolves.toMatchObject({ outcome: "found" });
    const [call] = await gh.readInvocations();
    expectTokens(call!.env, null, tokens);
  });

  it("token variables are stripped from the child environment whatever their case", async () => {
    const gh = await actionGh();
    vi.stubEnv("gh_token", "lowercase-gh-token");
    vi.stubEnv("Github_Enterprise_Token", "mixed-case-enterprise-token");
    const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

    await expect(runAction(cwd)).resolves.toEqual({ ok: true });
    const [call] = await actionInvocations(gh);
    expect(call!.tokenKeys.filter((key) => /^gh_token$/iu.test(key))).toEqual(
      [],
    );
    expect(
      call!.tokenKeys.filter((key) => /^github_enterprise_token$/iu.test(key)),
    ).toEqual([]);
  });

  it.each([
    ["github.com", "https://github.com/acme/bb.git"],
    [
      "a host listed only in the repository's relative config",
      "https://evil.example/acme/bb.git",
    ],
  ])(
    "a relative GH_CONFIG_DIR fails closed for %s on the action path",
    async (_label, remote) => {
      const gh = await actionGh();
      stubTokens(TOKEN_KEYS);
      const cwd = await makeGitRepository({ origin: remote });
      await mkdir(join(cwd, ".gh"));
      await writeFile(
        join(cwd, ".gh", "hosts.yml"),
        "evil.example:\n  user: x\n",
      );
      vi.stubEnv("GH_CONFIG_DIR", ".gh");

      await expect(runAction(cwd)).resolves.toMatchObject({ ok: false });
      expect(await gh.readCalls()).toEqual([]);
    },
  );

  it.each([
    ["github.com", "https://github.com/acme/bb.git"],
    [
      "a host listed only in the repository's relative config",
      "https://evil.example/acme/bb.git",
    ],
  ])(
    "a relative GH_CONFIG_DIR fails closed for %s on the lookup path",
    async (_label, remote) => {
      const gh = await actionGh();
      stubTokens(TOKEN_KEYS);
      const cwd = await makeGitRepository({ origin: remote });
      await mkdir(join(cwd, ".gh"));
      await writeFile(
        join(cwd, ".gh", "hosts.yml"),
        "evil.example:\n  user: x\n",
      );
      vi.stubEnv("GH_CONFIG_DIR", ".gh");

      await expect(runLookup(cwd)).resolves.toMatchObject({
        outcome: "unavailable",
      });
      expect(await gh.readCalls()).toEqual([]);
    },
  );

  const RELATIVE_CONFIG_SOURCES: readonly (readonly [
    string,
    string,
    string,
    () => void,
  ])[] = [
    [
      "GH_CONFIG_DIR",
      "GH_CONFIG_DIR",
      "https://github.com/acme/bb.git",
      () => vi.stubEnv("GH_CONFIG_DIR", ".gh"),
    ],
    [
      "XDG_CONFIG_HOME",
      "XDG_CONFIG_HOME",
      "https://github.com/acme/bb.git",
      () => {
        vi.stubEnv("GH_CONFIG_DIR", undefined);
        vi.stubEnv("XDG_CONFIG_HOME", ".config");
      },
    ],
    [
      "HOME",
      "HOME",
      "https://github.com/acme/bb.git",
      () => {
        vi.stubEnv("GH_CONFIG_DIR", undefined);
        vi.stubEnv("XDG_CONFIG_HOME", undefined);
        vi.stubEnv("HOME", "relative-home");
      },
    ],
    [
      "GH_CONFIG_DIR with a host named by GH_HOST",
      "GH_CONFIG_DIR",
      "https://ghe.example/acme/bb.git",
      () => {
        vi.stubEnv("GH_CONFIG_DIR", ".gh");
        vi.stubEnv("GH_HOST", "ghe.example");
      },
    ],
  ];

  it.each(RELATIVE_CONFIG_SOURCES)(
    "a relative %s refuses the action naming the variable and starts no gh process",
    async (_label, variable, remote, relativize) => {
      const gh = await actionGh();
      stubTokens(TOKEN_KEYS);
      const cwd = await makeGitRepository({ origin: remote });
      relativize();

      const result = await runAction(cwd);
      expect(result).toMatchObject({ ok: false });
      expect(result.ok ? "" : result.message).toBe(
        `${variable} must be an absolute path; refusing to run gh with a relative GitHub CLI config directory`,
      );
      expect(await gh.readCalls()).toEqual([]);
    },
  );

  it.each(RELATIVE_CONFIG_SOURCES)(
    "a relative %s refuses the lookup naming the variable and starts no gh process",
    async (_label, variable, remote, relativize) => {
      const gh = await actionGh();
      stubTokens(TOKEN_KEYS);
      const cwd = await makeGitRepository({ origin: remote });
      relativize();

      await expect(runLookup(cwd)).resolves.toEqual({
        outcome: "unavailable",
        message: `${variable} must be an absolute path; refusing to run gh with a relative GitHub CLI config directory`,
      });
      expect(await gh.readCalls()).toEqual([]);
    },
  );

  it("an absolute GH_CONFIG_DIR still admits github.com", async () => {
    const gh = await actionGh();
    const configDirectory = await makeTempDir("bb-pr-absolute-config-");
    vi.stubEnv("GH_CONFIG_DIR", configDirectory);
    const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });

    await expect(runAction(cwd)).resolves.toEqual({ ok: true });
    expect(await actionCalls(gh)).toHaveLength(1);
  });

  it("token variables are stripped on a mocked win32 platform whatever their case", async () => {
    const gh = await actionGh();
    vi.stubEnv("gh_token", "lowercase-gh-token");
    vi.stubEnv("Github_Enterprise_Token", "mixed-case-enterprise-token");
    const cwd = await makeGitRepository({ origin: GITHUB_REMOTE });
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    let result;
    try {
      result = await runAction(cwd);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }

    expect(result).toEqual({ ok: true });
    const [call] = await actionInvocations(gh);
    expect(call).toBeDefined();
    expect(call!.tokenKeys.filter((key) => /^gh_token$/iu.test(key))).toEqual(
      [],
    );
    expect(
      call!.tokenKeys.filter((key) => /^github_enterprise_token$/iu.test(key)),
    ).toEqual([]);
  });
});
