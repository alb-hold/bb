import { existsSync } from "node:fs";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node-pty";
import { afterEach, describe, expect, it } from "vitest";
import { prepareTerminalShellIntegration } from "./terminal-shell-integration.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "bb-shell-integration-test-"),
  );
  roots.push(root);
  return root;
}

interface ShellFixture {
  bashRc?: string;
  command?: string;
  userZdotdir?: "home" | null;
  zshEnv?: string;
  zshRc?: string;
}

async function runShell(
  shell: string,
  fixture: ShellFixture = {},
): Promise<{ output: string; exitCode: number }> {
  const root = await makeRoot();
  const home = path.join(root, "home");
  await mkdir(home);
  if (path.basename(shell) === "bash") {
    await writeFile(
      path.join(home, ".bashrc"),
      fixture.bashRc ?? "printf 'BB_USER_RC_LOADED\\n'\n",
    );
  } else {
    await writeFile(
      path.join(home, ".zshenv"),
      fixture.zshEnv ?? "printf 'BB_USER_ENV_LOADED\\n'\n",
    );
    await writeFile(
      path.join(home, ".zshrc"),
      fixture.zshRc ?? "printf 'BB_USER_RC_LOADED\\n'\n",
    );
  }
  const shellEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  if (fixture.userZdotdir === null) delete shellEnv.ZDOTDIR;
  else shellEnv.ZDOTDIR = home;
  const integration = await prepareTerminalShellIntegration({
    env: shellEnv,
    shell,
  });
  if (!integration) throw new Error(`No integration prepared for ${shell}`);
  const executable = process.env.PATH?.split(path.delimiter)
    .map((directory) => path.join(directory, shell))
    .find((candidate) => existsSync(candidate));
  if (!executable)
    throw new Error(`${shell} executable is unavailable on this host`);
  const terminal = spawn(executable, integration.args, {
    cols: 100,
    rows: 30,
    cwd: root,
    env: integration.env,
  });
  let output = "";
  let commandState = 0;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      terminal.kill();
      reject(new Error(`${shell} integration timed out`));
    }, 8_000);
    terminal.onData((chunk) => {
      output += chunk;
      if (
        commandState === 0 &&
        output.includes("BB_USER_RC_LOADED") &&
        output.includes("\u001b]133;A\u0007")
      ) {
        commandState = 1;
        terminal.write(`${fixture.command ?? "cd /tmp; false"}\n`);
      } else if (
        commandState === 1 &&
        output.includes("\u001b]133;D;1\u0007")
      ) {
        commandState = 2;
        terminal.write("exit 1\n");
      }
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      void integration.cleanup();
      if (!output.includes("\u001b]7;file://localhost/tmp\u0007")) {
        reject(
          new Error(`${shell} did not emit OSC 7: ${JSON.stringify(output)}`),
        );
        return;
      }
      if (!output.includes("\u001b]133;D;1\u0007")) {
        reject(
          new Error(
            `${shell} did not emit OSC 133 exit status: ${JSON.stringify(output)}`,
          ),
        );
        return;
      }
      resolve({ output, exitCode });
    });
  });
}

function shellAvailable(shell: string): boolean {
  return (
    process.env.PATH?.split(path.delimiter)
      .map((directory) => path.join(directory, shell))
      .some((candidate) => existsSync(candidate)) ?? false
  );
}

