import { Command } from "commander";
import type { ThreadRowState } from "@bb/domain";
import { action, CliExitError } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { resolveContextThreadId } from "../../context-env.js";

interface OutputOptions {
  json?: boolean;
}

function currentThreadId(): string {
  const threadId = resolveContextThreadId();
  if (!threadId) {
    throw new CliExitError("Run this command inside a BB thread (BB_THREAD_ID is unset)", 1);
  }
  return threadId;
}

function printState(
  threadId: string,
  state: ThreadRowState | Pick<ThreadRowState, "statuses">,
  json: boolean | undefined,
): void {
  if (json) {
    console.log(JSON.stringify({ threadId, ...state }, null, 2));
    return;
  }
  console.log(`Thread: ${threadId}`);
  console.log(JSON.stringify(state, null, 2));
}

export function registerRowStateCommands(
  parent: Command,
  getUrl: () => string,
): void {
  const status = parent.command("row-status").description("Manage this thread's sidebar statuses");
  status.command("set")
    .description("Set a sidebar status")
    .argument("<key>")
    .argument("<value>")
    .option("--icon <icon>")
    .option("--color <color>")
    .option("--priority <number>")
    .option("--json")
    .action(action(async (key: string, value: string, options: OutputOptions & { icon?: string; color?: string; priority?: string }) => {
      const threadId = currentThreadId();
      const priority = options.priority === undefined ? undefined : Number(options.priority);
      if (priority !== undefined && !Number.isInteger(priority)) throw new CliExitError("--priority must be an integer", 1);
      const state = await createCliBbSdk(getUrl()).threads.experimental_updateRowState({
        threadId,
        action: "status-set",
        key,
        status: { value, ...(options.icon ? { icon: options.icon } : {}), ...(options.color ? { color: options.color } : {}), ...(priority === undefined ? {} : { priority }) },
      });
      printState(threadId, state, options.json);
    }));
  status.command("clear")
    .description("Clear one or all sidebar statuses")
    .argument("[key]")
    .option("--json")
    .action(action(async (key: string | undefined, options: OutputOptions) => {
      const threadId = currentThreadId();
      const state = await createCliBbSdk(getUrl()).threads.experimental_updateRowState({ threadId, action: "status-clear", ...(key === undefined ? {} : { key }) });
      printState(threadId, state, options.json);
    }));
  status.command("list")
    .description("List sidebar statuses")
    .option("--json")
    .action(action(async (options: OutputOptions) => {
      const threadId = currentThreadId();
      const state = await createCliBbSdk(getUrl()).threads.experimental_rowState({ threadId });
      printState(threadId, { statuses: state.statuses }, options.json);
    }));

  const progress = parent.command("progress").description("Manage this thread's sidebar progress");
  progress.argument("[value]").option("--label <text>").option("--json").action(action(async (value: string | undefined, options: OutputOptions & { label?: string }) => {
    if (value === undefined) throw new CliExitError("Provide a progress value from 0 to 1, or use 'bb thread progress clear'", 1);
    const progressValue = Number(value);
    if (!Number.isFinite(progressValue) || progressValue < 0 || progressValue > 1) throw new CliExitError("Progress must be a number from 0 to 1", 1);
    const threadId = currentThreadId();
    const state = await createCliBbSdk(getUrl()).threads.experimental_updateRowState({
      threadId,
      action: "progress-set",
      progress: { value: progressValue, ...(options.label === undefined ? {} : { label: options.label }) },
    });
    printState(threadId, state, options.json);
  }));
  progress.command("clear").description("Clear sidebar progress").option("--json").action(action(async (options: OutputOptions) => {
    const threadId = currentThreadId();
    const state = await createCliBbSdk(getUrl()).threads.experimental_updateRowState({ threadId, action: "progress-clear" });
    printState(threadId, state, options.json);
  }));
}
