import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface PreparedTerminalShellIntegration {
  args: string[];
  cleanup: () => Promise<void>;
  env: NodeJS.ProcessEnv;
}

const BASH_RC = String.raw`if [[ $- == *i* ]]; then
  [[ -r "$HOME/.bashrc" ]] && source "$HOME/.bashrc"
  PS0=$'\e]133;B\a\e]133;C\a'
  __bb_previous_prompt_command=$PROMPT_COMMAND
  __bb_prompt_command() {
    local __bb_status=$?
    printf '\e]133;D;%s\a\e]133;A\a\e]7;file://localhost%s\a' "$__bb_status" "$PWD"
    if [[ -n $__bb_previous_prompt_command ]]; then eval "$__bb_previous_prompt_command"; fi
  }
  PROMPT_COMMAND=__bb_prompt_command
fi
`;

const ZSH_ENV = String.raw`export ZDOTDIR="$BB_TERMINAL_ZDOTDIR"
if [[ -r "$BB_TERMINAL_USER_ZDOTDIR/.zshenv" ]]; then source "$BB_TERMINAL_USER_ZDOTDIR/.zshenv"; fi
export ZDOTDIR="$BB_TERMINAL_ZDOTDIR"
`;

const ZSH_RC = String.raw`[[ -o interactive ]] || return
if [[ -r "$BB_TERMINAL_USER_ZDOTDIR/.zshrc" ]]; then source "$BB_TERMINAL_USER_ZDOTDIR/.zshrc"; fi
function __bb_preexec() { print -Pn '\e]133;B\a\e]133;C\a' }
function __bb_precmd() { local __bb_status=$?; printf '\e]133;D;%s\a\e]133;A\a\e]7;file://localhost%s\a' "$__bb_status" "$PWD" }
preexec_functions+=(__bb_preexec)
precmd_functions+=(__bb_precmd)
`;

const FISH_CONF = String.raw`if status is-interactive
function __bb_prompt --on-event fish_prompt
  printf '\e]133;A\a\e]7;file://localhost%s\a' $PWD
end
function __bb_preexec --on-event fish_preexec
  printf '\e]133;B\a\e]133;C\a'
end
function __bb_postexec --on-event fish_postexec
  printf '\e]133;D;%s\a' $status
end
end
`;

export async function prepareTerminalShellIntegration(args: {
  env: NodeJS.ProcessEnv;
  shell: string;
}): Promise<PreparedTerminalShellIntegration | null> {
  const shellName = path.basename(args.shell).toLowerCase();
  if (!["bash", "zsh", "fish"].includes(shellName)) return null;
  const directory = await mkdtemp(path.join(os.tmpdir(), "bb-terminal-shell-"));
  const env = { ...args.env };
  let shellArgs: string[] = [];
  if (shellName === "bash") {
    const rcFile = path.join(directory, "bashrc");
    await writeFile(rcFile, BASH_RC, { mode: 0o600 });
    shellArgs = ["--rcfile", rcFile];
  } else if (shellName === "zsh") {
    const originalZdotdir = env.ZDOTDIR || env.HOME || os.homedir();
    await writeFile(path.join(directory, ".zshenv"), ZSH_ENV, { mode: 0o600 });
    await writeFile(path.join(directory, ".zshrc"), ZSH_RC, { mode: 0o600 });
    env.BB_TERMINAL_ZDOTDIR = directory;
    env.BB_TERMINAL_USER_ZDOTDIR = originalZdotdir;
    env.ZDOTDIR = directory;
  } else {
    const vendorConf = path.join(directory, "fish", "vendor_conf.d");
    await mkdir(vendorConf, { recursive: true, mode: 0o700 });
    await writeFile(path.join(vendorConf, "bb-terminal.fish"), FISH_CONF, {
      mode: 0o600,
    });
    const standardDataDirs =
      process.platform === "darwin"
        ? ["/opt/homebrew/share", "/usr/local/share", "/usr/share"]
        : ["/usr/local/share", "/usr/share"];
    env.XDG_DATA_DIRS = [
      directory,
      env.XDG_DATA_DIRS ?? standardDataDirs.join(path.delimiter),
    ].join(path.delimiter);
  }
  return {
    args: shellArgs,
    cleanup: () => rm(directory, { recursive: true, force: false }),
    env,
  };
}
