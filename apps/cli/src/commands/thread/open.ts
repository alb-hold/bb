import path from "node:path";
import { Command } from "commander";
import { isRawThreadId } from "@bb/domain";
import {
  threadOpenSplitSchema,
  type PanelFileSource,
  type ThreadOpenFile,
} from "@bb/server-contract";
import { action, CliExitError } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { requireThreadId, resolveContextThreadId } from "../../context-env.js";
import {
  ALL_CLIENTS_OPTION_DESCRIPTION,
  openDeliveryScope,
  SKIP_REASON_MESSAGES,
  type OpenDeliveryOptions,
} from "../../open-delivery.js";
import {
  outputJson,
  printThreadContextLabel,
  type ResolvedId,
} from "../helpers.js";

interface ThreadOpenCommandOptions extends OpenDeliveryOptions {
  line?: string;
  json?: boolean;
  split?: string;
}

interface ThreadOpenTarget {
  threadId: string;
  inputPath: string | null;
  resolved: ResolvedId;
}

interface ThreadOpenFileRequest {
  source: PanelFileSource;
  path: string;
}

type CliBbSdk = ReturnType<typeof createCliBbSdk>;

export function registerOpenCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("open")
    .description(
      "Open a BB thread, optionally with a file in its panel, in the app clients viewing the current thread",
    )
    .usage("[id] [path] [options]")
    .argument(
      "[id]",
      "Thread ID. Inside a BB thread, omit it to target the current thread; a lone argument that is not a thread ID opens that file in the current thread",
    )
    .argument("[path]", "Thread-relative or absolute file path to open")
    .option("--line <number>", "Line number to focus")
    .option(
      "--split <placement>",
      "Open in right, down, left, top, or replace placement; edge placements add panes through pane 8, then replace the focused pane",
    )
    .option("--all", ALL_CLIENTS_OPTION_DESCRIPTION)
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          first: string | undefined,
          second: string | undefined,
          opts: ThreadOpenCommandOptions,
        ) => {
          const target = resolveThreadOpenTarget(first, second);
          const lineNumber = parseLineNumber(opts.line);
          const requestedSplit =
            opts.split === undefined
              ? undefined
              : threadOpenSplitSchema.parse(opts.split);
          const split = requestedSplit ?? "replace";
          if (target.inputPath === null && lineNumber !== null) {
            throw new Error("--line requires a file path.");
          }
          const sdk = createCliBbSdk(getUrl());
          const file: ThreadOpenFile | null =
            target.inputPath === null
              ? null
              : {
                  ...(await resolveThreadOpenFileRequest({
                    inputPath: target.inputPath,
                    sdk,
                    threadId: target.threadId,
                  })),
                  lineNumber,
                };
          const result = await sdk.threads.open({
            threadId: target.threadId,
            ...(requestedSplit === undefined ? {} : { split: requestedSplit }),
            file,
            ...openDeliveryScope(opts),
          });
          const skipReason = result.skipReason;
          const skipError =
            skipReason === null
              ? null
              : new CliExitError(SKIP_REASON_MESSAGES[skipReason], 1, {
                  code: skipReason,
                  hint: null,
                });

          if (
            outputJson(opts, {
              threadId: target.threadId,
              split,
              file,
              deliveredClients: result.deliveredClients,
              inputPath: target.inputPath,
              ...(skipReason === null || skipError === null
                ? {}
                : {
                    skipReason,
                    error: { code: skipReason, message: skipError.message },
                  }),
            })
          ) {
            if (skipError !== null) throw skipError;
            return;
          }
          if (skipError !== null) throw skipError;

          printThreadContextLabel(target.resolved);
          console.log(`Thread: ${target.threadId}`);
          console.log(`Split: ${split}`);
          if (file !== null) {
            console.log(`Source: ${file.source}`);
            console.log(`Path: ${file.path}`);
            if (file.lineNumber !== null) {
              console.log(`Line: ${file.lineNumber}`);
            }
          }
          console.log(
            `Request sent to ${result.deliveredClients} open bb app client${result.deliveredClients === 1 ? "" : "s"}; receipt and application are not confirmed.`,
          );
        },
      ),
    );
}

