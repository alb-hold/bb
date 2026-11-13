import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Command, Option } from "commander";
import {
  createTerminalGridByteMarkerScanner,
  TERMINAL_DATA_MAX_BYTES,
} from "@bb/domain";
import {
  BbHttpError,
  type BbSdk,
  type TerminalCreateScope,
  type TerminalListScope,
} from "@bb/sdk";
import { TerminalWebSocketTransport } from "@bb/client-core";
import {
  type TerminalSession,
  type ThreadOpenSkipReason,
} from "@bb/server-contract";
import { action, CliExitError, CliUsageError } from "../action.js";
import { createCliBbSdk } from "../client.js";
import {
  defaultNativeHolderSocketPath,
  ignoreNativeHolderSignals,
  nativeTerminalCheck,
  openNativeHolderConnection,
  pipeNativeHolderClient,
  runNativeHolder,
  writeNativeHolderAttachMarker,
} from "../native-holder.js";
import { terminalScopeHint } from "../context-hints.js";
import { durationHelp, parseDurationMs } from "../duration.js";
import {
  ALL_CLIENTS_OPTION_DESCRIPTION,
  openDeliveryScope,
  SKIP_REASON_MESSAGES,
  type OpenDeliveryOptions,
} from "../open-delivery.js";
import { columnWidths, printBorderlessTable } from "../table.js";
import { outputJson } from "./helpers.js";
import { resolveMachineHostId, resolveMachineTargetOption } from "./machine.js";
import {
  DEFAULT_TERMINAL_WAIT_MAX_OUTPUT_BYTES,
  describeTerminalExit,
  observeTerminal,
  parseMaxOutputBytes,
  parseTerminalOutputCondition,
  reportTerminalObservation,
  terminalPlainText,
  type TerminalObservePlan,
} from "./terminal-wait.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const WAIT_POLL_DELAYS_MS = [100, 200, 400, 800, 1000] as const;
const RUN_USAGE_EXAMPLE =
  "For example: bb terminal run --machine <id-or-name> --cwd /path/to/repo -- pnpm test";
const NO_APP_CLIENT_MESSAGE =
  "No bb app is open to apply this; open bb and retry";

function reportTerminalActionDelivery(
  deliveredClients: number,
  skipReason: ThreadOpenSkipReason | null,
): void {
  if (deliveredClients === 0) {
    throw new CliExitError(
      skipReason === null
        ? NO_APP_CLIENT_MESSAGE
        : SKIP_REASON_MESSAGES[skipReason],
      1,
      { code: skipReason ?? "no_app_clients", hint: null },
    );
  }
  console.log(
    `Request sent to ${deliveredClients} open bb app client${deliveredClients === 1 ? "" : "s"}; receipt and application are not confirmed.`,
  );
}

function reportTerminalActionResult(
  opts: TerminalJsonOptions,
  result: Record<string, unknown> & { deliveredClients: number },
  skipReason: ThreadOpenSkipReason | null = null,
): void {
  if (opts.json) {
    outputJson(opts, {
      ...result,
      ...(skipReason === null ? {} : { skipReason }),
      ...(result.deliveredClients === 0
        ? {
            error: {
              code: skipReason ?? "no_app_clients",
              message:
                skipReason === null
                  ? NO_APP_CLIENT_MESSAGE
                  : SKIP_REASON_MESSAGES[skipReason],
            },
          }
        : {}),
    });
    if (result.deliveredClients === 0)
      reportTerminalActionDelivery(0, skipReason);
    return;
  }
  reportTerminalActionDelivery(result.deliveredClients, skipReason);
}

interface TerminalDeliveryOptions
  extends TerminalJsonOptions, OpenDeliveryOptions {}

interface TerminalJsonOptions {
  json?: boolean;
}

interface TerminalScopeOptions {
  cwd?: string;
  environment?: string;
  host?: string;
  machine?: string;
  thread?: string;
}

interface TerminalListOptions
  extends TerminalJsonOptions, TerminalScopeOptions {}

interface TerminalStartOptions
  extends TerminalJsonOptions, TerminalScopeOptions {
  attach?: boolean;
  command?: string;
  cols?: string;
  id?: string;
  rows?: string;
  title?: string;
  workingDirectory?: string;
}

interface TerminalRunOptions extends TerminalJsonOptions, TerminalScopeOptions {
  cols?: string;
  contains?: string;
  id?: string;
  maxOutputBytes: string;
  regex?: string;
  rows?: string;
  timeout: string;
  title?: string;
}

interface TerminalSendOptions extends TerminalJsonOptions {
  enter?: boolean;
  stdin?: boolean;
  text?: string;
}

interface TerminalResizeOptions extends TerminalJsonOptions {
  cols: string;
  rows: string;
}

interface TerminalOutputOptions extends TerminalJsonOptions {
  limitChunks?: string;
  lines?: string;
  sinceSeq?: string;
  tailBytes?: string;
}

interface TerminalReadOptions extends TerminalOutputOptions {
  plain?: boolean;
}

interface TerminalScreenOptions extends TerminalJsonOptions {
  lines?: string;
}

interface TerminalPipeOptions {
  command?: string;
  follow?: boolean;
}

interface TerminalWaitOptions extends TerminalOutputOptions {
  contains?: string;
  exit?: boolean;
  fromStart?: boolean;
  maxOutputBytes: string;
  pollInterval?: string;
  regex?: string;
  timeout: string;
}

interface TerminalCloseOptions extends TerminalJsonOptions {
  ifClean?: boolean;
}

