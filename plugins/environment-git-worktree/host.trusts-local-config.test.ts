import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireRemoteEvidence,
  clearFetchMemo,
  findPreservationReasons,
  identifyWorktree,
  isAcceptedRewriteTarget,
} from "./host/worktree-preservation.js";
import { removeWorktree } from "./host/worktree.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const servers: http.Server[] = [];
const restoredVariables = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_SYSTEM",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "TMPDIR",
] as const;
const inherited = restoredVariables.map(
  (name) => [name, process.env[name]] as const,
);
const EVIDENCE_PREFIX = "bb-teardown-fetch-";

beforeEach(() => {
  delete process.env.GIT_SSH_COMMAND;
  delete process.env.GIT_SSH;
});

afterEach(async () => {
  await clearFetchMemo();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  for (const [name, value] of inherited)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

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

async function script(root: string, name: string, body: string) {
  const target = join(root, name);
  await writeFile(target, `#!/bin/sh\n${body}\n`);
  await chmod(target, 0o755);
  return target;
}

async function commitFiles(repository: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(repository, name, ".."), { recursive: true });
    await writeFile(join(repository, name), content);
  }
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "files");
}

async function createFixture(
  options: {
    files?: Record<string, string>;
    objectFormat?: "sha1" | "sha256";
    beforeWorktree?: (sourcePath: string, root: string) => Promise<void>;
    sourceDirectory?: string;
  } = {},
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "bb-trusts-local-")),
  );
  roots.push(root);
  const globalConfig = join(root, "global.gitconfig");
  await writeFile(globalConfig, "");
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  await setGlobal(globalConfig, "protocol.file.allow", "always");
  const format = `--object-format=${options.objectFormat ?? "sha1"}`;
  const originPath = join(root, "origin.git");
  await git(
    root,
    "init",
    "--bare",
    "--initial-branch=main",
    format,
    originPath,
  );
  const sourcePath = join(root, options.sourceDirectory ?? "repo");
  await mkdir(sourcePath, { recursive: true });
  await git(sourcePath, "init", "--initial-branch=main", format);
  await commitFiles(sourcePath, {
    "README.md": "hello\n",
    ...options.files,
  });
  await git(sourcePath, "remote", "add", "origin", originPath);
  await options.beforeWorktree?.(sourcePath, root);
  await git(sourcePath, "push", "origin", "main");
  const attemptRoot = join(root, "worktrees", "thr_trust");
  const path = join(attemptRoot, "clean");
  await mkdir(attemptRoot, { recursive: true });
  await git(sourcePath, "worktree", "add", "--detach", path, "origin/main");
  const marker = join(root, "marker");
  const mark = await script(
    root,
    "mark.sh",
    `echo "$0 $*" >> ${JSON.stringify(marker)}\nexit 0`,
  );
  const passThrough = await script(
    root,
    "pass-through.sh",
    `echo "$0 $*" >> ${JSON.stringify(marker)}\nexec cat`,
  );
  const failingSsh = await script(root, "failing-ssh.sh", "exit 255");
  await setGlobal(globalConfig, "core.sshCommand", failingSsh);
  return {
    root,
    globalConfig,
    sourcePath,
    originPath,
    attemptRoot,
    path,
    marker,
    mark,
    passThrough,
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function setGlobal(file: string, ...args: string[]) {
  await execFileAsync("git", ["config", "--file", file, ...args]);
}

async function identityOf(fixture: Fixture, path = fixture.path) {
  const identified = await identifyWorktree({
    path,
    rootPath: fixture.attemptRoot,
  });
  if (identified.status !== "identified")
    throw new Error("the fixture's worktree was not identified");
  return identified.identity;
}

async function reasonsFor(fixture: Fixture, path = fixture.path) {
  return await findPreservationReasons(
    await identityOf(fixture, path),
    undefined,
    { fetchTimeoutMs: 20_000 },
  );
}

async function markerText(fixture: Fixture): Promise<string> {
  return await readFile(fixture.marker, "utf8").catch(() => "");
}

async function makeStatDirty(fixture: Fixture, ...files: string[]) {
  const past = new Date("2001-01-01T00:00:00Z");
  for (const file of files) await utimes(join(fixture.path, file), past, past);
}

async function addSubmodule(
  fixture: Fixture,
  files: Record<string, string>,
): Promise<string> {
  const subPath = join(fixture.root, "sub");
  await mkdir(subPath, { recursive: true });
  await git(subPath, "init", "--initial-branch=main");
  await commitFiles(subPath, files);
  await git(fixture.sourcePath, "submodule", "add", subPath, "sub");
  await git(fixture.sourcePath, "commit", "-m", "submodule");
  await git(fixture.sourcePath, "push", "origin", "main");
  await git(fixture.path, "checkout", "--detach", "origin/main");
  await git(fixture.path, "submodule", "update", "--init");
  return join(fixture.path, "sub");
}

async function evidenceRepositories(directory: string): Promise<string[]> {
  return (await readdir(directory).catch(() => [])).filter((name) =>
    name.startsWith(EVIDENCE_PREFIX),
  );
}

describe("teardown's fetch never runs a program from the repository's own config", () => {
  it("does not run a local core.sshCommand for an ssh remote, and uses the user's global one", async () => {
    const fixture = await createFixture();
    const log = join(fixture.root, "global-ssh.log");
    const globalSsh = await script(
      fixture.root,
      "global-ssh.sh",
      `echo "$*" >> ${JSON.stringify(log)}\nexit 255`,
    );
    await setGlobal(fixture.globalConfig, "core.sshCommand", globalSsh);
    await git(
      fixture.sourcePath,
      "remote",
      "add",
      "backup",
      "ssh://fetch.invalid/r.git",
    );
    await git(fixture.sourcePath, "config", "core.sshCommand", fixture.mark);

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(await readFile(log, "utf8")).toContain("BatchMode=yes");
    expect(reasons.join("\n")).toContain("could not fetch its remotes");
  });

  it("does not run a local core.sshCommand set in a file the local config includes", async () => {
    const fixture = await createFixture();
    await git(
      fixture.sourcePath,
      "remote",
      "add",
      "backup",
      "ssh://fetch.invalid/r.git",
    );
    const included = join(fixture.root, "included.gitconfig");
    await setGlobal(included, "core.sshCommand", fixture.mark);
    await git(fixture.sourcePath, "config", "include.path", included);

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(reasons.join("\n")).toContain("could not fetch its remotes");
  });

  it("does not run a local core.gitProxy for a git:// remote", async () => {
    const fixture = await createFixture();
    await git(
      fixture.sourcePath,
      "remote",
      "add",
      "backup",
      "git://fetch.invalid/r.git",
    );
    await git(fixture.sourcePath, "config", "core.gitProxy", fixture.mark);

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(reasons.join("\n")).toContain("could not fetch its remotes");
  });

  it("does not run an ext:: remote that the local config allows", async () => {
    const fixture = await createFixture();
    await git(fixture.sourcePath, "config", "protocol.ext.allow", "always");
    await git(
      fixture.sourcePath,
      "remote",
      "add",
      "backup",
      `ext::${fixture.mark}`,
    );

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(reasons.join("\n")).toContain("could not fetch its remotes");
  });

  it("does not run a local uploadpack on the second of two remotes, and fetches both", async () => {
    const fixture = await createFixture();
    const mirror = join(fixture.root, "mirror.git");
    await git(
      fixture.root,
      "clone",
      "--bare",
      "--quiet",
      fixture.originPath,
      mirror,
    );
    await git(fixture.sourcePath, "remote", "add", "mirror", mirror);
    await git(
      fixture.sourcePath,
      "config",
      "remote.mirror.uploadpack",
      fixture.mark,
    );

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(reasons).toEqual([]);
  });

  it.each([
    ["core.hooksPath", true],
    ["the common dir's own hooks", false],
  ] as const)(
    "does not run a reference-transaction hook from %s",
    async (_place, throughHooksPath) => {
      const fixture = await createFixture();
      const hooks = throughHooksPath
        ? join(fixture.root, "hooks")
        : join(fixture.sourcePath, ".git", "hooks");
      await mkdir(hooks, { recursive: true });
      await script(hooks, "reference-transaction", `${fixture.mark} "$@"`);
      if (throughHooksPath)
        await git(fixture.sourcePath, "config", "core.hooksPath", hooks);
      await git(
        join(fixture.root),
        "--git-dir",
        fixture.originPath,
        "update-ref",
        "refs/heads/later",
        "refs/heads/main",
      );

      const reasons = await reasonsFor(fixture);

      expect(await markerText(fixture)).toBe("");
      expect(reasons).toEqual([]);
    },
  );

  it("does not copy hooks from the user's init.templateDir into the temporary repository it fetches into", async () => {
    const fixture = await createFixture();
    const template = join(fixture.root, "template");
    await mkdir(join(template, "hooks"), { recursive: true });
    await script(
      join(template, "hooks"),
      "reference-transaction",
      `${fixture.mark} "$@"`,
    );
    await setGlobal(fixture.globalConfig, "init.templateDir", template);
    await git(
      fixture.root,
      "--git-dir",
      fixture.originPath,
      "update-ref",
      "refs/heads/later",
      "refs/heads/main",
    );

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(reasons).toEqual([]);
  });

  it("does not fetch submodules through fetch.recurseSubmodules, which runs their own config", async () => {
    const fixture = await createFixture();
    const submodule = await addSubmodule(fixture, { "s.txt": "s\n" });
    await git(fixture.sourcePath, "config", "fetch.recurseSubmodules", "true");
    await git(submodule, "config", "remote.origin.uploadpack", fixture.mark);

    await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
  });

  it("does not run a local core.alternateRefsCommand, which the temporary repository's alternate could reach", async () => {
    const fixture = await createFixture();
    await git(
      fixture.sourcePath,
      "config",
      "core.alternateRefsCommand",
      fixture.mark,
    );

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(reasons).toEqual([]);
  });
});

describe("teardown's status and index reads never run a program from the repository's own config", () => {
  it("does not run a local core.fsmonitor for status or for ls-files", async () => {
    const fixture = await createFixture();
    await git(fixture.sourcePath, "config", "core.fsmonitor", fixture.mark);

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(reasons).toEqual([]);
  });

  it("does not run a submodule's own core.fsmonitor", async () => {
    const fixture = await createFixture();
    const submodule = await addSubmodule(fixture, { "s.txt": "s\n" });
    await git(submodule, "config", "core.fsmonitor", fixture.mark);

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(reasons).toEqual([]);
  });

  it.each([
    ["clean", "a clean filter"],
    ["process", "a process filter"],
  ] as const)(
    "does not run %s driver named by .gitattributes (%s)",
    async (key, _kind) => {
      const fixture = await createFixture({
        files: {
          "data.txt": "data\n",
          ".gitattributes": "data.txt filter=evil\n",
        },
      });
      await git(
        fixture.sourcePath,
        "config",
        `filter.evil.${key}`,
        fixture.passThrough,
      );
      await makeStatDirty(fixture, "data.txt");

      const reasons = await reasonsFor(fixture);

      expect(await markerText(fixture)).toBe("");
      expect(reasons).toEqual([]);
    },
  );

  it("does not run a driver named only in the common dir's info/attributes", async () => {
    const fixture = await createFixture({ files: { "data.txt": "data\n" } });
    await mkdir(join(fixture.sourcePath, ".git", "info"), { recursive: true });
    await writeFile(
      join(fixture.sourcePath, ".git", "info", "attributes"),
      "data.txt filter=evil\n",
    );
    await git(
      fixture.sourcePath,
      "config",
      "filter.evil.clean",
      fixture.passThrough,
    );
    await makeStatDirty(fixture, "data.txt");

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(reasons).toEqual([]);
  });

  it("does not run a driver defined only in a submodule's own config", async () => {
    const fixture = await createFixture();
    const submodule = await addSubmodule(fixture, {
      "s.txt": "s\n",
      ".gitattributes": "s.txt filter=subevil\n",
    });
    await git(submodule, "config", "filter.subevil.clean", fixture.passThrough);
    const past = new Date("2001-01-01T00:00:00Z");
    await utimes(join(submodule, "s.txt"), past, past);

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(reasons).toEqual([]);
  });

  it("does not run a required driver, and status still succeeds", async () => {
    const fixture = await createFixture({
      files: {
        "data.txt": "data\n",
        ".gitattributes": "data.txt filter=evil\n",
      },
    });
    await git(
      fixture.sourcePath,
      "config",
      "filter.evil.clean",
      fixture.passThrough,
    );
    await git(fixture.sourcePath, "config", "filter.evil.required", "true");
    await makeStatDirty(fixture, "data.txt");

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(reasons).toEqual([]);
  });

  it("does not run a driver defined in a file the local config includes", async () => {
    const fixture = await createFixture({
      files: {
        "data.txt": "data\n",
        ".gitattributes": "data.txt filter=evil\n",
      },
    });
    const included = join(fixture.root, "included.gitconfig");
    await setGlobal(included, "filter.evil.clean", fixture.passThrough);
    await git(fixture.sourcePath, "config", "include.path", included);
    await makeStatDirty(fixture, "data.txt");

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(reasons).toEqual([]);
  });

  it("does not run a driver the global config includes from inside the worktree, named only in info/attributes", async () => {
    const fixture = await createFixture({ files: { "data.txt": "data\n" } });
    const included = join(fixture.path, "planted.gitconfig");
    await setGlobal(included, "filter.planted.clean", fixture.passThrough);
    await setGlobal(fixture.globalConfig, "include.path", included);
    await mkdir(join(fixture.sourcePath, ".git", "info"), { recursive: true });
    await writeFile(
      join(fixture.sourcePath, ".git", "info", "attributes"),
      "data.txt filter=planted\n",
    );
    await makeStatDirty(fixture, "data.txt");

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(reasons.join("\n")).toContain(
      "has uncommitted changes or untracked files",
    );
  });

  it("runs the user's global driver, not a local redefinition of it", async () => {
    const fixture = await createFixture({
      files: {
        "data.txt": "data\n",
        ".gitattributes": "data.txt filter=lfsish\n",
      },
    });
    const globalRecord = join(fixture.root, "global-driver-ran");
    const globalDriver = await script(
      fixture.root,
      "global-driver.sh",
      `echo ran >> ${JSON.stringify(globalRecord)}\nexec cat`,
    );
    await setGlobal(fixture.globalConfig, "filter.lfsish.clean", globalDriver);
    await git(
      fixture.sourcePath,
      "config",
      "filter.lfsish.clean",
      fixture.passThrough,
    );
    await makeStatDirty(fixture, "data.txt");

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(existsSync(globalRecord)).toBe(true);
    expect(reasons).toEqual([]);
  });

  it.each([
    ["the worktree", false],
    ["a submodule", true],
  ] as const)(
    "does not run a post-index-change hook in %s",
    async (_place, inSubmodule) => {
      const fixture = await createFixture({ files: { "data.txt": "data\n" } });
      const target = inSubmodule
        ? await addSubmodule(fixture, { "s.txt": "s\n" })
        : fixture.path;
      const hooks = join(fixture.root, "post-index-hooks");
      await mkdir(hooks, { recursive: true });
      await script(hooks, "post-index-change", `${fixture.mark} "$@"`);
      await git(target, "config", "core.hooksPath", hooks);
      await makeStatDirty(fixture, inSubmodule ? "sub/s.txt" : "data.txt");

      await reasonsFor(fixture);

      expect(await markerText(fixture)).toBe("");
    },
  );
});

describe("the published check, run against fresh remote branches and the source's own", () => {
  it("keeps a worktree with a commit that was never pushed", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.path, "README.md"), "local\n");
    await git(fixture.path, "commit", "-am", "local only");

    const reasons = await reasonsFor(fixture);

    expect(reasons.join("\n")).toContain(
      "has commits that are not reachable from any remote-tracking branch",
    );
  });

  it("removes a worktree whose commit was pushed after the source last fetched, through every check in removeWorktree", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.path, "README.md"), "pushed\n");
    await git(fixture.path, "commit", "-am", "pushed later");
    await git(fixture.path, "push", fixture.originPath, "HEAD:refs/heads/main");
    const tracked = (
      await git(fixture.sourcePath, "rev-parse", "refs/remotes/origin/main")
    ).trim();
    expect(tracked).not.toBe(
      (await git(fixture.path, "rev-parse", "HEAD")).trim(),
    );
    await clearFetchMemo();

    await removeWorktree({
      path: fixture.path,
      rootPath: fixture.attemptRoot,
      fetchTimeoutMs: 20_000,
    });

    expect(existsSync(fixture.path)).toBe(false);
  });

  it("removes a worktree whose branch was pushed and then deleted upstream, through its stale tracking ref", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.path, "README.md"), "merged\n");
    await git(fixture.path, "commit", "-am", "squash-merged upstream");
    await git(fixture.path, "push", "origin", "HEAD:refs/heads/feature");
    await git(
      fixture.root,
      "--git-dir",
      fixture.originPath,
      "branch",
      "-D",
      "feature",
    );

    const reasons = await reasonsFor(fixture);

    expect(reasons).toEqual([]);
  });

  it("does not apply the user's global insteadOf whose target is a local path, so a remote reachable only through it keeps the worktree", async () => {
    const fixture = await createFixture();
    await setGlobal(
      fixture.globalConfig,
      `url.${fixture.originPath}.insteadOf`,
      "alias:",
    );
    await git(fixture.sourcePath, "remote", "set-url", "origin", "alias:");

    const reasons = await reasonsFor(fixture);

    expect(reasons.join("\n")).toContain("could not fetch its remotes");
  });

  it("does not apply a local insteadOf, so a remote reachable only through it keeps the worktree", async () => {
    const fixture = await createFixture();
    await git(
      fixture.sourcePath,
      "config",
      `url.${fixture.originPath}.insteadOf`,
      "alias:",
    );
    await git(fixture.sourcePath, "remote", "set-url", "origin", "alias:");

    const reasons = await reasonsFor(fixture);

    expect(reasons.join("\n")).toContain("could not fetch its remotes");
  });

  it("resolves a relative local remote URL against the worktree, as git does", async () => {
    const fixture = await createFixture();
    await git(
      fixture.sourcePath,
      "remote",
      "set-url",
      "origin",
      relative(fixture.path, fixture.originPath),
    );

    const reasons = await reasonsFor(fixture);

    expect(reasons).toEqual([]);
  });

  it("names a remote that has no URL instead of failing the check", async () => {
    const fixture = await createFixture();
    await git(
      fixture.sourcePath,
      "config",
      "remote.ghost.fetch",
      "+refs/heads/*:refs/remotes/ghost/*",
    );

    const reasons = await reasonsFor(fixture);

    expect(reasons.join("\n")).toContain("remote ghost has no URL");
  });

  it("checks a sha256 repository", async () => {
    const fixture = await createFixture({ objectFormat: "sha256" });

    const reasons = await reasonsFor(fixture);

    expect(reasons).toEqual([]);
  });

  it("checks a shallow clone, keeping a local commit and passing a published one", async () => {
    const fixture = await createFixture();
    for (const round of [1, 2, 3]) {
      await writeFile(
        join(fixture.sourcePath, "README.md"),
        `round ${round}\n`,
      );
      await git(fixture.sourcePath, "commit", "-am", `round ${round}`);
    }
    await git(fixture.sourcePath, "push", "origin", "main");
    const shallow = join(fixture.root, "shallow");
    await git(
      fixture.root,
      "clone",
      "--quiet",
      "--depth",
      "1",
      `file://${fixture.originPath}`,
      shallow,
    );
    const worktree = join(fixture.attemptRoot, "shallow-worktree");
    await git(shallow, "worktree", "add", "--detach", worktree, "origin/main");

    expect(await reasonsFor(fixture, worktree)).toEqual([]);
    await clearFetchMemo();
    await writeFile(join(worktree, "README.md"), "local\n");
    await git(worktree, "commit", "-am", "local on shallow");
    expect((await reasonsFor(fixture, worktree)).join("\n")).toContain(
      "has commits that are not reachable from any remote-tracking branch",
    );
  });
});