function resolveThreadOpenTarget(
  first: string | undefined,
  second: string | undefined,
): ThreadOpenTarget {
  const contextThreadId = resolveContextThreadId();
  if (
    first !== undefined &&
    (second !== undefined || !contextThreadId || isRawThreadId(first))
  ) {
    const threadId = requireThreadId(first);
    return {
      threadId,
      inputPath: second ?? null,
      resolved: { id: threadId, source: "arg" },
    };
  }

  if (!contextThreadId) {
    throw new Error(
      "Missing thread ID. Pass <threadId> [path], or run inside a BB thread.",
    );
  }
  return {
    threadId: contextThreadId,
    inputPath: first ?? null,
    resolved: { id: contextThreadId, source: "env" },
  };
}

function parseLineNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error("Invalid --line value. Pass a positive integer.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("Invalid --line value. Pass a positive integer.");
  }
  return parsed;
}

async function resolveThreadOpenFileRequest(args: {
  inputPath: string;
  sdk: CliBbSdk;
  threadId: string;
}): Promise<ThreadOpenFileRequest> {
  const inputPath = args.inputPath.trim();
  if (inputPath.length === 0) {
    throw new Error("Missing path. Pass <path>.");
  }

  if (!path.isAbsolute(inputPath)) {
    return {
      source: "workspace",
      path: normalizePanelRelativePath(inputPath),
    };
  }

  const absoluteInputPath = path.resolve(inputPath);
  const threadStorageRoot = resolveThreadStorageRoot(args.threadId);
  if (threadStorageRoot && pathContains(threadStorageRoot, absoluteInputPath)) {
    return {
      source: "thread-storage",
      path: normalizePanelRelativePath(
        toPanelRelativePath(threadStorageRoot, absoluteInputPath),
      ),
    };
  }

  const workspaceRoot = await resolveThreadWorkspaceRoot(
    args.sdk,
    args.threadId,
  );
  if (pathContains(workspaceRoot, absoluteInputPath)) {
    return {
      source: "workspace",
      path: normalizePanelRelativePath(
        toPanelRelativePath(workspaceRoot, absoluteInputPath),
      ),
    };
  }

  const acceptedRoots = threadStorageRoot
    ? "the target thread workspace or BB_THREAD_STORAGE"
    : "the target thread workspace";
  throw new Error(`Absolute path must be inside ${acceptedRoots}.`);
}

async function resolveThreadWorkspaceRoot(
  sdk: CliBbSdk,
  threadId: string,
): Promise<string> {
  const thread = await sdk.threads.get({ threadId });
  if (thread.environmentId === null) {
    throw new Error(`Thread ${threadId} does not have an attached workspace.`);
  }
  const environment = await sdk.environments.get({
    environmentId: thread.environmentId,
  });
  if (environment.path === null) {
    throw new Error(`Thread ${threadId} does not have a local workspace path.`);
  }
  return path.resolve(environment.path);
}

function resolveThreadStorageRoot(threadId: string): string | undefined {
  if (resolveContextThreadId() !== threadId) return undefined;
  const rawRoot = process.env.BB_THREAD_STORAGE?.trim();
  if (!rawRoot) return undefined;
  return path.resolve(rawRoot);
}

function pathContains(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function toPanelRelativePath(root: string, target: string): string {
  return path
    .relative(path.resolve(root), path.resolve(target))
    .split(path.sep)
    .join("/");
}

function normalizePanelRelativePath(inputPath: string): string {
  const normalized = path.normalize(inputPath).split(path.sep).join("/");
  if (normalized.includes("\\") || path.posix.isAbsolute(normalized)) {
    throw new Error(
      "Open path must be a relative file path without absolute path syntax.",
    );
  }

  const segments = normalized.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(
      "Open path must be a relative file path without . or .. segments.",
    );
  }

  return segments.join("/");
}