interface TerminalNotifyOptions {
  body: string;
  title: string;
}

interface TerminalAttentionOptions extends TerminalJsonOptions {}

interface TerminalSurfacesOptions extends TerminalJsonOptions {
  thread: string;
}

type TerminalStartResolution =
  | { mode: "shell" }
  | { mode: "command"; command: string }
  | { mode: "argv"; argv: string[] };

export function registerTerminalCommands(
  program: Command,
  getUrl: () => string,
): void {
  const terminal = program
    .command("terminal")
    .description(
      "Manage terminal sessions across threads, environments, and machines",
    );

  terminal
    .command("holder-shell-client <terminalId> <shell> <shellArgsBase64>", {
      hidden: true,
    })
    .action(
      action(
        async (terminalId: string, shell: string, shellArgsBase64: string) => {
          const baseUrl = getUrl();
          const socketPath = defaultNativeHolderSocketPath(baseUrl, terminalId);
          const script = process.argv[1];
          if (script === undefined)
            throw new CliExitError("Cannot locate the bb CLI", 1);
          const session = await createCliBbSdk(baseUrl).terminals.get({
            terminalId,
          });
          const connection = await openNativeHolderConnection({
            socketPath,
            reattachOnly:
              session.status === "exited" ||
              process.env.BB_TERMINAL_HOLDER_REATTACH_ONLY === "1",
            startTimeoutMs: 20_000,
            startHolder: () => {
              const holder = spawn(
                process.execPath,
                [
                  ...process.execArgv,
                  script,
                  "terminal",
                  "holder-shell",
                  terminalId,
                  shell,
                  shellArgsBase64,
                ],
                {
                  cwd: process.cwd(),
                  detached: true,
                  env: process.env,
                  stdio: "ignore",
                },
              );
              holder.unref();
            },
          });
          if (connection.kind !== "attached") return;
          writeNativeHolderAttachMarker(process.stdout, terminalId);
          for (const signal of ["SIGTERM", "SIGHUP"] as const) {
            process.on(signal, () => connection.socket.destroy());
          }
          await pipeNativeHolderClient(connection.socket, {
            input: process.stdin,
            output: process.stdout,
            fallbackSize: { cols: 80, rows: 24 },
          });
        },
      ),
    );

  terminal
    .command("holder-shell <terminalId> <shell> <shellArgsBase64>", {
      hidden: true,
    })
    .action(
      action(
        async (terminalId: string, shell: string, shellArgsBase64: string) => {
          const socketPath = defaultNativeHolderSocketPath(
            getUrl(),
            terminalId,
          );
          ignoreNativeHolderSignals(process, socketPath);
          delete process.env.BB_TERMINAL_HOLDER_REATTACH_ONLY;
          const shellArgs: unknown = JSON.parse(
            Buffer.from(shellArgsBase64, "base64").toString("utf8"),
          );
          if (
            !Array.isArray(shellArgs) ||
            !shellArgs.every((arg) => typeof arg === "string")
          ) {
            throw new CliExitError("Invalid shell arguments", 1);
          }
          const nodePty = await import("node-pty");
          const sdk = createCliBbSdk(getUrl());
          const exitCode = await runNativeHolder({
            socketPath,
            cwd: process.cwd(),
            env: process.env,
            prepare: async () => ({ command: shell, args: shellArgs }),
            spawnPty: (child, options) =>
              nodePty.spawn(child.command, child.args, {
                name: process.env.TERM ?? "xterm-256color",
                cols: options.cols,
                rows: options.rows,
                cwd: options.cwd,
                env: options.env,
              }),
            checkTerminal: async () => {
              try {
                const session = await sdk.terminals.get({ terminalId });
                return nativeTerminalCheck({ terminal: session });
              } catch (error) {
                if (
                  error instanceof Error &&
                  "status" in error &&
                  error.status === 404
                ) {
                  return "closed-for-good";
                }
                throw error;
              }
            },
          });
          process.exitCode = exitCode;
        },
      ),
    );

  addTerminalScopeOptions(
    terminal
      .command("list")
      .description("List terminal sessions in exactly one scope")
      .option("--json", "Print machine-readable JSON output"),
  ).action(
    action(async (opts: TerminalListOptions) => {
      const sdk = createCliBbSdk(getUrl());
      const result = await sdk.terminals.list({
        scope: await resolveTerminalListScope(opts, getUrl()),
      });
      if (outputJson(opts, result)) return;
      printTerminalTable(result.sessions);
    }),
  );

  const attention = terminal
    .command("attention")
    .description("Inspect and manage uncleared terminal attention");

  attention
    .command("list")
    .description("List terminals with uncleared attention")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: TerminalAttentionOptions) => {
        const sessions =
          await createCliBbSdk(
            getUrl(),
          ).terminals.experimental_attention.list();
        if (outputJson(opts, { sessions })) return;
        if (sessions.length === 0) {
          console.log("Nothing needs attention.");
          return;
        }
        for (const session of sessions) {
          console.log(
            `${session.attention?.at ?? 0}\t${session.id}\t${session.title}\t${session.threadId ?? session.environmentId ?? session.hostId}`,
          );
        }
      }),
    );

  terminal
    .command("surfaces")
    .description("List terminal surfaces attached to a thread")
    .requiredOption("--thread <id>", "Thread ID")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: TerminalSurfacesOptions) => {
        const surfaces = await createCliBbSdk(
          getUrl(),
        ).terminals.experimental_surfaces.list({ threadId: opts.thread });
        if (outputJson(opts, { threadId: opts.thread, surfaces })) return;
        for (const surface of surfaces) {
          console.log(
            `${surface.terminalId}\t${surface.title}\t${surface.status}\t${surface.kind}`,
          );
        }
      }),
    );

  terminal
    .command("focus <terminalId>")
    .description("Focus a terminal tab in the app clients viewing this thread")
    .option("--all", ALL_CLIENTS_OPTION_DESCRIPTION)
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalDeliveryOptions) => {
        const result = await createCliBbSdk(
          getUrl(),
        ).terminals.experimental_focus({
          terminalId,
          ...openDeliveryScope(opts),
        });
        reportTerminalActionResult(
          opts,
          { terminalId, deliveredClients: result.deliveredClients },
          result.skipReason,
        );
      }),
    );

  terminal
    .command("open-link <terminalId> <url>")
    .description(
      "Open a URL in the browser tab of the app clients viewing this thread",
    )
    .option("--all", ALL_CLIENTS_OPTION_DESCRIPTION)
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          terminalId: string,
          url: string,
          opts: TerminalDeliveryOptions,
        ) => {
          const result = await createCliBbSdk(
            getUrl(),
          ).terminals.experimental_openBrowser({
            terminalId,
            url,
            ...openDeliveryScope(opts),
          });
          reportTerminalActionResult(
            opts,
            { terminalId, url, deliveredClients: result.deliveredClients },
            result.skipReason,
          );
        },
      ),
    );

  terminal
    .command("split <terminalId>")
    .description(
      "Place a terminal in a new side panel pane in the app clients viewing this thread",
    )
    .requiredOption("--side <side>", "Pane side: right, left, up, or down")
    .option("--all", ALL_CLIENTS_OPTION_DESCRIPTION)
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          terminalId: string,
          opts: TerminalDeliveryOptions & { side: string },
        ) => {
          if (!["right", "left", "up", "down"].includes(opts.side)) {
            throw new CliUsageError({
              code: "invalid_terminal_split_side",
              hint: "Choose right, left, up, or down.",
              message: "--side must be right, left, up, or down",
            });
          }
          const result = await createCliBbSdk(
            getUrl(),
          ).terminals.experimental_layout.split({
            terminalId,
            side: opts.side as "right" | "left" | "up" | "down",
            ...openDeliveryScope(opts),
          });
          reportTerminalActionResult(
            opts,
            {
              terminalId,
              side: opts.side,
              deliveredClients: result.deliveredClients,
            },
            result.skipReason,
          );
        },
      ),
    );

  terminal
    .command("colors <terminalId>")
    .description("Set OSC 10/11 colours for the controlling terminal viewer")
    .requiredOption("--foreground <r,g,b>", "Foreground sRGB channels (0–255)")
    .requiredOption("--background <r,g,b>", "Background sRGB channels (0–255)")
    .requiredOption("--viewer-token <token>", "Controlling app viewer token")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          terminalId: string,
          opts: {
            foreground: string;
            background: string;
            viewerToken: string;
            json?: boolean;
          },
        ) => {
          const rgb = (value: string): [number, number, number] => {
            const channels = value.split(",").map(Number);
            if (
              channels.length !== 3 ||
              value.split(",").some((channel) => !/^\d+$/u.test(channel)) ||
              channels.some(
                (channel) =>
                  !Number.isInteger(channel) || channel < 0 || channel > 255,
              )
            )
              throw new CliUsageError({
                code: "invalid_terminal_color",
                hint: "Use r,g,b channels",
                message:
                  "Colours must contain three comma-separated integers from 0 to 255",
              });
            return [channels[0], channels[1], channels[2]];
          };
          const session = await createCliBbSdk(
            getUrl(),
          ).terminals.experimental_setDefaultColors({
            terminalId,
            foreground: rgb(opts.foreground),
            background: rgb(opts.background),
            viewerToken: opts.viewerToken,
          });
          if (!outputJson(opts, session))
            console.log(`Updated terminal colours for ${session.id}`);
        },
      ),
    );

  terminal
    .command("move <terminalId>")
    .description(
      "Move a terminal tab to the pane containing another terminal in the app clients viewing this thread",
    )
    .requiredOption(
      "--to-pane-of <terminalId>",
      "Terminal whose pane receives this tab",
    )
    .option("--all", ALL_CLIENTS_OPTION_DESCRIPTION)
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          terminalId: string,
          opts: TerminalDeliveryOptions & { toPaneOf: string },
        ) => {
          const result = await createCliBbSdk(
            getUrl(),
          ).terminals.experimental_layout.move({
            terminalId,
            targetTerminalId: opts.toPaneOf,
            ...openDeliveryScope(opts),
          });
          reportTerminalActionResult(
            opts,
            {
              terminalId,
              targetTerminalId: opts.toPaneOf,
              deliveredClients: result.deliveredClients,
            },
            result.skipReason,
          );
        },
      ),
    );

  attention
    .command("next")
    .description("Print the oldest terminal with uncleared attention")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: TerminalAttentionOptions) => {
        const session =
          await createCliBbSdk(
            getUrl(),
          ).terminals.experimental_attention.next();
        if (session === null) {
          if (outputJson(opts, { session: null })) return;
          console.log("Nothing needs attention.");
          return;
        }
        if (outputJson(opts, { session })) return;
        console.log(
          `${session.id}\t${session.title}\t${session.threadId ?? session.environmentId ?? session.hostId}`,
        );
      }),
    );

  attention
    .command("clear <terminalId>")
    .description("Clear attention for a terminal")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalAttentionOptions) => {
        const session = await createCliBbSdk(
          getUrl(),
        ).terminals.experimental_attention.clear({ terminalId });
        if (outputJson(opts, session)) return;
        console.log(`Cleared attention for terminal ${session.id}`);
      }),
    );

  terminal
    .command("notify")
    .description("Raise terminal attention from the current bb terminal")
    .requiredOption("--title <title>", "Notification title")
    .requiredOption("--body <body>", "Notification body")
    .action(
      action(async (opts: TerminalNotifyOptions) => {
        const terminalId = process.env.BB_TERMINAL_SESSION_ID;
        if (!terminalId) {
          throw new CliUsageError({
            code: "missing_terminal_identity",
            hint: "Run this command inside a terminal created by bb.",
            message: "This shell has no bb terminal identity.",
          });
        }
        await createCliBbSdk(getUrl()).terminals.notify({
          terminalId,
          title: opts.title,
          body: opts.body,
        });
        console.log(`Attention sent for terminal ${terminalId}`);
      }),
    );

  addTerminalScopeOptions(
    terminal
      .command("create [command...]")
      .alias("start")
      .description("Create a terminal session in exactly one scope")
      .option("--title <title>", "Terminal title")
      .option(
        "--id <terminal-id>",
        "Create the terminal with this ID (term_ plus 10 characters); fails if the ID exists",
      )
      .option(
        "--command <command>",
        "Command to run instead of an interactive shell",
      )
      .option(
        "--cols <n>",
        `Initial terminal columns (default: ${DEFAULT_COLS})`,
      )
      .option("--rows <n>", `Initial terminal rows (default: ${DEFAULT_ROWS})`)
      .option("--working-directory <path>", "Initial shell working directory")
      .option("--attach", "Attach after creating")
      .option("--json", "Print machine-readable JSON output"),
  ).action(
    action(async (commandParts: string[], opts: TerminalStartOptions) => {
      const sdk = createCliBbSdk(getUrl());
      const resolvedStart = resolveTerminalStart({
        commandOption: opts.command,
        commandParts,
      });
      const session = await sdk.terminals.create({
        cols: parsePositiveInteger(opts.cols, DEFAULT_COLS, "--cols"),
        ...(opts.workingDirectory === undefined
          ? {}
          : { cwd: opts.workingDirectory }),
        id: opts.id,
        rows: parsePositiveInteger(opts.rows, DEFAULT_ROWS, "--rows"),
        scope: await resolveTerminalCreateScope(opts, getUrl()),
        title: opts.title,
        start: resolvedStart,
      });
      if (outputJson(opts, session)) return;
      console.log(`Created terminal ${session.id} (${session.title})`);
      if (opts.attach) {
        await attachTerminal({
          baseUrl: getUrl(),
          terminalId: session.id,
        });
      }
    }),
  );

  addTerminalScopeOptions(
    terminal
      .command("run [command...]")
      .description(
        "Run a command in a new terminal and return its output and exit code",
      )
      .option(
        "--contains <text>",
        "Return once the output contains this text instead of waiting for exit",
      )
      .option(
        "--regex <pattern>",
        "Return once the output matches this regular expression instead of waiting for exit",
      )
      .option(
        "--timeout <duration>",
        `Stop waiting after ${durationHelp("s")}; the command keeps running`,
        "30s",
      )
      .option(
        "--max-output-bytes <n>",
        "Return at most the last N bytes of output",
        DEFAULT_TERMINAL_WAIT_MAX_OUTPUT_BYTES,
      )
      .option(
        "--id <terminal-id>",
        "Run in a terminal with this ID (term_ plus 10 characters); a retry with the same ID fails instead of running twice",
      )
      .option("--title <title>", "Terminal title (default: the command)")
      .option(
        "--cols <n>",
        `Initial terminal columns (default: ${DEFAULT_COLS})`,
      )
      .option("--rows <n>", `Initial terminal rows (default: ${DEFAULT_ROWS})`)
      .option("--json", "Print machine-readable JSON output"),
  ).action(
    action(async (commandParts: string[], opts: TerminalRunOptions) => {
      if (commandParts.length === 0) {
        throw new CliUsageError({
          code: "missing_required",
          hint: RUN_USAGE_EXAMPLE,
          message: "Provide the command to run after --",
        });
      }
      const plan: TerminalObservePlan = {
        condition: parseTerminalOutputCondition(opts),
        maxOutputBytes: parseMaxOutputBytes(opts.maxOutputBytes),
        outputBounds: {},
        pollDelaysMs: WAIT_POLL_DELAYS_MS,
        sinceSeq: 0,
        timeoutMs: parseTimeout(opts.timeout),
      };
      const cols = parsePositiveInteger(opts.cols, DEFAULT_COLS, "--cols");
      const rows = parsePositiveInteger(opts.rows, DEFAULT_ROWS, "--rows");
      const sdk = createCliBbSdk(getUrl());
      const session = await createRunTerminal({
        argv: commandParts,
        cols,
        id: opts.id,
        rows,
        scope: await resolveTerminalCreateScope(opts, getUrl()),
        sdk,
        title: opts.title,
      });
      reportTerminalObservation({
        json: opts.json === true,
        report: await observeTerminal({ plan, sdk, terminalId: session.id }),
      });
    }),
  );

  terminal
    .command("show <terminalId>")
    .description("Show a terminal session")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalJsonOptions) => {
        const session = await createCliBbSdk(getUrl()).terminals.get({
          terminalId,
        });
        if (outputJson(opts, session)) return;
        console.log(JSON.stringify(session, null, 2));
      }),
    );

  terminal
    .command("attach <terminalId>")
    .description("Attach to a running terminal session")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalJsonOptions) => {
        if (opts.json) {
          const session = await createCliBbSdk(getUrl()).terminals.get({
            terminalId,
          });
          outputJson(opts, session);
          return;
        }
        await attachTerminal({
          baseUrl: getUrl(),
          terminalId,
        });
      }),
    );

  terminal
    .command("send <terminalId>")
    .description("Send input to a terminal session")
    .option("--text <text>", "Text to send")
    .option("--stdin", "Read bytes from stdin")
    .option("--enter", "Press Enter after the text")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalSendOptions) => {
        const data = await resolveSendData(opts);
        const sdk = createCliBbSdk(getUrl());
        let session: TerminalSession | null = null;
        for (const chunk of chunkTerminalInput(data)) {
          session = await sdk.terminals.input({
            terminalId,
            dataBase64: chunk.toString("base64"),
          });
        }
        if (session === null) {
          throw new CliExitError("Terminal input cannot be empty", 1);
        }
        if (outputJson(opts, session)) return;
        console.log(`Sent input to terminal ${terminalId}`);
      }),
    );

  terminal
    .command("resize <terminalId>")
    .description("Resize a terminal session")
    .requiredOption("--cols <n>", "Terminal columns")
    .requiredOption("--rows <n>", "Terminal rows")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalResizeOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const session = await sdk.terminals.resize({
          terminalId,
          cols: parseRequiredPositiveInteger(opts.cols, "--cols"),
          rows: parseRequiredPositiveInteger(opts.rows, "--rows"),
        });
        if (outputJson(opts, session)) return;
        console.log(
          `Resized terminal ${terminalId} to ${session.cols}x${session.rows}`,
        );
      }),
    );

  terminal
    .command("screen <terminalId>")
    .description("Print the rendered terminal screen")
    .option(
      "--lines <n>",
      "Print the latest N rendered rows, including scrollback",
    )
    .option(
      "--json",
      "Print machine-readable JSON including cursor and grid size",
    )
    .action(
      action(async (terminalId: string, opts: TerminalScreenOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const screen = await sdk.terminals.experimental_screen({
          terminalId,
          ...(opts.lines === undefined ? {} : { lines: Number(opts.lines) }),
        });
        if (outputJson(opts, screen)) return;
        process.stdout.write(`${screen.rows.join("\n")}\n`);
        if (!screen.complete) {
          process.stdout.write(
            "Screen may be incomplete because earlier terminal output was discarded.\n",
          );
        }
      }),
    );

  terminal
    .command("output <terminalId>")
    .alias("read")
    .description(
      "Print terminal output; retention survives server restarts and is capped at 64 KiB per terminal, 2 MiB and 128 terminals per machine for 30 minutes",
    )
    .option("--since-seq <n>", "Only output chunks from this sequence")
    .option("--tail-bytes <n>", "Bound output to the latest N bytes")
    .option("--limit-chunks <n>", "Bound output to the latest N chunks")
    .option(
      "--plain",
      "Print plain text, with colors and progress redraws removed",
    )
    .option("--lines <n>", "Print the latest N lines")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalReadOptions) => {
        if (opts.plain === true && opts.json === true) {
          throw new CliUsageError({
            code: "invalid_value",
            hint: "--json returns the raw chunks; use terminal wait --json for plain output.",
            message: "Provide only one of --plain or --json",
          });
        }
        const sdk = createCliBbSdk(getUrl());
        const output = await sdk.terminals.output({
          terminalId,
          ...terminalOutputQuery(opts),
        });
        const displayOutput = stripTerminalGridMarkersFromOutput(output);
        if (outputJson(opts, displayOutput)) return;
        if (opts.plain === true) {
          process.stdout.write(
            terminalPlainText(
              Buffer.concat(
                displayOutput.chunks.map((chunk) =>
                  Buffer.from(chunk.dataBase64, "base64"),
                ),
              ).toString("utf8"),
            ),
          );
        } else {
          writeOutputChunks(displayOutput.chunks);
        }
        if (output.status === "exited") {
          console.error(describeTerminalExit(terminalId, output.exitCode));
        }
      }),
    );

  terminal
    .command("pipe <terminalId>")
    .description("Stream terminal output until it exits or Ctrl-C")
    .option("--follow", "Continue streaming new output")
    .option("--command <command>", "Pipe output into a local command")
    .action(
      action(async (terminalId: string, opts: TerminalPipeOptions) => {
        if (!opts.follow)
          throw new CliUsageError({
            code: "missing_follow_option",
            hint: "Run `bb terminal pipe <id> --follow` to stream output.",
            message: "terminal pipe requires --follow",
          });
        const sdk = createCliBbSdk(getUrl());
        const controller = new AbortController();
        const onInterrupt = (): void => controller.abort();
        process.once("SIGINT", onInterrupt);
        const child = opts.command
          ? spawn(opts.command, {
              shell: true,
              stdio: ["pipe", "pipe", process.stderr],
            })
          : null;
        child?.stdout?.pipe(process.stdout);
        try {
          for await (const chunk of sdk.terminals.experimental_follow({
            terminalId,
            signal: controller.signal,
          })) {
            if (child?.stdin && !child.stdin.write(chunk)) {
              await once(child.stdin, "drain");
            } else if (!child) {
              process.stdout.write(chunk);
            }
          }
          child?.stdin?.end();
          if (child)
            await new Promise<void>((resolve, reject) => {
              child.once("error", reject);
              child.once("exit", (code) =>
                code === 0
                  ? resolve()
                  : reject(new Error(`Local command exited with code ${code}`)),
              );
            });
        } finally {
          process.removeListener("SIGINT", onInterrupt);
          if (child && !child.killed) child.kill();
        }
      }),
    );

  terminal
    .command("wait <terminalId>")
    .description(
      "Wait for a terminal to exit or print text, then return its output and exit code",
    )
    .option(
      "--contains <text>",
      "Return once new output contains text, ignoring terminal escapes",
    )
    .option(
      "--regex <pattern>",
      "Return once new output matches a regular expression, ignoring terminal escapes",
    )
    .option("--exit", "Wait until the terminal exits (the default)")
    .option(
      "--since-seq <n>",
      "Start from this output sequence (default: the current end for --contains or --regex, 0 otherwise)",
    )
    .option("--from-start", "Start from sequence 0")
    .option(
      "--timeout <duration>",
      `Stop waiting after ${durationHelp("s")}; the terminal keeps running`,
      "30s",
    )
    .option(
      "--poll-interval <duration>",
      `Polling interval as ${durationHelp("ms")} (default: starts at 100ms and backs off to 1s)`,
    )
    .option(
      "--max-output-bytes <n>",
      "Return at most the last N bytes of output",
      DEFAULT_TERMINAL_WAIT_MAX_OUTPUT_BYTES,
    )
    .option("--tail-bytes <n>", "Bound each output poll to N bytes")
    .option("--limit-chunks <n>", "Bound each output poll to N chunks")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalWaitOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const plan = await resolveTerminalWaitPlan({ opts, sdk, terminalId });
        reportTerminalObservation({
          json: opts.json === true,
          report: await observeTerminal({ plan, sdk, terminalId }),
        });
      }),
    );

  terminal
    .command("rename <terminalId> <title>")
    .description("Rename a terminal session")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          terminalId: string,
          title: string,
          opts: TerminalJsonOptions,
        ) => {
          const session = await createCliBbSdk(getUrl()).terminals.rename({
            terminalId,
            title,
          });
          if (outputJson(opts, session)) return;
          console.log(`Renamed terminal ${terminalId} to ${session.title}`);
        },
      ),
    );

  terminal
    .command("restart <terminalId>")
    .description("Replace a terminal with a shell in the same scope")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalJsonOptions) => {
        const session = await createCliBbSdk(getUrl()).terminals.restart({
          terminalId,
        });
        if (outputJson(opts, session)) return;
        console.log(`Restarted terminal ${terminalId} as ${session.id}`);
      }),
    );

  terminal
    .command("close <terminalId>")
    .alias("stop")
    .description("Close a terminal session")
    .option("--if-clean", "Only close if no user input was sent")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalCloseOptions) => {
        const session = await createCliBbSdk(getUrl()).terminals.close({
          terminalId,
          mode: opts.ifClean ? "if-clean" : "force",
        });
        if (outputJson(opts, session)) return;
        console.log(`Closed terminal ${terminalId}`);
      }),
    );

  for (const command of terminal.commands) {
    const targetsTerminalId = command.registeredArguments.some(
      (argument) => argument.name() === "terminalId",
    );
    if (targetsTerminalId) acceptRedundantTerminalScopeOptions(command);
  }
}

