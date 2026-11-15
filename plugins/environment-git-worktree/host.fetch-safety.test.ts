import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearFetchMemo,
  fetchFailureReason,
  findPreservationReasons,
  identifyWorktree,
  isWorktreePreservedError,
  nonInteractiveFetchEnvironment,
  replayedCredentialHelpers,
} from "./host/worktree-preservation.js";
import { removeWorktree } from "./host/worktree.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const servers: http.Server[] = [];
const inheritedSshCommand = process.env.GIT_SSH_COMMAND;
const inheritedGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
const inheritedSystemConfig = process.env.GIT_CONFIG_SYSTEM;
const inheritedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
const commandConfigVariables = [
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_CONFIG_PARAMETERS",
] as const;
const inheritedCommandConfig = commandConfigVariables.map(
  (name) => [name, process.env[name]] as const,
);
const inheritedPath = process.env.PATH;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "bb",
      GIT_AUTHOR_EMAIL: "bb@example.com",
      GIT_COMMITTER_NAME: "bb",
      GIT_COMMITTER_EMAIL: "bb@example.com",
    },
  });
  return result.stdout;
}

async function isRunning(pid: number): Promise<boolean> {
  const listing = await execFileAsync("ps", [
    "-o",
    "stat=",
    "-p",
    String(pid),
  ]).catch(() => ({ stdout: "" }));
  const state = listing.stdout.trim();
  return state !== "" && !state.startsWith("Z");
}