describe("terminal shell integration", () => {
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("loads the user config and reports cwd and command status in bash", async () => {
    const result = await runShell("bash");
    expect(result.output).toContain("\u001b]133;A\u0007");
    expect(result.output).toContain("\u001b]133;B\u0007");
    expect(result.output).toContain("\u001b]133;C\u0007");
    expect(result.exitCode).toBe(1);
  });

  it("preserves the failed command status for a scalar bash PROMPT_COMMAND", async () => {
    const result = await runShell("bash", {
      bashRc: `PROMPT_COMMAND='printf "BB_PREV_STATUS=%s\\n" "$?"'\nprintf 'BB_USER_RC_LOADED\\n'\n`,
    });
    expect(result.output).toContain("BB_PREV_STATUS=1");
    expect(result.exitCode).toBe(1);
  });

  it("preserves and prepends to an array bash PROMPT_COMMAND", async () => {
    const result = await runShell("bash", {
      bashRc: `PROMPT_COMMAND=('printf "BB_ARRAY_STATUS=%s\\n" "$?"' 'printf "BB_ARRAY_SECOND\\n"')\nprintf 'BB_USER_RC_LOADED\\n'\n`,
    });
    expect(result.output).toContain("BB_ARRAY_STATUS=1");
    expect(result.output).toContain("BB_ARRAY_SECOND");
    expect(result.exitCode).toBe(1);
  });

  it.skipIf(!shellAvailable("zsh"))(
    "loads the user config and reports cwd and command status in zsh",
    async () => {
      const result = await runShell("zsh");
      expect(result.output).toContain("\u001b]133;A\u0007");
      expect(result.output).toContain("\u001b]133;B\u0007");
      expect(result.output).toContain("\u001b]133;C\u0007");
      expect(result.exitCode).toBe(1);
    },
  );

  it.skipIf(!shellAvailable("zsh"))(
    "uses the user's ZDOTDIR while loading zsh config and in later commands",
    async () => {
      const result = await runShell("zsh", {
        userZdotdir: "home",
        zshEnv: `printf 'BB_USER_ENV_ZDOTDIR=%s\\n' "$ZDOTDIR"\nprintf 'BB_USER_ENV_LOADED\\n'\n`,
        zshRc: `printf 'BB_USER_RC_ZDOTDIR=%s\\n' "$ZDOTDIR"\nprintf 'BB_USER_RC_LOADED\\n'\n`,
        command: `printf 'BB_LATER_ZDOTDIR=%s\\n' "$ZDOTDIR"; cd /tmp; false`,
      });
      const home = roots.at(-1)?.concat("/home");
      expect(result.output).toContain(`BB_USER_ENV_ZDOTDIR=${home}`);
      expect(result.output).toContain(`BB_USER_RC_ZDOTDIR=${home}`);
      expect(result.output).toContain(`BB_LATER_ZDOTDIR=${home}`);
    },
  );

  it.skipIf(!shellAvailable("zsh"))(
    "leaves ZDOTDIR unset when the user did not set it",
    async () => {
      const result = await runShell("zsh", {
        userZdotdir: null,
        zshEnv: `printf 'BB_USER_ENV_ZDOTDIR=%s\\n' "$ZDOTDIR"\nprintf 'BB_USER_ENV_LOADED\\n'\n`,
        zshRc: `printf 'BB_USER_RC_ZDOTDIR=%s\\n' "$ZDOTDIR"\nprintf 'BB_USER_RC_LOADED\\n'\n`,
        command: `printf 'BB_LATER_ZDOTDIR=%s\\n' "$ZDOTDIR"; cd /tmp; false`,
      });
      expect(result.output).toContain("BB_USER_ENV_ZDOTDIR=\r\n");
      expect(result.output).toContain("BB_USER_RC_ZDOTDIR=\r\n");
      expect(result.output).toContain("BB_LATER_ZDOTDIR=\r\n");
    },
  );

  it("installs fish integration through vendor_conf without changing user config", async () => {
    const root = await makeRoot();
    const integration = await prepareTerminalShellIntegration({
      env: { ...process.env, HOME: root },
      shell: "/usr/bin/fish",
    });
    expect(integration).not.toBeNull();
    const fishConfPath = path.join(
      integration?.env.XDG_DATA_DIRS?.split(path.delimiter)[0] ?? "",
      "fish",
      "vendor_conf.d",
      "bb-terminal.fish",
    );
    const fishConf = await readFile(fishConfPath, "utf8");
    expect(fishConf).toContain("fish_preexec");
    expect(fishConf).toContain("fish_postexec");
    expect(fishConf).toContain("fish_prompt");
    expect(integration?.args).toEqual([]);
    await integration?.cleanup();
  });

  it.each(["bash", "zsh", "fish"])(
    "uses private temporary files for %s integration and removes them",
    async (shell) => {
      const root = await makeRoot();
      const integration = await prepareTerminalShellIntegration({
        env: { ...process.env, HOME: root },
        shell: `/usr/bin/${shell}`,
      });
      expect(integration).not.toBeNull();
      if (!integration) throw new Error("Expected shell integration");

      const directory =
        shell === "bash"
          ? path.dirname(integration.args[1] ?? "")
          : shell === "zsh"
            ? (integration.env.ZDOTDIR ?? "")
            : (integration.env.XDG_DATA_DIRS?.split(path.delimiter)[0] ?? "");
      const files =
        shell === "bash"
          ? [path.join(directory, "bashrc")]
          : shell === "zsh"
            ? [path.join(directory, ".zshenv"), path.join(directory, ".zshrc")]
            : [path.join(directory, "fish", "vendor_conf.d", "bb-terminal.fish")];
      roots.push(directory);

      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const file of files) {
        expect((await stat(file)).mode & 0o777).toBe(0o600);
      }

      await integration.cleanup();
      await expect(access(directory)).rejects.toThrow();
    },
  );
});