function acceptRedundantTerminalScopeOptions(command: Command): void {
  for (const flags of [
    "--thread <id>",
    "--environment <id>",
    "--machine <id-or-name>",
    "--host <id-or-name>",
  ]) {
    command.addOption(new Option(flags).hideHelp());
  }
}

function addTerminalScopeOptions(command: Command): Command {
  return command
    .option("--thread <id>", "Thread-scoped terminal")
    .option("--environment <id>", "Environment-scoped terminal")
    .option("--machine <id-or-name>", "Machine-scoped terminal")
    .option("--host <id-or-name>", "Alias for --machine")
    .option("--cwd <path>", "Working directory for --machine or --host");
}

async function resolveTerminalListScope(
  opts: TerminalScopeOptions,
  serverUrl: string,
): Promise<TerminalListScope> {
  const machine = resolveTerminalMachineSelector(opts);
  assertExactlyOneTerminalScope({
    environment: opts.environment,
    machine,
    thread: opts.thread,
  });
  if (opts.cwd !== undefined && machine === undefined) {
    throw new Error("--cwd can only be used with --machine or --host.");
  }
  if (opts.thread !== undefined) {
    return { kind: "thread", threadId: opts.thread };
  }
  if (opts.environment !== undefined) {
    return { kind: "environment", environmentId: opts.environment };
  }
  return {
    kind: "host_path",
    hostId: await resolveMachineHostId({
      serverUrl,
      target: machine ?? "",
    }),
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
  };
}

