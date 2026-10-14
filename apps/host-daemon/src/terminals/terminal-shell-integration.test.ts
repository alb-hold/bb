import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

async function runShell(
  shell: string,
): Promise<{ output: string; exitCode: number }> {
  const root = await makeRoot();
  const home = path.join(root, "home");
  await mkdir(home);
  if (path.basename(shell) === "bash") {
    await writeFile(
      path.join(home, ".bashrc"),
      "printf 'BB_USER_RC_LOADED\\n'\n",
    );
  } else {
    await writeFile(
      path.join(home, ".zshenv"),
      "printf 'BB_USER_ENV_LOADED\\n'\n",
    );
    await writeFile(
      path.join(home, ".zshrc"),
      "printf 'BB_USER_RC_LOADED\\n'\n",
    );
  }
  const integration = await prepareTerminalShellIntegration({
    env: { ...process.env, HOME: home, ZDOTDIR: home },
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
        terminal.write("cd /tmp; false\n");
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
});
