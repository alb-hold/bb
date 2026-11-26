import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { CORE_COMMAND_GROUPS, type CommandGroupDeps } from "../command-groups.js";
import { JSON_SHAPE_BY_COMMAND_PATH, jsonShapeHelp } from "../json-shapes.js";
import { resolveInvocation } from "../command-resolution.js";

const BRITISH_SPELLING_PATTERN =
  /\b(colours?|coloured|colouring|colourful|colourless|behaviours?|behavioural|favourites?|flavours?|neighbours?|neighbouring|(?:normal|recogn|optim|author|stabil|material)is(?:e|ed|es|ing|ation\w*)|signall(?:ed|ing)|labell(?:ed|ing)|travell(?:ed|ing)|artefacts?|centres?|dialogues?|catalogues?)\b/iu;

function applyHelpWidth(command: Command, helpWidth: number): void {
  command.configureHelp({ ...command.configureHelp(), helpWidth });
  for (const subcommand of command.commands) {
    applyHelpWidth(subcommand, helpWidth);
  }
}

async function buildProgramForHelp(): Promise<Command> {
  const program = new Command();
  program
    .name("bb")
    .description("bb CLI - manage your AI coding agents")
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

function extractExampleInvocations(help: string): string[] {
  const marker = "\nExamples:\n";
  const start = help.indexOf(marker);
  if (start === -1) return [];
  const rest = help.slice(start + marker.length);
  const lines: string[] = [];
  for (const line of rest.split("\n")) {
    if (line.trim().length === 0) break;
    if (!line.startsWith("  ")) break;
    lines.push(line.trim());
  }
  return lines;
}

function tokenizeExample(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === " ") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function assertExampleExists(program: Command, example: string): void {
  const tokens = tokenizeExample(example);
  expect(tokens[0], example).toBe("bb");

  let current = program;
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined || token.startsWith("-")) break;
    const match = current.commands.find(
      (subcommand) =>
        subcommand.name() === token || subcommand.aliases().includes(token),
    );
    if (match === undefined) break;
    current = match;
    index += 1;
  }

  expect(current, `command should resolve for: ${example}`).not.toBe(program);
  expect(
    current.parent,
    `example should target a subcommand: ${example}`,
  ).not.toBe(program);

  const registeredFlags = new Set(
    current.options.flatMap((option) =>
      [option.short, option.long].filter(
        (flag): flag is string => flag !== undefined,
      ),
    ),
  );
  for (const token of tokens.slice(index)) {
    if (token === "--") break;
    if (!token.startsWith("-")) continue;
    const flagName = token.split("=", 1)[0] ?? token;
    expect(
      registeredFlags.has(flagName),
      `flag ${flagName} should exist on "${current.name()}" for: ${example}`,
    ).toBe(true);
  }
}

function collectVisibleCommands(
  command: Command,
  prefix: readonly string[],
): Array<{ path: string; command: Command }> {
  const entries: Array<{ path: string; command: Command }> = [
    { path: prefix.join(" "), command },
  ];
  const helper = command.createHelp();
  for (const subcommand of helper.visibleCommands(command)) {
    if (subcommand.name() === "help") continue;
    entries.push(
      ...collectVisibleCommands(subcommand, [...prefix, subcommand.name()]),
    );
  }
  return entries;
}

describe("CLI help output", () => {
  it("documents native quick start, groups manager under Compatibility last, and wraps top-level help to 100 columns", async () => {
    const program = await buildProgramForHelp();
    const help = renderHelp(program);

    expect(help).toContain("bb CLI - manage your AI coding agents");
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

  it("groups bb thread subcommands with scannable headings and real examples wrapped to 100 columns", async () => {
    const program = await buildProgramForHelp();
    const thread = resolveInvocation(program, ["node", "bb", "thread"]).command;
    const help = renderHelp(thread);

    for (const heading of [
      "Create:",
      "Inspect:",
      "Message & control:",
      "App & sidebar:",
      "Organize & lifecycle:",
      "Examples:",
    ]) {
      expect(help).toContain(heading);
    }
    expect(help).not.toContain("Other commands:");
    expect(help.indexOf("Create:")).toBeLessThan(help.indexOf("Inspect:"));
    expect(help.indexOf("Inspect:")).toBeLessThan(
      help.indexOf("Message & control:"),
    );
    expect(help.indexOf("Message & control:")).toBeLessThan(
      help.indexOf("App & sidebar:"),
    );
    expect(help.indexOf("App & sidebar:")).toBeLessThan(
      help.indexOf("Organize & lifecycle:"),
    );
    expect(help.indexOf("Organize & lifecycle:")).toBeLessThan(
      help.indexOf("Examples:"),
    );

    const examples = extractExampleInvocations(help);
    expect(examples.length).toBeGreaterThanOrEqual(2);
    expect(examples.length).toBeLessThanOrEqual(4);
    for (const example of examples) {
      assertExampleExists(program, example);
    }

    const longLines = help
      .split("\n")
      .filter((line) => line.length > 100);
    expect(longLines).toEqual([]);
  }, 30_000);

  it("groups bb terminal subcommands with scannable headings and real examples wrapped to 100 columns", async () => {
    const program = await buildProgramForHelp();
    const terminal = resolveInvocation(program, [
      "node",
      "bb",
      "terminal",
    ]).command;
    const help = renderHelp(terminal);

    for (const heading of [
      "Create & run:",
      "Inspect:",
      "Control:",
      "Layout & attention:",
      "Examples:",
    ]) {
      expect(help).toContain(heading);
    }
    expect(help).not.toContain("Other commands:");
    expect(help.indexOf("Create & run:")).toBeLessThan(
      help.indexOf("Inspect:"),
    );
    expect(help.indexOf("Inspect:")).toBeLessThan(help.indexOf("Control:"));
    expect(help.indexOf("Control:")).toBeLessThan(
      help.indexOf("Layout & attention:"),
    );
    expect(help.indexOf("Layout & attention:")).toBeLessThan(
      help.indexOf("Examples:"),
    );
    expect(help).toContain("Set OSC 10/11 colors for the controlling terminal viewer");

    const examples = extractExampleInvocations(help);
    expect(examples.length).toBeGreaterThanOrEqual(2);
    expect(examples.length).toBeLessThanOrEqual(4);
    for (const example of examples) {
      assertExampleExists(program, example);
    }

    const longLines = help
      .split("\n")
      .filter((line) => line.length > 100);
    expect(longLines).toEqual([]);
  }, 30_000);

  it("uses US spelling and lowercase bb product naming across all visible CLI help output", async () => {
    const program = await buildProgramForHelp();
    const commands = collectVisibleCommands(program, ["bb"]);

    const spellingIssues: string[] = [];
    const productNameIssues: string[] = [];

    for (const entry of commands) {
      const help = renderHelp(entry.command);
      const spellingMatch = BRITISH_SPELLING_PATTERN.exec(help);
      if (spellingMatch !== null) {
        spellingIssues.push(`${entry.path}: ${spellingMatch[0]}`);
      }
      const sanitized = help
        .replace(/\bBB_[A-Z0-9_]+\b/gu, "")
        .replace(/\bX-BB-[A-Za-z-]+\b/gu, "");
      if (/\bBB\b/u.test(sanitized)) {
        productNameIssues.push(entry.path);
      }
    }

    expect(spellingIssues).toEqual([]);
    expect(productNameIssues).toEqual([]);
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
    expect(help).toContain("Color-palette-only changes");
    expect(help).not.toContain("Colour");
    expect(help).not.toContain("If both keys arrive in one input chunk, bb forwards them.");
  }, 30_000);
});