async function resolveTerminalCreateScope(
  opts: TerminalScopeOptions,
  serverUrl: string,
): Promise<TerminalCreateScope> {
  const scope = await resolveTerminalListScope(opts, serverUrl);
  if (scope.kind !== "host_path") return scope;
  return { ...scope, cwd: scope.cwd ?? null };
}

function resolveTerminalMachineSelector(
  opts: TerminalScopeOptions,
): string | undefined {
  return resolveMachineTargetOption({
    machine: opts.machine,
    host: opts.host,
  });
}

function assertExactlyOneTerminalScope(args: {
  environment?: string;
  machine?: string;
  thread?: string;
}): void {
  const count = [args.thread, args.environment, args.machine].filter(
    (value) => value !== undefined,
  ).length;
  if (count !== 1) {
    throw new CliUsageError({
      code: count === 0 ? "missing_required" : "invalid_value",
      hint: count === 0 ? terminalScopeHint() : null,
      message:
        "Provide exactly one terminal scope: --thread, --environment, or --machine/--host.",
    });
  }
}

function resolveTerminalStart(args: {
  commandOption?: string;
  commandParts: readonly string[];
}): TerminalStartResolution {
  if (args.commandOption !== undefined && args.commandParts.length > 0) {
    throw new Error(
      "Provide either --command or positional command args, not both",
    );
  }
  if (args.commandOption !== undefined) {
    const command = args.commandOption.trim();
    if (command.length === 0) {
      throw new Error("--command must not be empty");
    }
    return { mode: "command", command };
  }
  if (args.commandParts.length > 0) {
    return { mode: "argv", argv: [...args.commandParts] };
  }
  return { mode: "shell" };
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  return parseRequiredPositiveInteger(value, label);
}

function parseRequiredPositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export async function resolveSendData(
  opts: TerminalSendOptions,
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<Buffer> {
  if (opts.text !== undefined && opts.stdin) {
    throw new Error("Provide only one of --text or --stdin");
  }
  if (opts.text === undefined && !opts.stdin) {
    throw new Error("Provide one of --text or --stdin");
  }
  const baseData =
    opts.text !== undefined
      ? Buffer.from(opts.text, "utf8")
      : await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
          stdin.on("error", reject);
          stdin.on("end", () => resolve(Buffer.concat(chunks)));
        });
  return opts.enter
    ? Buffer.concat([baseData, Buffer.from("\r", "utf8")])
    : baseData;
}

function terminalOutputQuery(opts: TerminalOutputOptions) {
  return {
    ...(opts.lines !== undefined
      ? { lines: parseRequiredPositiveInteger(opts.lines, "--lines") }
      : {}),
    ...(opts.sinceSeq !== undefined
      ? { sinceSeq: parseNonNegativeInteger(opts.sinceSeq, "--since-seq") }
      : {}),
    ...terminalOutputBounds(opts),
  };
}

function terminalOutputBounds(
  opts: Pick<TerminalOutputOptions, "limitChunks" | "tailBytes">,
) {
  return {
    ...(opts.tailBytes !== undefined
      ? {
          tailBytes: parseRequiredPositiveInteger(
            opts.tailBytes,
            "--tail-bytes",
          ),
        }
      : {}),
    ...(opts.limitChunks !== undefined
      ? {
          limitChunks: parseRequiredPositiveInteger(
            opts.limitChunks,
            "--limit-chunks",
          ),
        }
      : {}),
  };
}

function parseNonNegativeInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function printTerminalTable(sessions: TerminalSession[]): void {
  if (sessions.length === 0) {
    console.log("No terminal sessions found");
    return;
  }
  const rows = sessions.map((session) => [
    session.id,
    session.title,
    session.status,
    `${session.cols}x${session.rows}`,
  ]);
  printBorderlessTable(
    {
      head: ["ID", "Title", "Status", "Size"],
      colWidths: columnWidths(rows, [12, 24, 14, 10]),
    },
    rows,
  );
}

function writeOutputChunks(
  chunks: readonly { dataBase64: string; seq: number }[],
): void {
  const scanner = createTerminalGridByteMarkerScanner();
  for (const chunk of chunks) {
    const result = scanner.push(Buffer.from(chunk.dataBase64, "base64"));
    process.stdout.write(Buffer.from(result.bytes));
  }
  process.stdout.write(Buffer.from(scanner.flush()));
}

function stripTerminalGridMarkersFromOutput<
  T extends {
    chunks: readonly { dataBase64: string; seq: number }[];
  },
>(output: T): T {
  const scanner = createTerminalGridByteMarkerScanner();
  const chunks = output.chunks.map((chunk) => ({
    ...chunk,
    dataBase64: Buffer.from(
      scanner.push(Buffer.from(chunk.dataBase64, "base64")).bytes,
    ).toString("base64"),
  }));
  const trailing = scanner.flush();
  if (trailing.byteLength > 0 && chunks.length > 0) {
    const last = chunks.at(-1);
    if (last) {
      chunks[chunks.length - 1] = {
        ...last,
        dataBase64: Buffer.concat([
          Buffer.from(last.dataBase64, "base64"),
          Buffer.from(trailing),
        ]).toString("base64"),
      };
    }
  }
  return { ...output, chunks };
}

