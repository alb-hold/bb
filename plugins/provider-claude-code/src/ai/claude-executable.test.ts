import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";
import { afterEach, describe, expect, it } from "vitest";
import hostEntry from "../host.js";
import {
  type ClaudeExecutableCheckDeps,
  trustedClaudeExecutable,
} from "./claude-executable.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.chmod(dir, 0o700).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bb-claude-exec-")),
  );
  tempDirs.push(dir);
  return dir;
}

async function cli(dir: string, mode = 0o755): Promise<string> {
  const file = path.join(dir, "claude");
  await fs.writeFile(file, "#!/bin/sh\nexit 0\n");
  await fs.chmod(file, mode);
  return file;
}

function deps(
  overrides: Partial<ClaudeExecutableCheckDeps>,
): ClaudeExecutableCheckDeps {
  return {
    env: {},
    platform: "linux",
    uid: process.getuid?.() ?? null,
    defaultExecutable: async () => "claude",
    resolve: async () => null,
    ...overrides,
  };
}

function hostContext(): ExperimentalHostRpcContext {
  const unused = (): never => {
    throw new Error("not used by this handler");
  };
  return {
    signal: new AbortController().signal,
    lifecycle: { signal: new AbortController().signal },
    experimental_paths: { dataDir: os.tmpdir(), tempDir: os.tmpdir() },
    experimental_emitSignal: unused,
    experimental_watch: unused,
    experimental_retainWorker: unused,
  };
}

const posix = process.platform === "win32" ? describe.skip : describe;

posix("the Claude CLI that writing assistance trusts", () => {
  it("runs the resolved real file when only its owner or root can change it and every directory above it", async () => {
    const dir = await scratch();
    const file = await cli(dir);
    await expect(
      trustedClaudeExecutable(deps({ resolve: async () => file })),
    ).resolves.toEqual({ ok: true, path: file });
    await expect(
      trustedClaudeExecutable(
        deps({ env: { BB_CLAUDE_CODE_EXECUTABLE: `  ${file}  ` } }),
      ),
    ).resolves.toEqual({ ok: true, path: file });
  });

  it("refuses a CLI file that any account can change", async () => {
    const file = await cli(await scratch(), 0o777);
    const result = await trustedClaudeExecutable(
      deps({ env: { BB_CLAUDE_CODE_EXECUTABLE: file } }),
    );
    expect(result).toEqual({
      ok: false,
      message: `Writing assistance will not run ${file}: any account can change ${file}`,
    });
  });

  it("refuses a CLI in a directory any account can change, unless the directory is sticky", async () => {
    const dir = await scratch();
    const file = await cli(dir);
    await fs.chmod(dir, 0o777);
    expect(
      await trustedClaudeExecutable(deps({ resolve: async () => file })),
    ).toEqual({
      ok: false,
      message: `Writing assistance will not run ${file}: any account can change ${dir}`,
    });
    await fs.chmod(dir, 0o1777);
    expect(
      await trustedClaudeExecutable(deps({ resolve: async () => file })),
    ).toEqual({ ok: true, path: file });
  });

  it("refuses a link whose target sits where any account can change it", async () => {
    const good = await scratch();
    const bad = await scratch();
    const target = await cli(bad);
    await fs.chmod(bad, 0o777);
    const link = path.join(good, "claude");
    await fs.symlink(target, link);
    expect(
      await trustedClaudeExecutable(deps({ resolve: async () => link })),
    ).toEqual({
      ok: false,
      message: `Writing assistance will not run ${link}: any account can change ${bad}`,
    });
  });

  it("refuses a CLI owned by another account", async () => {
    const file = await cli(await scratch());
    const uid = process.getuid?.() ?? 0;
    const result = await trustedClaudeExecutable(
      deps({ uid: uid + 1, resolve: async () => file }),
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.message).toContain(
      "belongs to another account",
    );
  });

  it("refuses a relative BB_CLAUDE_CODE_EXECUTABLE and a missing CLI without running anything", async () => {
    expect(
      await trustedClaudeExecutable(
        deps({ env: { BB_CLAUDE_CODE_EXECUTABLE: "bin/claude" } }),
      ),
    ).toEqual({
      ok: false,
      message:
        "BB_CLAUDE_CODE_EXECUTABLE must be an absolute path for writing assistance, not bin/claude",
    });
    expect(await trustedClaudeExecutable(deps({}))).toEqual({
      ok: false,
      message: "Install Claude Code on the primary machine",
    });
    const missing = path.join(await scratch(), "claude");
    expect(
      await trustedClaudeExecutable(
        deps({ env: { BB_CLAUDE_CODE_EXECUTABLE: missing } }),
      ),
    ).toEqual({
      ok: false,
      message: `Writing assistance cannot read ${missing}. Install Claude Code on the primary machine`,
    });
  });

  it("does not check file ownership on Windows, where POSIX modes do not apply", async () => {
    const file = await cli(await scratch(), 0o777);
    expect(
      await trustedClaudeExecutable(
        deps({ platform: "win32", env: { BB_CLAUDE_CODE_EXECUTABLE: file } }),
      ),
    ).toEqual({ ok: true, path: file });
  });

  it("makes the writing service report not ready and refuse a request, without running the CLI, when the CLI is not trusted", async () => {
    const dir = await scratch();
    const file = await cli(dir);
    const ran = path.join(dir, "ran");
    await fs.writeFile(file, `#!/bin/sh\ntouch ${ran}\n`);
    await fs.chmod(file, 0o777);
    const previous = process.env.BB_CLAUDE_CODE_EXECUTABLE;
    try {
      process.env.BB_CLAUDE_CODE_EXECUTABLE = file;
      const message = `Writing assistance will not run ${file}: any account can change ${file}`;
      await expect(
        hostEntry.handlers["claude.ai.status"]({}, hostContext()),
      ).resolves.toEqual({ ready: false, message });
      await expect(
        hostEntry.handlers["claude.ai.complete"](
          { model: "haiku", prompt: "Fix this.", timeoutMs: 1_000 },
          hostContext(),
        ),
      ).resolves.toEqual({ ok: false, code: "request_failed", message });
      await expect(fs.access(ran)).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.BB_CLAUDE_CODE_EXECUTABLE;
      else process.env.BB_CLAUDE_CODE_EXECUTABLE = previous;
    }
  });
});
