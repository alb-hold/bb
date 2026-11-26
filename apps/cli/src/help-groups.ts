import type { Command, Help } from "commander";

export interface HelpCommandGroup {
  readonly heading: string;
  readonly commands: readonly string[];
}

function formatSubcommandItem(
  subcommand: Command,
  termWidth: number,
  helper: Help,
): string {
  return helper.formatItem(
    helper.subcommandTerm(subcommand),
    termWidth,
    helper.subcommandDescription(subcommand),
    helper,
  );
}

export function formatGroupedCommandHelp(
  cmd: Command,
  helper: Help,
  groups: readonly HelpCommandGroup[],
): string {
  const termWidth = helper.padWidth(cmd, helper);
  const output: string[] = [`Usage: ${helper.commandUsage(cmd)}`, ""];

  const commandDescription = helper.commandDescription(cmd);
  if (commandDescription.length > 0) {
    output.push(commandDescription, "");
  }

  const argumentList = helper
    .visibleArguments(cmd)
    .map((argument) =>
      helper.formatItem(
        helper.argumentTerm(argument),
        termWidth,
        helper.argumentDescription(argument),
        helper,
      ),
    );
  if (argumentList.length > 0) {
    output.push("Arguments:", ...argumentList, "");
  }

  const optionList = helper
    .visibleOptions(cmd)
    .map((option) =>
      helper.formatItem(
        helper.optionTerm(option),
        termWidth,
        helper.optionDescription(option),
        helper,
      ),
    );
  if (optionList.length > 0) {
    output.push("Options:", ...optionList, "");
  }

  const visibleCommands = helper.visibleCommands(cmd);
  const byName = new Map(
    visibleCommands.map((subcommand) => [subcommand.name(), subcommand]),
  );
  const assigned = new Set<string>();

  for (const group of groups) {
    const items: string[] = [];
    for (const name of group.commands) {
      const subcommand = byName.get(name);
      if (subcommand === undefined || assigned.has(name)) continue;
      assigned.add(name);
      items.push(formatSubcommandItem(subcommand, termWidth, helper));
    }
    if (items.length > 0) {
      output.push(`${group.heading}:`, ...items, "");
    }
  }

  const remaining = visibleCommands.filter(
    (subcommand) => !assigned.has(subcommand.name()),
  );
  const remainingOther = remaining.filter(
    (subcommand) => subcommand.name() !== "help",
  );
  const remainingHelp = remaining.filter(
    (subcommand) => subcommand.name() === "help",
  );

  if (remainingOther.length > 0) {
    output.push(
      "Other commands:",
      ...remainingOther.map((subcommand) =>
        formatSubcommandItem(subcommand, termWidth, helper),
      ),
      "",
    );
  }

  if (remainingHelp.length > 0) {
    output.push(
      "Help:",
      ...remainingHelp.map((subcommand) =>
        formatSubcommandItem(subcommand, termWidth, helper),
      ),
      "",
    );
  }

  return output.join("\n");
}

export function configureGroupedCommandHelp(
  command: Command,
  groups: readonly HelpCommandGroup[],
  examples: readonly string[],
): void {
  command.configureHelp({
    ...command.configureHelp(),
    formatHelp: (cmd, helper) => formatGroupedCommandHelp(cmd, helper, groups),
  });
  if (examples.length > 0) {
    command.addHelpText(
      "after",
      ["", "Examples:", ...examples.map((example) => `  ${example}`)].join(
        "\n",
      ),
    );
  }
}