function terminalWebsocketUrl(args: {
  baseUrl: string;
  terminalId: string;
}): string {
  const url = new URL(args.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/ws/terminals/${encodeURIComponent(
    args.terminalId,
  )}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

export async function attachTerminal(args: {
  baseUrl: string;
  terminalId: string;
}): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Attach requires an interactive terminal");
  }

  const previousRawMode = process.stdin.isRaw;
  let cleanup = () => {};
  await new Promise<void>((resolve, reject) => {
    const transport = new TerminalWebSocketTransport({
      url: terminalWebsocketUrl(args),
      terminalId: args.terminalId,
      createSocket: (url, protocols) => {
        let socket: WebSocket;
        try {
          socket = new WebSocket(url, protocols);
        } catch (error) {
          reject(error);
          throw error;
        }
        socket.addEventListener("open", () => {
          process.stdin.setRawMode(true);
          process.stdin.resume();
        });
        socket.addEventListener("error", () =>
          reject(new Error("Terminal websocket failed")),
        );
        return socket;
      },
      shouldReconnect: () => false,
      onInputOverflow: () => reject(new Error("Terminal input queue is full")),
      onConnectionState: (state) => {
        if (state === "closed") resolve();
      },
      onMessage: (message) => {
        switch (message.type) {
          case "output":
            process.stdout.write(
              Buffer.from(message.chunk.dataBase64, "base64"),
            );
            transport.acknowledgeOutput(message.chunk.seq + 1);
            return;
          case "exited":
            transport.dispose();
            return;
          case "error":
            reject(new Error(message.message));
            return;
        }
      },
    });
    let detachPrefix = false;
    const onInput = (chunk: Buffer) => {
      if (chunk.length === 1 && chunk[0] === 0x02) {
        detachPrefix = true;
        return;
      }
      if (detachPrefix) {
        detachPrefix = false;
        if (chunk.length === 1 && chunk[0] === 0x64) {
          transport.dispose();
          return;
        }
        sendTerminalInput(transport, Buffer.from([0x02]));
      }
      sendTerminalInput(transport, chunk);
    };
    const onResize = () => {
      transport.sendResize(
        process.stdout.columns || DEFAULT_COLS,
        process.stdout.rows || DEFAULT_ROWS,
      );
      transport.claimSize();
    };
    cleanup = () => {
      transport.dispose();
      process.stdin.off("data", onInput);
      process.stdout.off("resize", onResize);
      process.stdin.setRawMode(previousRawMode);
      process.stdin.pause();
    };
    process.stdin.on("data", onInput);
    process.stdout.on("resize", onResize);
    transport.setVisible(true);
    onResize();
    transport.markLayoutSettled();
    transport.start();
  }).finally(() => cleanup());
}

