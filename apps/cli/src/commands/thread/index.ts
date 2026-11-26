import { registerContextCommand } from "./context.js";
import { registerSessionStateCommands } from "./session-state.js";
import { Command } from "commander";
import {
  configureGroupedCommandHelp,
  type HelpCommandGroup,
} from "../../help-groups.js";
import { registerActionsCommands } from "./actions.js";
import { registerCountCommand } from "./count.js";
import { registerInteractionCommands } from "./interactions.js";
import { registerListCommand } from "./list.js";
import { registerOpenCommand } from "./open.js";
import { registerPaneCommand } from "./pane.js";
import { registerOrganizationCommands } from "./organization.js";
import { registerShowCommand } from "./show.js";
import { registerSpawnCommand } from "./spawn.js";
import { registerForkCommand } from "./fork.js";
import { registerWaitCommand } from "./wait.js";
import { registerNativeCommands } from "./native.js";
import { registerRowStateCommands } from "./row-state.js";

const THREAD_HELP_GROUPS: readonly HelpCommandGroup[] = [
  {
    heading: "Create",
    commands: ["spawn", "fork"],
  },
  {
    heading: "Inspect",
    commands: [
      "list",
      "count",
      "show",
      "log",
      "output",
      "wait",
      "context",
      "commands",
      "options",
      "search",
      "prompt-search",
      "history",
    ],
  },
  {
    heading: "Message & control",
    commands: [
      "tell",
      "edit-message",
      "queue",
      "interactions",
      "retry",
      "stop",
      "compact",
      "clear",
      "cancel-plan",
      "clear-goal",
      "native",
    ],
  },
  {
    heading: "App & sidebar",
    commands: ["open", "pane", "tabs", "row-status", "progress"],
  },
  {
    heading: "Organize & lifecycle",
    commands: [
      "update",
      "regenerate-title",
      "section",
      "pin",
      "unpin",
      "reorder-pinned",
      "read",
      "unread",
      "archive",
      "unarchive",
      "restore-environment",
      "delete",
    ],
  },
];

const THREAD_HELP_EXAMPLES: readonly string[] = [
  "bb thread list --project <id>",
  'bb thread spawn --project <id> --provider codex --prompt "Fix the failing test"',
  'bb thread tell <id> "Run the test suite"',
  "bb thread wait <id> --timeout 5m",
];

export function registerThreadCommands(
  program: Command,
  getUrl: () => string,
): void {
  const thread = program.command("thread").description("Manage threads");
  configureGroupedCommandHelp(thread, THREAD_HELP_GROUPS, THREAD_HELP_EXAMPLES);
  registerWaitCommand(thread, getUrl);
  registerSpawnCommand(thread, getUrl);
  registerForkCommand(thread, getUrl);
  registerListCommand(thread, getUrl);
  registerCountCommand(thread, getUrl);
  registerContextCommand(thread, getUrl);
  registerSessionStateCommands(thread, getUrl);
  registerShowCommand(thread, getUrl);
  registerOpenCommand(thread, getUrl);
  registerPaneCommand(thread, getUrl);
  registerOrganizationCommands(thread, getUrl);
  registerActionsCommands(thread, getUrl);
  registerInteractionCommands(thread, getUrl);
  registerNativeCommands(thread, getUrl);
  registerRowStateCommands(thread, getUrl);
}