describe("the temporary repository teardown fetches into", () => {
  it("is private to the user, outside the worktree, and removed when the memo is cleared", async () => {
    const fixture = await createFixture();
    const temporary = join(fixture.root, "tmp");
    await mkdir(temporary);
    process.env.TMPDIR = temporary;

    await reasonsFor(fixture);

    const [name, ...extra] = await evidenceRepositories(temporary);
    expect(extra).toEqual([]);
    expect(name).toBeDefined();
    const repository = join(temporary, name ?? "");
    expect((await stat(repository)).mode & 0o777).toBe(0o700);
    expect(relative(fixture.path, repository).startsWith("..")).toBe(true);
    await clearFetchMemo();
    expect(await evidenceRepositories(temporary)).toEqual([]);
  });

  it("is removed once the memo window ends", async () => {
    const fixture = await createFixture();
    const temporary = join(fixture.root, "tmp");
    await mkdir(temporary);
    process.env.TMPDIR = temporary;

    await findPreservationReasons(await identityOf(fixture), undefined, {
      fetchTimeoutMs: 20_000,
      fetchMemoMs: 50,
    });
    for (
      let wait = 0;
      wait < 40 && (await evidenceRepositories(temporary)).length > 0;
      wait += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await evidenceRepositories(temporary)).toEqual([]);
  });

  it("is removed when building it throws, and the worktree is kept with the reason", async () => {
    const fixture = await createFixture();
    const temporary = join(fixture.root, "tmp");
    await mkdir(temporary);
    process.env.TMPDIR = temporary;
    await mkdir(join(fixture.sourcePath, ".git", "shallow"));

    const reasons = await reasonsFor(fixture);

    expect(reasons.join("\n")).toContain("could not fetch its remotes");
    expect(await evidenceRepositories(temporary)).toEqual([]);
  });
});

