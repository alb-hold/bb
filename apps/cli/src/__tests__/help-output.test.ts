import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { CORE_COMMAND_GROUPS, type CommandGroupDeps } from "../command-groups.js";
import { JSON_SHAPE_BY_COMMAND_PATH, jsonShapeHelp } from "../json-shapes.js";
import { resolveInvocation } from "../command-resolution.js";

function applyHelpWidth(command: Command, helpWidth: number): void {
  command.configureHelp({ helpWidth });
  for (const subcommand of command.commands) {
    applyHelpWidth(subcommand, helpWidth);
  }
}

async function buildProgramForHelp(): Promise<Command> {
  const program = new Command();
  program
    .name("bb")
    .description("BB CLI - manage your AI coding agents")
    .enablePositionalOptions()
    .exitOverride()
    .showSuggestionAfterError(false);

  const deps: CommandGroupDeps = {
    getUrl: () => "http://localhost:38886",
    getContext: () => ({ serverUrl: "http://localhost:38886" }),
  };

  program.addHelpText(
    "after",
    `

Compatibility:
  manager                            Compatibility notice for removed manager commands

Current context:
  BB_PROJECT_ID: <unset>
  BB_THREAD_ID: <unset>
  BB_SERVER_URL: http://localhost:38886

Quick start:
  bb status
  bb project list
  bb thread show <id>
  bb thread spawn --project <id> --provider codex --prompt "..."
  bb thread spawn --project <id> --provider codex --native
  bb thread native <id> --attach
`,
  );

  for (const group of CORE_COMMAND_GROUPS) {
    const register = await group.load();
    register(program, deps);
  }
  for (const commandPath of Object.keys(JSON_SHAPE_BY_COMMAND_PATH)) {
    const invocation = resolveInvocation(program, [
      "node",
      "bb",
      ...commandPath.split(" "),
    ]);
    const help = jsonShapeHelp(commandPath);
    if (help === null || invocation.path.join(" ") !== commandPath) continue;
    invocation.command.addHelpText("after", help);
  }
  applyHelpWidth(program, 100);
  return program;
}

function renderHelp(command: Command): string {
  let out = "";
  command.configureOutput({
    writeOut: (str) => {
      out += str;
    },
    writeErr: (str) => {
      out += str;
    },
  });
  command.outputHelp();
  return out;
}

describe("CLI help output", () => {
  it("documents native quick start, groups manager under Compatibility last, and wraps top-level help to 100 columns", async () => {
    const program = await buildProgramForHelp();
    const help = renderHelp(program);

    expect(help).toContain("bb thread spawn --project <id> --provider codex --native");
    expect(help).toContain("bb thread native <id> --attach");
    expect(help).toContain("Compatibility:");
    expect(help.indexOf("Compatibility:")).toBeGreaterThan(
      help.indexOf("voice"),
    );
    expect(help.indexOf("manager")).toBeGreaterThan(
      help.indexOf("Compatibility:"),
    );

    const longLines = help
      .split("\n")
      .filter((line) => line.length > 100);
    expect(longLines).toEqual([]);
  }, 30_000);

  it("documents optional prompt for --native, no-prompt example, and --permission-mode semantics in bb thread spawn --help", async () => {
    const program = await buildProgramForHelp();
    const spawn = resolveInvocation(program, ["node", "bb", "thread", "spawn"]).command;
    const help = renderHelp(spawn);
    const flat = help.replace(/\s+/gu, " ");

    expect(flat).toContain("required unless --prompt-file or --native is given");
    expect(help).toContain("bb thread spawn --project <id> --provider codex --native");
    expect(flat).toContain("default: auto");
    expect(flat).toContain("accept-edits");
    expect(flat).toContain("full");
  }, 30_000);

  it("documents default action, flag combinations, and --json output in bb thread native --help", async () => {
    const program = await buildProgramForHelp();
    const native = resolveInvocation(program, ["node", "bb", "thread", "native"]).command;
    const help = renderHelp(native);

    expect(help).toContain("default when neither --convert nor --chat is given");
    expect(help).toContain("Flag combinations:");
    expect(help).toContain("--attach combines with default open or --convert");
    expect(help).toContain("--chat cannot");
    expect(help).toContain("JSON (--json):");
    expect(help).toContain("nativeSessionId");
  }, 30_000);

  it("documents configurable detach chord in bb terminal attach --help", async () => {
    const program = await buildProgramForHelp();
    const attach = resolveInvocation(program, ["node", "bb", "terminal", "attach"]).command;
    const help = renderHelp(attach);

    expect(help).toContain("--detach-key <chord>");
    expect(help).toContain("BB_TERMINAL_DETACH_KEY");
    expect(help).not.toContain("If both keys arrive in one input chunk, bb forwards them.");
  }, 30_000);
});
