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
  cwdPath?: string;
  exitCommand?: string;
  fishConfig?: string;
  fishSourceIntegrationTwice?: boolean;
  outputAfterExit?: string;
  sourceIntegrationTwice?: boolean;
  xdgDataDirs?: string;
  userZdotdir?: "home" | null;
  zshEnv?: string;
  zshRc?: string;
}

function createShellOutputCompletionGate(requiredOutput: string | null) {
  let output = "";
  let exitCode: number | null = null;
  let settled = false;
  let resolve!: (result: { output: string; exitCode: number }) => void;
  const promise = new Promise<{ output: string; exitCode: number }>(
    (resolvePromise) => {
      resolve = resolvePromise;
    },
  );
  const finishIfReady = () => {
    if (
      !settled &&
      exitCode !== null &&
      (requiredOutput === null || output.includes(requiredOutput))
    ) {
      settled = true;
      resolve({ output, exitCode });
    }
  };
  return {
    get output() {
      return output;
    },
    onData(chunk: string) {
      output += chunk;
      finishIfReady();
    },
    onExit(code: number) {
      exitCode = code;
      finishIfReady();
    },
    promise,
  };
}

async function runShell(
  shell: string,
  fixture: ShellFixture = {},
): Promise<{
  output: string;
  outputAtCommandEnd: string | null;
  exitCode: number;
}> {
  const root = await makeRoot();
  const home = path.join(root, "home");
  await mkdir(home);
  const shellName = path.basename(shell);
  if (shellName === "bash") {
    await writeFile(
      path.join(home, ".bashrc"),
      fixture.bashRc ?? "printf 'BB_USER_RC_LOADED\\n'\n",
    );
  } else if (shellName === "zsh") {
    await writeFile(
      path.join(home, ".zshenv"),
      fixture.zshEnv ?? "printf 'BB_USER_ENV_LOADED\\n'\n",
    );
    await writeFile(
      path.join(home, ".zshrc"),
      fixture.zshRc ?? "printf 'BB_USER_RC_LOADED\\n'\n",
    );
  } else {
    const fishConfigDirectory = path.join(home, ".config", "fish");
    await mkdir(fishConfigDirectory, { recursive: true });
    await writeFile(
      path.join(fishConfigDirectory, "config.fish"),
      fixture.fishConfig ?? "printf 'BB_USER_RC_LOADED\\n'\n",
    );
  }
  const shellEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    TERM: "xterm-256color",
    XDG_CONFIG_HOME: path.join(home, ".config"),
  };
  if (fixture.userZdotdir === null) delete shellEnv.ZDOTDIR;
  else shellEnv.ZDOTDIR = home;
  if (fixture.xdgDataDirs) shellEnv.XDG_DATA_DIRS = fixture.xdgDataDirs;
  const integration = await prepareTerminalShellIntegration({
    env: shellEnv,
    shell,
  });
  if (!integration) throw new Error(`No integration prepared for ${shell}`);
  if (shellName === "fish" && fixture.fishSourceIntegrationTwice) {
    const integrationFile = path.join(
      integration.env.XDG_DATA_DIRS?.split(path.delimiter)[0] ?? "",
      "fish",
      "vendor_conf.d",
      "bb-terminal.fish",
    );
    const fishConfigPath = path.join(home, ".config", "fish", "config.fish");
    await writeFile(
      fishConfigPath,
      `source '${integrationFile.replaceAll("'", "'\\''")}';\nsource '${integrationFile.replaceAll("'", "'\\''")}'\n`,
      { flag: "a" },
    );
  }
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
  let outputAtCommandEnd: string | null = null;
  const completion = createShellOutputCompletionGate(
    fixture.outputAfterExit ?? null,
  );
  let commandState = 0;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      terminal.kill();
      reject(
        new Error(
          `${shell} integration timed out: ${JSON.stringify(completion.output)}`,
        ),
      );
    }, 8_000);
    void completion.promise.then(({ output, exitCode }) => {
      clearTimeout(timer);
      void integration.cleanup();
      const cwdMark = /\u001b\]7;file:\/\/[^\u0007]+\u0007/.test(output);
      if (!cwdMark) {
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
      resolve({ output, outputAtCommandEnd, exitCode });
    });
    terminal.onData((chunk) => {
      completion.onData(chunk);
      if (
        commandState === 0 &&
        completion.output.includes("BB_USER_RC_LOADED") &&
        /\u001b\]133;A(?:;[^\u0007]*)?\u0007/.test(completion.output)
      ) {
        commandState = 1;
        const command =
          fixture.command ?? `cd '${fixture.cwdPath ?? "/tmp"}'; false`;
        const integrationSource = integration.args[1];
        const sourceTwice =
          shellName === "bash" && fixture.sourceIntegrationTwice
            ? `source '${integrationSource?.replaceAll("'", "'\\''") ?? ""}'; `
            : "";
        terminal.write(`${sourceTwice}${command}\n`);
      } else if (
        commandState === 1 &&
        completion.output.includes("\u001b]133;D;1\u0007") &&
        (shellName !== "fish" ||
          (completion.output.match(/\u001b\]133;A(?:;[^\u0007]*)?\u0007/g)
            ?.length ?? 0) >= 2)
      ) {
        commandState = 2;
        outputAtCommandEnd = completion.output;
        terminal.write(`${fixture.exitCommand ?? "exit 1"}\n`);
      }
    });
    terminal.onExit(({ exitCode }) => {
      completion.onExit(exitCode);
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

function percentEncodePath(value: string): string {
  return [...Buffer.from(value)]
    .map((byte) => {
      if (
        (byte >= 0x41 && byte <= 0x5a) ||
        (byte >= 0x61 && byte <= 0x7a) ||
        (byte >= 0x30 && byte <= 0x39) ||
        [0x2d, 0x2e, 0x2f, 0x5f, 0x7e].includes(byte)
      ) {
        return String.fromCharCode(byte);
      }
      return `%${byte.toString(16).padStart(2, "0").toUpperCase()}`;
    })
    .join("");
}

describe("terminal shell integration", () => {
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it.skipIf(["bash", "zsh", "fish"].some((shell) => !shellAvailable(shell)))(
    "percent-encodes OSC 7 cwd paths without changing their decoded value in Bash, zsh, and fish",
    async () => {
      const names = ["q?x", "h#x", "p%20x", "s p", "café"];
      for (const shell of ["bash", "zsh", "fish"]) {
        for (const name of names) {
          const root = await makeRoot();
          const cwd = path.join(root, name);
          await mkdir(cwd);
          const result = await runShell(shell, { cwdPath: cwd });
          const localCwdUrls = [
            ...result.output.matchAll(
              /\u001b\]7;(file:\/\/localhost[^\u0007]*)\u0007/g,
            ),
          ].map((match) => match[1]);
          const cwdUrl = localCwdUrls.find((value) =>
            value.includes(percentEncodePath(cwd)),
          );

          expect(
            cwdUrl,
            `${shell}:${name}:${JSON.stringify(result.output)}`,
          ).toBeTruthy();
          const encodedPath = new URL(cwdUrl!).pathname;
          expect(encodedPath).toBe(percentEncodePath(cwd));
          expect(decodeURIComponent(encodedPath)).toBe(cwd);
          expect(result.exitCode).toBe(1);
        }
      }
    },
    60_000,
  );

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

  it("composes PS0 and installs its hooks once when the rc is sourced twice", async () => {
    const result = await runShell("bash", {
      bashRc: `PS0='USER_PS0>'\nprintf 'BB_USER_RC_LOADED\\n'\n`,
      exitCommand: "printf 'BB_SHELL_OUTPUT_COMPLETE\\n'; exit 1",
      outputAfterExit: "BB_SHELL_OUTPUT_COMPLETE",
      sourceIntegrationTwice: true,
    });
    expect(result.output).toContain("USER_PS0>");
    expect(result.output).toContain("\u001b]133;B\u0007");
    expect(result.output).toContain("\u001b]133;C\u0007");
    expect(result.output.split("USER_PS0>")).toHaveLength(3);
    expect(result.output.split("\u001b]133;B\u0007")).toHaveLength(3);
    expect(result.output.split("\u001b]133;C\u0007")).toHaveLength(3);
    expect(result.output.split("BB_USER_RC_LOADED")).toHaveLength(2);
    expect(result.exitCode).toBe(1);
  });

  it("waits for final PTY output when the process exit event arrives first", async () => {
    const completion = createShellOutputCompletionGate("final-output");
    let settled = false;
    const result = completion.promise.then((value) => {
      settled = true;
      return value;
    });

    completion.onExit(1);
    await Promise.resolve();
    expect(settled).toBe(false);

    completion.onData("final-output");
    await expect(result).resolves.toEqual({
      output: "final-output",
      exitCode: 1,
    });
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

  it.skipIf(!shellAvailable("fish"))(
    "preserves fish user config and XDG_DATA_DIRS while emitting command marks once",
    async () => {
      const userDataDirectories = [
        path.join(os.tmpdir(), "bb-fish-user-data-one"),
        path.join(os.tmpdir(), "bb-fish-user-data-two"),
      ].join(path.delimiter);
      const result = await runShell("fish", {
        fishConfig: [
          "set -g BB_FISH_USER_VALUE preserved",
          "function fish_prompt",
          "  printf 'USER_FISH_PROMPT\\n'",
          "end",
          "printf 'BB_FISH_USER_VALUE=%s\\n' $BB_FISH_USER_VALUE",
          "printf 'BB_XDG_DATA_DIRS=%s\\n' \"$XDG_DATA_DIRS\"",
          "printf 'BB_USER_RC_LOADED\\n'",
        ].join("\n"),
        fishSourceIntegrationTwice: true,
        xdgDataDirs: userDataDirectories,
      });
      const output = result.outputAtCommandEnd ?? result.output;
      const reportedDataDirectories = output.match(
        /BB_XDG_DATA_DIRS=([^\r\n]+)/,
      )?.[1];
      const integrationDirectory = reportedDataDirectories?.split(
        path.delimiter,
      )[0];

      expect(output).toContain("USER_FISH_PROMPT");
      expect(output).toContain("BB_FISH_USER_VALUE=preserved");
      expect(output).toContain("BB_XDG_DATA_DIRS=");
      expect(reportedDataDirectories).toBeTruthy();
      expect(reportedDataDirectories).toContain(
        `${integrationDirectory}${path.delimiter}${userDataDirectories}`,
      );
      expect(output).toMatch(/\u001b\]133;A(?:;[^\u0007]*)?\u0007/);
      expect(output).toMatch(/\u001b\]133;B\u0007/);
      expect(output).toMatch(/\u001b\]133;C(?:;[^\u0007]*)?\u0007/);
      expect(output).toMatch(/\u001b\]133;D;1\u0007/);
      expect(output).toMatch(/\u001b\]7;file:\/\/[^/]*\/tmp\u0007/);
      expect(output.match(/\u001b\]133;A(?:;[^\u0007]*)?\u0007/g)).toHaveLength(
        2,
      );
      expect(output.match(/\u001b\]133;B\u0007/g)).toHaveLength(1);
      expect(output.match(/\u001b\]133;C(?:;[^\u0007]*)?\u0007/g)).toHaveLength(
        1,
      );
      expect(output.match(/\u001b\]133;D;1\u0007/g)).toHaveLength(1);
      expect(integrationDirectory).toBeTruthy();
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
    expect(fishConf).toContain(
      "if not functions -q __bb_terminal_shell_integration_installed",
    );
    expect(fishConf).toContain(
      "function __bb_terminal_shell_integration_prompt --on-event fish_prompt",
    );
    expect(fishConf).not.toContain("function fish_prompt");
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
            : [
                path.join(
                  directory,
                  "fish",
                  "vendor_conf.d",
                  "bb-terminal.fish",
                ),
              ];
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