async function plantInWorktree(
  fixture: Fixture,
  ...settings: Array<[string, string]>
): Promise<string> {
  const planted = join(fixture.path, "planted.gitconfig");
  await writeFile(planted, "");
  for (const [key, value] of settings)
    await setGlobal(planted, "--add", key, value);
  return planted;
}

async function addRemote(fixture: Fixture, name: string, url: string) {
  await git(fixture.sourcePath, "remote", "add", name, url);
}

async function unauthorisedServer(): Promise<number> {
  const server = http.createServer((_request, response) => {
    response.writeHead(401, { "www-authenticate": 'Basic realm="x"' });
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

describe("teardown's fetch reads the user's config only from files outside every repository and workspace", () => {
  it.each([
    ["include.path", false],
    ['includeIf "gitdir:"', true],
  ] as const)(
    "does not run core.gitProxy or core.sshCommand from a worktree file the global config includes through %s",
    async (_kind, conditional) => {
      const fixture = await createFixture();
      const planted = await plantInWorktree(
        fixture,
        ["core.gitProxy", fixture.mark],
        ["core.sshCommand", fixture.mark],
      );
      await setGlobal(
        fixture.globalConfig,
        conditional
          ? `includeIf.gitdir:${await realpath(tmpdir())}/.path`
          : "include.path",
        planted,
      );
      await addRemote(fixture, "proxied", "git://fetch.invalid/r.git");
      await addRemote(fixture, "secure", "ssh://fetch.invalid/r.git");

      const reasons = await reasonsFor(fixture);

      expect(await markerText(fixture)).toBe("");
      expect(reasons.join("\n")).toContain("could not fetch its remotes");
    },
  );

  it("does not run an ext:: remote or an ext:: insteadOf that a worktree file the global config includes allows", async () => {
    const fixture = await createFixture();
    const planted = await plantInWorktree(
      fixture,
      ["protocol.ext.allow", "always"],
      [
        `url.ext::${fixture.mark} rewritten.insteadOf`,
        "https://fetch.invalid/",
      ],
    );
    await setGlobal(fixture.globalConfig, "include.path", planted);
    await addRemote(fixture, "helper", `ext::${fixture.mark} direct`);
    await addRemote(fixture, "rewritten", "https://fetch.invalid/r.git");

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(reasons.join("\n")).toContain("could not fetch its remotes");
  });

  it("does not run a credential helper defined only in a file the global config includes, even outside the worktree", async () => {
    const fixture = await createFixture();
    const port = await unauthorisedServer();
    const included = join(fixture.root, "included.gitconfig");
    await setGlobal(
      included,
      `credential.http://127.0.0.1:${port}.helper`,
      `!f() { echo helper >> ${JSON.stringify(fixture.marker)}; }; f`,
    );
    await setGlobal(fixture.globalConfig, "include.path", included);
    await addRemote(fixture, "served", `http://127.0.0.1:${port}/repo.git`);

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(reasons.join("\n")).toContain("could not");
  });

  it.each([true, false])(
    "carries the user's useHttpPath to the fetch's credential helper (scoped to the URL: %s)",
    async (scoped) => {
      const fixture = await createFixture();
      const port = await unauthorisedServer();
      const origin = `http://127.0.0.1:${port}`;
      const log = join(fixture.root, "helper-input.log");
      await setGlobal(
        fixture.globalConfig,
        `credential.${origin}.helper`,
        `!f() { test "$1" = get && cat >> ${JSON.stringify(log)}; exit 0; }; f`,
      );
      await setGlobal(
        fixture.globalConfig,
        scoped ? `credential.${origin}.useHttpPath` : "credential.useHttpPath",
        "true",
      );
      await addRemote(fixture, "served", `${origin}/repo.git`);

      await reasonsFor(fixture);

      expect(await readFile(log, "utf8")).toContain("path=repo.git");
    },
  );

  it("refuses an included file reached through a symlink outside the worktree whose target is inside it, and reports what it ignored", async () => {
    const fixture = await createFixture();
    const planted = await plantInWorktree(
      fixture,
      ["core.gitProxy", fixture.mark],
      ["core.sshCommand", fixture.mark],
    );
    const link = join(fixture.root, "linked.gitconfig");
    await symlink(planted, link);
    await setGlobal(fixture.globalConfig, "include.path", link);
    await addRemote(fixture, "proxied", "git://fetch.invalid/r.git");
    await addRemote(fixture, "secure", "ssh://fetch.invalid/r.git");

    const lease = await acquireRemoteEvidence(
      await identityOf(fixture),
      undefined,
      { fetchTimeoutMs: 20_000 },
    );
    const { ignoredConfig } = lease.evidence;
    await lease.release();

    expect(await markerText(fixture)).toBe("");
    expect(ignoredConfig.join("\n")).toContain(
      `core.sshcommand from file:${link} (its file is inside a repository or workspace)`,
    );
    expect(ignoredConfig.join("\n")).not.toContain(fixture.mark);
  });

  it("refuses a file the global config includes from bb's worktree root when removeWorktree checks a worktree", async () => {
    const fixture = await createFixture();
    const planted = join(fixture.root, "worktrees", "planted.gitconfig");
    await setGlobal(planted, "core.gitProxy", fixture.mark);
    await setGlobal(planted, "core.sshCommand", fixture.mark);
    await setGlobal(fixture.globalConfig, "include.path", planted);
    await addRemote(fixture, "proxied", "git://fetch.invalid/r.git");
    await addRemote(fixture, "secure", "ssh://fetch.invalid/r.git");

    await expect(
      removeWorktree({
        path: fixture.path,
        rootPath: fixture.attemptRoot,
        fetchTimeoutMs: 20_000,
      }),
    ).rejects.toThrow("could not fetch its remotes");

    expect(await markerText(fixture)).toBe("");
    expect(existsSync(fixture.path)).toBe(true);
  });

  it("does not read the system config, nor what it includes from the worktree, when the user has not disabled it", async () => {
    const fixture = await createFixture();
    const planted = await plantInWorktree(fixture, [
      "core.gitProxy",
      fixture.mark,
    ]);
    const system = join(fixture.root, "system.gitconfig");
    await setGlobal(system, "include.path", planted);
    delete process.env.GIT_CONFIG_NOSYSTEM;
    process.env.GIT_CONFIG_SYSTEM = system;
    await addRemote(fixture, "proxied", "git://fetch.invalid/r.git");

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(reasons.join("\n")).toContain("could not fetch its remotes");
  });

  it.each(["example-alias:org/", "git@example-alias:org/"])(
    "fetches through the sshCommand and the %s insteadOf of an includeIf file outside the worktree that matches the source repository",
    async (target) => {
      const fixture = await createFixture({
        sourceDirectory: join("projects", "pallium", "repo"),
      });
      const served = join(fixture.root, "ssh-served");
      await mkdir(join(served, "org"), { recursive: true });
      await git(
        fixture.root,
        "clone",
        "--bare",
        "--quiet",
        fixture.originPath,
        join(served, "org", "repo.git"),
      );
      const bin = join(fixture.root, "fake-bin");
      await mkdir(bin);
      const log = join(fixture.root, "ssh.log");
      const ssh = await script(
        bin,
        "ssh",
        `echo "$*" >> ${JSON.stringify(log)}\nfor last; do :; done\ncd ${JSON.stringify(served)} && eval "$last"`,
      );
      const pallium = join(fixture.root, "gitconfig-pallium");
      await setGlobal(pallium, "core.sshCommand", ssh);
      await setGlobal(
        pallium,
        `url.${target}.insteadOf`,
        "git@example.invalid:org/",
      );
      await setGlobal(
        fixture.globalConfig,
        `includeIf.gitdir:${join(fixture.root, "projects", "pallium")}/.path`,
        pallium,
      );
      await git(
        fixture.sourcePath,
        "remote",
        "set-url",
        "origin",
        "git@example.invalid:org/repo.git",
      );

      const reasons = await reasonsFor(fixture);

      expect(reasons).toEqual([]);
      expect(await readFile(log, "utf8")).toContain(
        `${target.slice(0, -"org/".length - 1)} git-upload-pack 'org/repo.git'`,
      );
    },
  );

  it.each([
    "./x:y/",
    "/a:b/",
    "-oProxyCommand=x:y/",
    "git@-oProxyCommand=x:y/",
    "ssh://-oProxyCommand=x/y/",
    "file:///nonexistent/",
    "ext::sh -c x ",
  ])(
    "drops the user's global insteadOf to %s, so the remote's own URL is fetched",
    async (target) => {
      const fixture = await createFixture();
      await setGlobal(
        fixture.globalConfig,
        `url.${target}.insteadOf`,
        fixture.originPath,
      );

      const reasons = await reasonsFor(fixture);

      expect(reasons).toEqual([]);
    },
  );

  it("classifies insteadOf targets as git's url_is_local_not_ssh and transport helpers do", () => {
    const accepted = [
      "ssh://host/r",
      "ssh://git@host:22/r",
      "https://host/r",
      "github.com-anluby:palliumai-com/",
      "git@github.com:org/",
      "git@github.com-anluby:",
    ];
    const dropped = [
      "./x:y",
      "/a:b",
      "x/y:z",
      "-oProxyCommand=x:y",
      "git@-oProxyCommand=x:y",
      "ssh://-oProxyCommand=x/y",
      "ssh://git@-o/y",
      "ext::sh -c x",
      "fd::3",
      "file:///x",
      "http://host/r",
      "git://host/r",
      "C:/x",
      "c:x",
      "relative/path",
      "nocolon",
      ":path",
    ];

    expect(
      accepted.filter((target) => !isAcceptedRewriteTarget(target)),
    ).toEqual([]);
    expect(dropped.filter((target) => isAcceptedRewriteTarget(target))).toEqual(
      [],
    );
  });

  it("fetches a local-path remote without running anything its own config names", async () => {
    const fixture = await createFixture();
    const mirror = join(fixture.root, "mirror.git");
    await git(
      fixture.root,
      "clone",
      "--bare",
      "--quiet",
      fixture.originPath,
      mirror,
    );
    const hooks = join(fixture.root, "mirror-hooks");
    await mkdir(hooks);
    for (const hook of [
      "pre-upload-pack",
      "post-upload-pack",
      "reference-transaction",
      "pre-receive",
    ])
      await script(hooks, hook, `${fixture.mark} "$@"`);
    for (const [key, value] of [
      ["uploadpack.packObjectsHook", fixture.mark],
      ["core.hooksPath", hooks],
      ["core.alternateRefsCommand", fixture.mark],
      ["core.fsmonitor", fixture.mark],
    ] as const)
      await git(mirror, "config", key, value);
    await writeFile(
      join(mirror, "objects", "info", "alternates"),
      `${join(fixture.sourcePath, ".git", "objects")}\n`,
    );
    await git(fixture.sourcePath, "remote", "add", "mirror", mirror);

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(reasons).toEqual([]);
  });

  it("does not run an ext:: remote when no config allows ext", async () => {
    const fixture = await createFixture();
    await addRemote(fixture, "helper", `ext::${fixture.mark} direct`);

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(reasons.join("\n")).toContain("could not fetch its remotes");
  });
});

describe("teardown's reflog reads never run a program from the repository's own config", () => {
  it("does not verify signatures through a local log.showSignature and gpg.program", async () => {
    const fixture = await createFixture();
    await git(fixture.path, "checkout", "-q", "-b", "signed");
    const tree = (await git(fixture.path, "rev-parse", "HEAD^{tree}")).trim();
    const parent = (await git(fixture.path, "rev-parse", "HEAD")).trim();
    const body = [
      `tree ${tree}`,
      `parent ${parent}`,
      "author bb <bb@example.com> 1 +0000",
      "committer bb <bb@example.com> 1 +0000",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " ",
      " -----END PGP SIGNATURE-----",
      "",
      "signed",
      "",
    ].join("\n");
    const objectFile = join(fixture.root, "signed-commit");
    await writeFile(objectFile, body);
    const signed = (
      await git(fixture.path, "hash-object", "-t", "commit", "-w", objectFile)
    ).trim();
    await git(
      fixture.path,
      "update-ref",
      "-m",
      "commit: signed",
      "HEAD",
      signed,
    );
    await git(fixture.sourcePath, "config", "log.showSignature", "true");
    await git(fixture.sourcePath, "config", "gpg.program", fixture.mark);

    const reasons = await reasonsFor(fixture);

    expect(await markerText(fixture)).toBe("");
    expect(reasons.join("\n")).toContain(
      "not reachable from any remote-tracking branch",
    );
  });
});