afterEach(async () => {
  clearFetchMemo();
  if (inheritedSshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
  else process.env.GIT_SSH_COMMAND = inheritedSshCommand;
  if (inheritedGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = inheritedGlobalConfig;
  if (inheritedSystemConfig === undefined) delete process.env.GIT_CONFIG_SYSTEM;
  else process.env.GIT_CONFIG_SYSTEM = inheritedSystemConfig;
  if (inheritedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = inheritedNoSystem;
  for (const [name, value] of inheritedCommandConfig)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  process.env.PATH = inheritedPath;
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createFixture(remoteUrl: string) {
  const root = await mkdtemp(join(tmpdir(), "bb-worktree-fetch-"));
  roots.push(root);
  const sourcePath = join(root, "repo");
  await mkdir(sourcePath, { recursive: true });
  await git(sourcePath, "init", "--initial-branch=main");
  await writeFile(join(sourcePath, "README.md"), "hello\n");
  await git(sourcePath, "add", ".");
  await git(sourcePath, "commit", "-m", "initial");
  const originPath = join(root, "origin.git");
  await git(root, "init", "--bare", "--initial-branch=main", originPath);
  await git(sourcePath, "remote", "add", "origin", originPath);
  await git(sourcePath, "push", "origin", "main");
  await git(sourcePath, "remote", "add", "backup", remoteUrl);
  const attemptRoot = join(root, "worktrees", "thr_fetch");
  const path = join(attemptRoot, "clean");
  await mkdir(attemptRoot, { recursive: true });
  await git(sourcePath, "worktree", "add", "--detach", path, "origin/main");
  return { root, sourcePath, attemptRoot, path };
}

async function addWorktree(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  name: string,
) {
  const path = join(fixture.attemptRoot, name);
  await git(
    fixture.sourcePath,
    "worktree",
    "add",
    "--detach",
    path,
    "origin/main",
  );
  const identified = await identifyWorktree({
    path,
    rootPath: fixture.attemptRoot,
  });
  if (identified.status !== "identified")
    throw new Error("the extra worktree was not identified");
  return identified.identity;
}

async function writeScript(root: string, name: string, body: string) {
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

async function identityOf(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const identified = await identifyWorktree({
    path: fixture.path,
    rootPath: fixture.attemptRoot,
  });
  if (identified.status !== "identified")
    throw new Error("the fixture's worktree was not identified");
  return identified.identity;
}

async function recordingSsh(root: string) {
  const log = join(root, "ssh.log");
  const script = await writeScript(
    root,
    "fake-ssh.sh",
    `{ echo "ARGV: $*"; echo "ENV GIT_ASKPASS=$GIT_ASKPASS SSH_ASKPASS=$SSH_ASKPASS SSH_ASKPASS_REQUIRE=$SSH_ASKPASS_REQUIRE GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT GCM_INTERACTIVE=$GCM_INTERACTIVE"; } >> ${JSON.stringify(log)}\nexit 255`,
  );
  return { log, script };
}

async function useGlobalConfig(root: string): Promise<string> {
  const file = join(root, "global.gitconfig");
  await writeFile(file, "");
  process.env.GIT_CONFIG_GLOBAL = file;
  return file;
}

async function setGlobalConfig(file: string, ...args: string[]) {
  await execFileAsync("git", ["config", "--file", file, ...args]);
}

async function servedWithBasicAuth(root: string) {
  const served = join(root, "served.git");
  await git(root, "init", "--bare", "--initial-branch=main", served);
  const seed = join(root, "seed");
  await mkdir(seed, { recursive: true });
  await git(seed, "init", "--initial-branch=main");
  await writeFile(join(seed, "a.txt"), "a\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "first");
  await git(seed, "push", served, "main");
  await git(served, "update-server-info");
  const published = (await git(seed, "rev-parse", "HEAD")).trim();
  const expected = `Basic ${Buffer.from("bb:token-1").toString("base64")}`;
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== expected) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="x"' });
      response.end();
      return;
    }
    const requested = new URL(request.url ?? "/", "http://served").pathname;
    readFile(join(served, requested.replace(/^\/served\.git/u, ""))).then(
      (body) => {
        response.writeHead(200);
        response.end(body);
      },
      () => {
        response.writeHead(404);
        response.end();
      },
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/served.git`,
    published,
  };
}

const answeringHelper = (marker: string) =>
  `!f() { echo called >> ${JSON.stringify(marker)}; test "$1" = get || exit 0; echo username=bb; echo password=token-1; }; f`;

describe("the credential helpers the fetch replays", () => {
  const configured = (
    entries: [string, string][],
    origin = "file:/home/user/.gitconfig",
    scope = "global",
  ) =>
    entries
      .map(([key, value]) => `${scope}\0${origin}\0${key}\n${value}\0`)
      .join("");

  it("replays shell, store and cache helpers and resets in config order, with their URL scope", () => {
    expect(
      replayedCredentialHelpers(
        configured([
          ["credential.helper", "osxkeychain"],
          ["credential.https://github.com.helper", ""],
          ["credential.https://github.com.helper", "!gh auth git-credential"],
          ["credential.helper", "store --file /tmp/creds"],
          ["credential.https://example.com.helper", "cache --timeout=60"],
          ["credential.helper", "cache"],
        ]),
      ),
    ).toEqual({
      args: [
        "-c",
        "credential.https://github.com.helper=",
        "--config-env=credential.https://github.com.helper=BB_FETCH_CREDENTIAL_HELPER_0",
        "--config-env=credential.helper=BB_FETCH_CREDENTIAL_HELPER_1",
        "--config-env=credential.https://example.com.helper=BB_FETCH_CREDENTIAL_HELPER_2",
        "--config-env=credential.helper=BB_FETCH_CREDENTIAL_HELPER_3",
      ],
      env: {
        BB_FETCH_CREDENTIAL_HELPER_0: "!gh auth git-credential",
        BB_FETCH_CREDENTIAL_HELPER_1: "store --file /tmp/creds",
        BB_FETCH_CREDENTIAL_HELPER_2: "cache --timeout=60",
        BB_FETCH_CREDENTIAL_HELPER_3: "cache",
      },
    });
  });

  it("replays system and global helpers read from a config file only, never one from the repository, its worktree, the command line, a blob or standard input", () => {
    const helper: [string, string][] = [["credential.helper", "!echo h"]];

    expect(
      replayedCredentialHelpers(
        configured(helper, "file:/etc/gitconfig", "system"),
      ).env,
    ).toEqual({ BB_FETCH_CREDENTIAL_HELPER_0: "!echo h" });
    for (const scope of ["local", "worktree", "command"])
      expect(
        replayedCredentialHelpers(
          configured(helper, "file:/repo/.git/config", scope),
        ),
      ).toEqual({ args: [], env: {} });
    for (const origin of ["command line:", "blob:0123abcd", "standard input:"])
      expect(replayedCredentialHelpers(configured(helper, origin))).toEqual({
        args: [],
        env: {},
      });
  });

  it("keeps a helper's value out of git's command line, which other users can read", () => {
    const replayed = replayedCredentialHelpers(
      configured([["credential.helper", "!echo password=s3cret"]]),
    );

    expect(replayed.args.join(" ")).not.toContain("s3cret");
    expect(Object.values(replayed.env)).toEqual(["!echo password=s3cret"]);
  });

  it.each([
    "osxkeychain",
    "manager",
    "manager-core",
    "wincred",
    "libsecret",
    "/usr/lib/git-core/git-credential-libsecret",
    "/opt/homebrew/bin/git-credential-osxkeychain",
    "!/opt/homebrew/bin/git-credential-osxkeychain",
    "!git-credential-manager",
    "!git credential-manager-core",
    "!manager",
    "storekeeper",
    "gh-route",
  ])(
    "drops %s, which can open a dialog or is not known to be non-interactive",
    (helper) => {
      expect(
        replayedCredentialHelpers(configured([["credential.helper", helper]])),
      ).toEqual({ args: [], env: {} });
    },
  );

  it("drops keys that are not a credential helper, keys git cannot carry on its command line, and entries without a value", () => {
    expect(
      replayedCredentialHelpers(
        configured([
          ["credential.usehttppath", "!echo no"],
          ["credential.https://a.example/?x=1.helper", "!echo no"],
        ]) + "global\0file:/home/user/.gitconfig\0credential.helper\0",
      ),
    ).toEqual({ args: [], env: {} });
    expect(replayedCredentialHelpers("")).toEqual({ args: [], env: {} });
  });
});

describe("the reason a failed fetch gives", () => {
  it("names each remote whose fetch failed on authentication and keeps git's message without credentials", () => {
    const reason = fetchFailureReason(
      [
        "fatal: Authentication failed for 'https://x-access-token:secret@github.com/a/b.git/'",
        "error: could not fetch upstream",
        "fatal: '/no/such/repo' does not appear to be a git repository",
        "error: could not fetch mirror",
        "git@github.com: Permission denied (publickey).",
        "error: could not fetch origin",
      ].join("\n"),
    );

    expect(reason).toMatch(
      /^could not verify remotes: authentication failed for upstream, origin \(/u,
    );
    expect(reason).toContain(
      "Authentication failed for 'https://github.com/a/b.git/'",
    );
    expect(reason).not.toContain("secret");
  });

  it("names the URL when a single remote failed on authentication", () => {
    expect(
      fetchFailureReason(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      ),
    ).toMatch(
      /^could not verify remotes: authentication failed for https:\/\/github\.com \(/u,
    );
  });

  it("keeps the general reason for a failure that is not about authentication", () => {
    expect(
      fetchFailureReason(
        "remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found",
      ),
    ).toMatch(
      /^could not fetch its remotes to verify its commits are published \(remote: Repository not found/u,
    );
    expect(fetchFailureReason("")).toBe(
      "could not fetch its remotes to verify its commits are published",
    );
  });
});

describe("the fetch that checks whether commits are published", () => {
  it("never prompts: batch mode is added to the user's own ssh command and nothing can ask for a password", async () => {
    const fixture = await createFixture("ssh://fetch.invalid/repo.git");
    const { log, script } = await recordingSsh(fixture.root);
    await setGlobalConfig(
      await useGlobalConfig(fixture.root),
      "core.sshCommand",
      `${script} --from-config`,
    );

    const reasons = await findPreservationReasons(
      await identityOf(fixture),
      undefined,
      { fetchTimeoutMs: 20_000 },
    );

    const recorded = await readFile(log, "utf8");
    expect(recorded).toMatch(/ARGV: --from-config -o BatchMode=yes /u);
    expect(recorded).toContain("GIT_ASKPASS=true");
    expect(recorded).toContain("SSH_ASKPASS=true");
    expect(recorded).toContain("SSH_ASKPASS_REQUIRE=never");
    expect(recorded).toContain("GIT_TERMINAL_PROMPT=0");
    expect(recorded).toContain("GCM_INTERACTIVE=never");
    expect(reasons.join("\n")).toContain("could not fetch its remotes");
  });

  it.each(["GIT_SSH_COMMAND", "GIT_SSH"] as const)(
    "never runs %s from teardown's own environment, and the owner's core.sshCommand still applies",
    async (variable) => {
      const fixture = await createFixture("ssh://fetch.invalid/repo.git");
      const { log, script } = await recordingSsh(fixture.root);
      await setGlobalConfig(
        await useGlobalConfig(fixture.root),
        "core.sshCommand",
        `${script} --from-config`,
      );
      process.env[variable] =
        variable === "GIT_SSH" ? script : `${script} --from-env`;

      try {
        await findPreservationReasons(await identityOf(fixture), undefined, {
          fetchTimeoutMs: 20_000,
        });
      } finally {
        delete process.env.GIT_SSH;
      }

      const recorded = await readFile(log, "utf8");
      expect(recorded).toMatch(/ARGV: --from-config -o BatchMode=yes /u);
      expect(recorded).not.toContain("--from-env");
      expect(recorded).not.toMatch(/^ARGV: (?!--from-config)/mu);
    },
  );

  it("builds the ssh command from the configured one or plain ssh", () => {
    expect(nonInteractiveFetchEnvironment({}, "cfg -F x").GIT_SSH_COMMAND).toBe(
      "cfg -F x -o BatchMode=yes",
    );
    expect(nonInteractiveFetchEnvironment({}, null).GIT_SSH_COMMAND).toBe(
      "ssh -o BatchMode=yes",
    );
  });

  it.each([
    ["an osxkeychain helper", "git-credential-osxkeychain", ""],
    ["a Git Credential Manager helper", "git-credential-manager", ""],
    [
      "a shell helper that calls the keychain",
      "git-credential-osxkeychain",
      "!",
    ],
  ])(
    "does not run %s, so a keychain cannot open a dialog, and says authentication failed",
    async (_kind, helperName, prefix) => {
      const server = http.createServer((_request, response) => {
        response.writeHead(401, { "www-authenticate": 'Basic realm="x"' });
        response.end();
      });
      servers.push(server);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      const fixture = await createFixture(`http://127.0.0.1:${port}/repo.git`);
      const globalFile = await useGlobalConfig(fixture.root);
      const marker = join(fixture.root, "helper-called");
      const helper = await writeScript(
        fixture.root,
        helperName,
        `echo called >> ${JSON.stringify(marker)}`,
      );
      await setGlobalConfig(
        globalFile,
        "credential.helper",
        `${prefix}${helper}`,
      );
      await execFileAsync("git", ["fetch", "backup"], {
        cwd: fixture.sourcePath,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }).catch(() => undefined);
      expect(existsSync(marker)).toBe(true);
      await rm(marker, { force: true });

      const reasons = await findPreservationReasons(
        await identityOf(fixture),
        undefined,
        { fetchTimeoutMs: 20_000 },
      );

      expect(existsSync(marker)).toBe(false);
      expect(reasons.join("\n")).toContain(
        "could not verify remotes: authentication failed for backup",
      );
    },
  );

  it("fetches through a helper from the user's global config for that remote when the helper cannot open a dialog, honouring an earlier reset", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-worktree-auth-"));
    roots.push(root);
    const remote = await servedWithBasicAuth(root);
    const fixture = await createFixture(remote.url);
    const globalFile = await useGlobalConfig(root);
    const resetMarker = join(root, "reset-helper-called");
    const helperMarker = join(root, "helper-called");
    await setGlobalConfig(
      globalFile,
      "credential.helper",
      `!f() { echo called >> ${JSON.stringify(resetMarker)}; }; f`,
    );
    await setGlobalConfig(globalFile, "--add", "credential.helper", "");
    await setGlobalConfig(
      globalFile,
      `credential.${remote.origin}.helper`,
      answeringHelper(helperMarker),
    );

    const reasons = await findPreservationReasons(
      await identityOf(fixture),
      undefined,
      { fetchTimeoutMs: 20_000 },
    );

    expect(reasons.join("\n")).not.toMatch(
      /could not fetch|could not verify remotes/u,
    );
    expect(existsSync(helperMarker)).toBe(true);
    expect(existsSync(resetMarker)).toBe(false);
  });

  it("does not run a helper from the repository's own config, which a thread can write, and says authentication failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-worktree-auth-"));
    roots.push(root);
    const remote = await servedWithBasicAuth(root);
    const fixture = await createFixture(remote.url);
    await useGlobalConfig(root);
    const marker = join(root, "local-helper-called");
    await git(
      fixture.sourcePath,
      "config",
      `credential.${remote.origin}.helper`,
      answeringHelper(marker),
    );
    await git(fixture.sourcePath, "ls-remote", "backup");
    expect(existsSync(marker)).toBe(true);
    await rm(marker, { force: true });

    const reasons = await findPreservationReasons(
      await identityOf(fixture),
      undefined,
      { fetchTimeoutMs: 20_000 },
    );

    expect(existsSync(marker)).toBe(false);
    expect(reasons.join("\n")).toContain(
      "could not verify remotes: authentication failed for backup",
    );
  });

  it("never runs a helper from a file the global config includes, even through includeIf into the worktree, while a helper in the global config itself still answers", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-worktree-auth-"));
    roots.push(root);
    const remote = await servedWithBasicAuth(root);
    const fixture = await createFixture(remote.url);
    const globalFile = await useGlobalConfig(root);
    const included = join(fixture.path, "evil.config");
    const conditional = join(fixture.path, "evil2.config");
    const includedMarker = join(root, "included-helper-called");
    const conditionalMarker = join(root, "conditional-helper-called");
    const trustedMarker = join(root, "trusted-helper-called");
    await setGlobalConfig(
      included,
      `credential.${remote.origin}.helper`,
      `!f() { echo called >> ${JSON.stringify(includedMarker)}; }; f`,
    );
    await setGlobalConfig(
      conditional,
      `credential.${remote.origin}.helper`,
      `!f() { echo called >> ${JSON.stringify(conditionalMarker)}; }; f`,
    );
    await setGlobalConfig(globalFile, "include.path", included);
    await setGlobalConfig(
      globalFile,
      `includeIf.gitdir:${fixture.root}/**.path`,
      conditional,
    );
    await setGlobalConfig(
      globalFile,
      `credential.${remote.origin}.helper`,
      answeringHelper(trustedMarker),
    );
    await git(fixture.sourcePath, "ls-remote", "backup");
    expect(existsSync(includedMarker)).toBe(true);
    expect(existsSync(conditionalMarker)).toBe(true);
    await Promise.all(
      [includedMarker, conditionalMarker, trustedMarker].map((marker) =>
        rm(marker, { force: true }),
      ),
    );

    const reasons = await findPreservationReasons(
      await identityOf(fixture),
      undefined,
      { fetchTimeoutMs: 20_000 },
    );

    expect(existsSync(includedMarker)).toBe(false);
    expect(existsSync(conditionalMarker)).toBe(false);
    expect(reasons.join("\n")).not.toMatch(
      /could not fetch|could not verify remotes/u,
    );
    expect(existsSync(trustedMarker)).toBe(true);
  });

  it("never runs a helper from a file the global config includes outside any worktree, and says authentication failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-worktree-auth-"));
    roots.push(root);
    const remote = await servedWithBasicAuth(root);
    const fixture = await createFixture(remote.url);
    const globalFile = await useGlobalConfig(root);
    const shared = join(root, "shared");
    await mkdir(shared, { recursive: true });
    const included = join(shared, "helpers.config");
    const marker = join(root, "included-helper-called");
    await setGlobalConfig(
      included,
      `credential.${remote.origin}.helper`,
      answeringHelper(marker),
    );
    await setGlobalConfig(globalFile, "include.path", included);
    await git(fixture.sourcePath, "ls-remote", "backup");
    expect(existsSync(marker)).toBe(true);
    await rm(marker, { force: true });

    const reasons = await findPreservationReasons(
      await identityOf(fixture),
      undefined,
      { fetchTimeoutMs: 20_000 },
    );

    expect(existsSync(marker)).toBe(false);
    expect(reasons.join("\n")).toContain(
      "could not verify remotes: authentication failed for backup",
    );
  });

  it("fetches through a helper in the system config file GIT_CONFIG_SYSTEM names", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-worktree-auth-"));
    roots.push(root);
    const remote = await servedWithBasicAuth(root);
    const fixture = await createFixture(remote.url);
    await useGlobalConfig(root);
    const systemFile = join(root, "system.gitconfig");
    const marker = join(root, "system-helper-called");
    await setGlobalConfig(
      systemFile,
      `credential.${remote.origin}.helper`,
      answeringHelper(marker),
    );
    process.env.GIT_CONFIG_SYSTEM = systemFile;
    delete process.env.GIT_CONFIG_NOSYSTEM;

    const reasons = await findPreservationReasons(
      await identityOf(fixture),
      undefined,
      { fetchTimeoutMs: 20_000 },
    );

    expect(reasons.join("\n")).not.toMatch(
      /could not fetch|could not verify remotes/u,
    );
    expect(existsSync(marker)).toBe(true);
  });

  it.each([
    "1",
    "yes",
    "",
    "0",
    "+0",
    "-0",
    "00",
    "0x0",
    " 0",
    "0b0",
    "0B0",
    "+0b0",
    "0b1",
    "maybe",
    "0 ",
  ])(
    "with GIT_CONFIG_NOSYSTEM=%j in the daemon's environment, runs the system file's helper exactly when this host's git reads that file",
    async (value) => {
      const root = await mkdtemp(join(tmpdir(), "bb-worktree-auth-"));
      roots.push(root);
      const remote = await servedWithBasicAuth(root);
      const fixture = await createFixture(remote.url);
      await useGlobalConfig(root);
      const systemFile = join(root, "system.gitconfig");
      const marker = join(root, "system-helper-called");
      await setGlobalConfig(
        systemFile,
        `credential.${remote.origin}.helper`,
        answeringHelper(marker),
      );
      const identity = await identityOf(fixture);
      process.env.GIT_CONFIG_SYSTEM = systemFile;
      process.env.GIT_CONFIG_NOSYSTEM = value;
      const gitReadsSystem = await execFileAsync("git", ["config", "--list"], {
        cwd: root,
      }).then(
        ({ stdout }) => stdout.includes(marker),
        () => false,
      );
      if (value === "1" || value === "yes") expect(gitReadsSystem).toBe(false);
      if (value === "" || value === "0") expect(gitReadsSystem).toBe(true);

      const reasons = await findPreservationReasons(identity, undefined, {
        fetchTimeoutMs: 20_000,
      });

      expect(existsSync(marker)).toBe(gitReadsSystem);
      if (gitReadsSystem)
        expect(reasons.join("\n")).not.toMatch(
          /could not fetch|could not verify remotes/u,
        );
      else
        expect(reasons.join("\n")).toMatch(
          /could not verify remotes: authentication failed for backup|could not fetch its remotes to verify its commits are published \(fatal: bad boolean environment value/u,
        );
      const reidentified = await identifyWorktree({
        path: fixture.path,
        rootPath: fixture.attemptRoot,
      });
      if (reidentified.status === "preserve")
        expect(reidentified.reasons.join("\n")).toMatch(
          /is not a Git worktree root \(fatal: bad boolean environment value/u,
        );
      else expect(reidentified.status).toBe("identified");
    },
  );

  it.each([
    [
      "GIT_CONFIG_COUNT",
      (key: string, value: string) => ({
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: key,
        GIT_CONFIG_VALUE_0: value,
      }),
    ],
    [
      "GIT_CONFIG_PARAMETERS",
      (key: string, value: string) => ({
        GIT_CONFIG_PARAMETERS: `'${key}'='${value}'`,
      }),
    ],
  ])(
    "does not replay a helper the daemon's environment passes through %s, which git labels command scope",
    async (_name, variables) => {
      const root = await mkdtemp(join(tmpdir(), "bb-worktree-auth-"));
      roots.push(root);
      const remote = await servedWithBasicAuth(root);
      const fixture = await createFixture(remote.url);
      await useGlobalConfig(root);
      const marker = join(root, "command-helper-called");
      Object.assign(
        process.env,
        variables(
          `credential.${remote.origin}.helper`,
          answeringHelper(marker),
        ),
      );
      await git(fixture.sourcePath, "ls-remote", "backup");
      expect(existsSync(marker)).toBe(true);
      await rm(marker, { force: true });

      const reasons = await findPreservationReasons(
        await identityOf(fixture),
        undefined,
        { fetchTimeoutMs: 20_000 },
      );

      expect(existsSync(marker)).toBe(false);
      expect(reasons.join("\n")).toContain(
        "could not verify remotes: authentication failed for backup",
      );
    },
  );

  it("does not run a helper from the worktree's own config, which git labels worktree scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-worktree-auth-"));
    roots.push(root);
    const remote = await servedWithBasicAuth(root);
    const fixture = await createFixture(remote.url);
    await useGlobalConfig(root);
    const marker = join(root, "worktree-helper-called");
    await git(
      fixture.sourcePath,
      "config",
      "extensions.worktreeConfig",
      "true",
    );
    await git(
      fixture.path,
      "config",
      "--worktree",
      `credential.${remote.origin}.helper`,
      answeringHelper(marker),
    );
    await git(fixture.path, "ls-remote", "backup");
    expect(existsSync(marker)).toBe(true);
    await rm(marker, { force: true });

    const reasons = await findPreservationReasons(
      await identityOf(fixture),
      undefined,
      { fetchTimeoutMs: 20_000 },
    );

    expect(existsSync(marker)).toBe(false);
    expect(reasons.join("\n")).toContain(
      "could not verify remotes: authentication failed for backup",
    );
  });

  it("keeps the worktree when git is too old for --config-env, and never removes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-worktree-auth-"));
    roots.push(root);
    const remote = await servedWithBasicAuth(root);
    const fixture = await createFixture(remote.url);
    const globalFile = await useGlobalConfig(root);
    const marker = join(root, "helper-called");
    await setGlobalConfig(
      globalFile,
      `credential.${remote.origin}.helper`,
      answeringHelper(marker),
    );
    const realGit = (
      await execFileAsync("sh", ["-c", "command -v git"])
    ).stdout.trim();
    const bin = join(root, "old-git-bin");
    await mkdir(bin, { recursive: true });
    await writeScript(
      bin,
      "git",
      [
        'for a in "$@"; do case "$a" in --config-env=*) echo "unknown option: $a" >&2; exit 129 ;; esac; done',
        `exec ${JSON.stringify(realGit)} "$@"`,
      ].join("\n"),
    );
    process.env.PATH = `${bin}:${inheritedPath ?? ""}`;

    const outcome = await removeWorktree({
      path: fixture.path,
      rootPath: fixture.attemptRoot,
      fetchTimeoutMs: 20_000,
    }).then(
      (result) => ({ result, error: null }),
      (error: unknown) => ({ result: null, error }),
    );

    expect(outcome.result).toBeNull();
    expect(isWorktreePreservedError(outcome.error)).toBe(true);
    expect((outcome.error as Error).message).toMatch(
      /could not fetch its remotes to verify its commits are published \(unknown option: --config-env=/u,
    );
    expect(existsSync(join(fixture.path, "README.md"))).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("still fetches from a remote that works: a local remote and an ssh remote reached through the user's own wrapper", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-worktree-served-"));
    roots.push(root);
    const served = join(root, "served.git");
    await git(root, "init", "--bare", "--initial-branch=main", served);
    const seed = join(root, "seed");
    await mkdir(seed, { recursive: true });
    await git(seed, "init", "--initial-branch=main");
    await writeFile(join(seed, "a.txt"), "a\n");
    await git(seed, "add", ".");
    await git(seed, "commit", "-m", "first");
    await git(seed, "push", served, "main");
    const log = join(root, "working-ssh.log");
    const wrapper = await writeScript(
      root,
      "working-ssh.sh",
      [
        `echo "ARGV: $*" >> ${JSON.stringify(log)}`,
        'for a in "$@"; do [ "$a" = "-G" ] && exit 0; done',
        'eval "last=\\${$#}"',
        'exec sh -c "$last"',
      ].join("\n"),
    );
    const fixture = await createFixture(`ssh://fetch.invalid${served}`);
    await setGlobalConfig(
      await useGlobalConfig(root),
      "core.sshCommand",
      `${wrapper} --from-config`,
    );
    const originBefore = (
      await git(fixture.sourcePath, "rev-parse", "refs/remotes/origin/main")
    ).trim();
    await writeFile(join(seed, "b.txt"), "b\n");
    await git(seed, "add", ".");
    await git(seed, "commit", "-m", "second");
    await git(seed, "push", served, "main");
    const published = (await git(seed, "rev-parse", "HEAD")).trim();

    const reasons = await findPreservationReasons(
      await identityOf(fixture),
      undefined,
      { fetchTimeoutMs: 20_000 },
    );

    expect(reasons).toEqual([]);
    expect(published).toMatch(/^[0-9a-f]{40}$/u);
    expect(
      await git(
        fixture.sourcePath,
        "for-each-ref",
        "--format=%(refname)",
        "refs/remotes/backup",
      ),
    ).toBe("");
    expect(
      (
        await git(fixture.sourcePath, "rev-parse", "refs/remotes/origin/main")
      ).trim(),
    ).toBe(originBefore);
    expect(await readFile(log, "utf8")).toMatch(
      /--from-config -o BatchMode=yes .*git-upload-pack/u,
    );
  });

  it("fetches once per source repository per pass, however many of its worktrees are checked", async () => {
    const fixture = await createFixture("ssh://fetch.invalid/repo.git");
    const { log, script } = await recordingSsh(fixture.root);
    await setGlobalConfig(
      await useGlobalConfig(fixture.root),
      "core.sshCommand",
      script,
    );
    const first = await identityOf(fixture);
    const second = await addWorktree(fixture, "second");
    const third = await addWorktree(fixture, "third");
    const attempts = async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line.includes("git-upload-pack")).length;

    const reasons = [
      await findPreservationReasons(first, undefined, {
        fetchTimeoutMs: 20_000,
      }),
      await findPreservationReasons(second, undefined, {
        fetchTimeoutMs: 20_000,
      }),
      await findPreservationReasons(third, undefined, {
        fetchTimeoutMs: 20_000,
      }),
    ];

    expect(await attempts()).toBe(1);
    for (const each of reasons)
      expect(each.join("\n")).toContain("could not fetch its remotes");
    clearFetchMemo();
    await findPreservationReasons(second, undefined, {
      fetchTimeoutMs: 20_000,
    });
    expect(await attempts()).toBe(2);
    await findPreservationReasons(third, undefined, {
      fetchTimeoutMs: 20_000,
      fetchMemoMs: 0,
    });
    expect(await attempts()).toBe(3);
  });

  it("fetches each of two source repositories once", async () => {
    const one = await createFixture("ssh://fetch.invalid/one.git");
    const two = await createFixture("ssh://fetch.invalid/two.git");
    const logOne = await recordingSsh(one.root);
    const logTwo = await recordingSsh(two.root);
    const globalOne = await useGlobalConfig(one.root);
    await setGlobalConfig(globalOne, "core.sshCommand", logOne.script);
    const globalTwo = await useGlobalConfig(two.root);
    await setGlobalConfig(globalTwo, "core.sshCommand", logTwo.script);

    process.env.GIT_CONFIG_GLOBAL = globalOne;
    await findPreservationReasons(await identityOf(one), undefined, {
      fetchTimeoutMs: 20_000,
    });
    process.env.GIT_CONFIG_GLOBAL = globalTwo;
    await findPreservationReasons(await identityOf(two), undefined, {
      fetchTimeoutMs: 20_000,
    });

    for (const { log } of [logOne, logTwo])
      expect(
        (await readFile(log, "utf8"))
          .split("\n")
          .filter((line) => line.includes("git-upload-pack")),
      ).toHaveLength(1);
  });

  describe("when the remote never answers", () => {
    async function hangingFixture() {
      const fixture = await createFixture("ssh://fetch.invalid/repo.git");
      const pidFile = join(fixture.root, "ssh.pid");
      const script = await writeScript(
        fixture.root,
        "hanging-ssh.sh",
        `echo $$ >> ${JSON.stringify(pidFile)}\ntrap '' TERM\nwhile true; do sleep 1; done`,
      );
      const globalFile = join(fixture.root, "global.gitconfig");
      await writeFile(globalFile, "");
      process.env.GIT_CONFIG_GLOBAL = globalFile;
      await setGlobalConfig(globalFile, "core.sshCommand", script);
      return { ...fixture, pidFile };
    }

    async function processGroupMembers(pgid: number): Promise<number> {
      const listing = await execFileAsync("ps", ["-eo", "pid=,pgid=,stat="]);
      return listing.stdout.split("\n").filter((line) => {
        const [, group, state] = line.trim().split(/\s+/u);
        return group === String(pgid) && !(state ?? "").startsWith("Z");
      }).length;
    }

    it("gives up within the bound, kills the git child and everything it started, and keeps the worktree with a reason", async () => {
      const fixture = await hangingFixture();
      const identity = await identityOf(fixture);

      const reasons = await findPreservationReasons(identity, undefined, {
        fetchTimeoutMs: 1_500,
      });

      expect(reasons.join("\n")).toMatch(
        /could not fetch its remotes to verify its commits are published \(.*timed out after 1500ms\)/u,
      );
      const pid = Number(
        (await readFile(fixture.pidFile, "utf8")).trim().split("\n")[0],
      );
      for (let wait = 0; wait < 30 && (await isRunning(pid)); wait += 1)
        await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await isRunning(pid)).toBe(false);
      expect(await processGroupMembers(pid)).toBe(0);
    }, 30_000);

    it("bounds a pass over several worktrees of one repository to one timeout, not one per worktree", async () => {
      const fixture = await hangingFixture();
      const identities = [
        await identityOf(fixture),
        await addWorktree(fixture, "second"),
        await addWorktree(fixture, "third"),
      ];
      const outcomes: string[][] = [];
      for (const identity of identities)
        outcomes.push(
          await findPreservationReasons(identity, undefined, {
            fetchTimeoutMs: 1_500,
          }),
        );

      for (const reasons of outcomes)
        expect(reasons.join("\n")).toContain("could not fetch its remotes");
      expect(
        (await readFile(fixture.pidFile, "utf8")).trim().split("\n"),
      ).toHaveLength(1);

      const again = await findPreservationReasons(identities[0]!, undefined, {
        fetchTimeoutMs: 1_500,
      });
      expect(
        (await readFile(fixture.pidFile, "utf8")).trim().split("\n"),
      ).toHaveLength(1);
      expect(again.join("\n")).toContain("could not fetch its remotes");
    }, 30_000);

    it("never removes the worktree: removal stops with the preserved error and the worktree is untouched", async () => {
      const fixture = await hangingFixture();

      const outcome = await removeWorktree({
        path: fixture.path,
        rootPath: fixture.attemptRoot,
        fetchTimeoutMs: 1_500,
      }).then(
        (result) => ({ result, error: null }),
        (error: unknown) => ({ result: null, error }),
      );

      expect(outcome.result).toBeNull();
      expect(isWorktreePreservedError(outcome.error)).toBe(true);
      expect((outcome.error as Error).message).toContain(
        "could not fetch its remotes",
      );
      expect(existsSync(join(fixture.path, "README.md"))).toBe(true);
      expect(
        await git(fixture.sourcePath, "worktree", "list", "--porcelain"),
      ).toContain(await realpath(fixture.path));
    }, 30_000);
  });
});