function chunkTerminalInput(data: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (
    let offset = 0;
    offset < data.byteLength;
    offset += TERMINAL_DATA_MAX_BYTES
  ) {
    chunks.push(
      data.subarray(
        offset,
        Math.min(offset + TERMINAL_DATA_MAX_BYTES, data.byteLength),
      ),
    );
  }
  return chunks;
}

function sendTerminalInput(
  transport: TerminalWebSocketTransport,
  data: Buffer,
) {
  transport.claimSize(true);
  for (const chunk of chunkTerminalInput(data)) {
    if (!transport.sendInput(chunk.toString("base64"))) return;
  }
}

function parseTimeout(value: string): number {
  return parseDurationMs({
    allowZero: false,
    defaultUnit: "s",
    label: "--timeout",
    value,
  });
}

async function createRunTerminal(args: {
  argv: string[];
  cols: number;
  id: string | undefined;
  rows: number;
  scope: TerminalCreateScope;
  sdk: BbSdk;
  title: string | undefined;
}): Promise<TerminalSession> {
  try {
    return await args.sdk.terminals.create({
      cols: args.cols,
      id: args.id,
      rows: args.rows,
      scope: args.scope,
      start: { mode: "argv", argv: args.argv },
      title: args.title,
    });
  } catch (error) {
    if (
      args.id !== undefined &&
      error instanceof BbHttpError &&
      error.code === "terminal_id_conflict"
    ) {
      throw new CliExitError(
        `Terminal ${args.id} already exists, so the command was not run again.`,
        1,
        {
          code: "terminal_id_conflict",
          hint: `Observe the earlier run with \`bb terminal wait ${args.id}\`.`,
        },
      );
    }
    throw error;
  }
}

async function resolveTerminalWaitPlan(args: {
  opts: TerminalWaitOptions;
  sdk: BbSdk;
  terminalId: string;
}): Promise<TerminalObservePlan> {
  const { opts } = args;
  const condition = parseTerminalOutputCondition(opts);
  if (opts.exit === true && condition !== null) {
    throw new CliUsageError({
      code: "invalid_value",
      hint: `For example: bb terminal wait ${args.terminalId}, or --contains "ready".`,
      message: "Provide only one of --contains, --regex, or --exit",
    });
  }
  if (opts.sinceSeq !== undefined && opts.fromStart === true) {
    throw new CliUsageError({
      code: "invalid_value",
      hint: null,
      message: "Provide only one of --since-seq or --from-start",
    });
  }
  const plan = {
    condition,
    maxOutputBytes: parseMaxOutputBytes(opts.maxOutputBytes),
    outputBounds: terminalOutputBounds(opts),
    pollDelaysMs:
      opts.pollInterval === undefined
        ? WAIT_POLL_DELAYS_MS
        : ([
            parseDurationMs({
              allowZero: false,
              defaultUnit: "ms",
              label: "--poll-interval",
              value: opts.pollInterval,
            }),
          ] as const),
    timeoutMs: parseTimeout(opts.timeout),
  };
  if (opts.sinceSeq !== undefined) {
    return {
      ...plan,
      sinceSeq: parseNonNegativeInteger(opts.sinceSeq, "--since-seq"),
    };
  }
  if (condition === null || opts.fromStart === true) {
    return { ...plan, sinceSeq: 0 };
  }
  const currentOutput = await args.sdk.terminals.output({
    terminalId: args.terminalId,
    limitChunks: 1,
    tailBytes: 1,
  });
  if (currentOutput.status === "exited") {
    throw new CliExitError(
      `${describeTerminalExit(args.terminalId, currentOutput.exitCode)} before this wait started, so no new output will arrive.`,
      1,
      {
        code: "terminal_exited",
        hint: `Match its existing output with --from-start, or read it with \`bb terminal output ${args.terminalId}\`.`,
      },
    );
  }
  return { ...plan, sinceSeq: currentOutput.nextSeq };
}
