import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Command, Option } from "commander";
import {
  createTerminalGridByteMarkerScanner,
  TERMINAL_DATA_MAX_BYTES,
} from "@bb/domain";
import type { TerminalCreateScope, TerminalListScope } from "@bb/sdk";
import { createNodeWebsocketFactory } from "@bb/sdk/node-websocket";
import {
  terminalServerMessageSchema,
  type TerminalSession,
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
import { columnWidths, printBorderlessTable } from "../table.js";
import { outputJson } from "./helpers.js";
import { resolveMachineHostId, resolveMachineTargetOption } from "./machine.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const TERMINAL_ATTACH_HEARTBEAT_MS = 15_000;
const TERMINAL_WAIT_TIMEOUT_EXIT_CODE = 124;

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
  rows?: string;
  title?: string;
  workingDirectory?: string;
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
  pollInterval?: string;
  regex?: string;
  timeout?: string;
}

interface TerminalCloseOptions extends TerminalJsonOptions {
  ifClean?: boolean;
}

interface TerminalNotifyOptions {
  body: string;
  title: string;
}

interface TerminalAttentionOptions extends TerminalJsonOptions {}

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
      action(async (terminalId: string, shell: string, shellArgsBase64: string) => {
        const baseUrl = getUrl();
        const socketPath = defaultNativeHolderSocketPath(baseUrl, terminalId);
        const script = process.argv[1];
        if (script === undefined) throw new CliExitError("Cannot locate the bb CLI", 1);
        const session = await createCliBbSdk(baseUrl).terminals.get({ terminalId });
        const connection = await openNativeHolderConnection({
          socketPath,
          reattachOnly:
            session.status === "exited" ||
            process.env.BB_TERMINAL_HOLDER_REATTACH_ONLY === "1",
          startTimeoutMs: 20_000,
          startHolder: () => {
            const holder = spawn(
              process.execPath,
              [...process.execArgv, script, "terminal", "holder-shell", terminalId, shell, shellArgsBase64],
              { cwd: process.cwd(), detached: true, env: process.env, stdio: "ignore" },
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
      }),
    );

  terminal
    .command("holder-shell <terminalId> <shell> <shellArgsBase64>", { hidden: true })
    .action(
      action(async (terminalId: string, shell: string, shellArgsBase64: string) => {
        const socketPath = defaultNativeHolderSocketPath(getUrl(), terminalId);
        ignoreNativeHolderSignals(process, socketPath);
        delete process.env.BB_TERMINAL_HOLDER_REATTACH_ONLY;
        const shellArgs: unknown = JSON.parse(
          Buffer.from(shellArgsBase64, "base64").toString("utf8"),
        );
        if (!Array.isArray(shellArgs) || !shellArgs.every((arg) => typeof arg === "string")) {
          throw new CliExitError("Invalid shell arguments", 1);
        }
        const nodePty = await import("node-pty");
        const sdk = createCliBbSdk(getUrl());
        const exitCode = await runNativeHolder({
          socketPath,
          cwd: process.cwd(),
          env: process.env,
          prepare: async () => ({ command: shell, args: shellArgs }),
          spawnPty: (child, options) => nodePty.spawn(child.command, child.args, {
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
              if (error instanceof Error && "status" in error && error.status === 404) {
                return "closed-for-good";
              }
              throw error;
            }
          },
        });
        process.exitCode = exitCode;
      }),
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
        "--command <command>",
        "Command to run instead of an interactive shell",
      )
      .option("--cols <n>", "Initial terminal columns")
      .option("--rows <n>", "Initial terminal rows")
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
    .option("--lines <n>", "Print the latest N lines")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalOutputOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const output = await sdk.terminals.output({
          terminalId,
          ...terminalOutputQuery(opts),
        });
        const displayOutput = stripTerminalGridMarkersFromOutput(output);
        if (outputJson(opts, displayOutput)) return;
        writeOutputChunks(displayOutput.chunks);
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
    .description("Wait for terminal output or exit")
    .option("--contains <text>", "Wait until output contains text")
    .option(
      "--regex <pattern>",
      "Wait until output matches a regular expression",
    )
    .option("--exit", "Wait until the terminal exits")
    .option("--from-start", "Include existing scrollback from sequence 0")
    .option("--timeout <duration>", `Timeout as ${durationHelp("s")}`, "30s")
    .option(
      "--poll-interval <duration>",
      `Polling interval as ${durationHelp("ms")}`,
      "500ms",
    )
    .option("--tail-bytes <n>", "Bound each output poll to N bytes")
    .option("--limit-chunks <n>", "Bound each output poll to N chunks")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalWaitOptions) => {
        const result = await waitForTerminal({
          baseUrl: getUrl(),
          opts,
          terminalId,
        });
        if (outputJson(opts, result)) return;
        console.log(
          result.matched === "exit"
            ? describeTerminalExit(terminalId, result.exitCode)
            : `Terminal ${terminalId} matched ${result.matched}`,
        );
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

  const socket = createNodeWebsocketFactory()(
    terminalWebsocketUrl({
      baseUrl: args.baseUrl,
      terminalId: args.terminalId,
    }),
  );
  let detachPrefix = false;
  const previousRawMode = process.stdin.isRaw;
  const onInput = (chunk: Buffer) => {
    if (chunk.length === 1 && chunk[0] === 0x02) {
      detachPrefix = true;
      return;
    }
    if (detachPrefix) {
      detachPrefix = false;
      if (chunk.length === 1 && chunk[0] === 0x64) {
        socket.close();
        return;
      }
      sendTerminalInput(socket, Buffer.from([0x02]));
    }
    sendTerminalInput(socket, chunk);
  };
  const onResize = () => {
    socket.send(
      JSON.stringify({
        type: "resize",
        cols: process.stdout.columns || DEFAULT_COLS,
        rows: process.stdout.rows || DEFAULT_ROWS,
      }),
    );
  };
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      socket.send(JSON.stringify({ type: "visibility", visible: true }));
      onResize();
      heartbeat = setInterval(() => {
        socket.send(JSON.stringify({ type: "ping" }));
      }, TERMINAL_ATTACH_HEARTBEAT_MS);
    };
    socket.onerror = () => reject(new Error("Terminal websocket failed"));
    socket.onclose = () => resolve();
    socket.onmessage = (event) => {
      const message = terminalServerMessageSchema.parse(
        JSON.parse(String(event.data)),
      );
      switch (message.type) {
        case "attached":
        case "pong":
        case "session-updated":
          return;
        case "output":
          process.stdout.write(Buffer.from(message.chunk.dataBase64, "base64"));
          return;
        case "exited":
          socket.close();
          return;
        case "error":
          reject(new Error(message.message));
          return;
      }
    };
    process.stdin.on("data", onInput);
    process.stdout.on("resize", onResize);
  }).finally(() => {
    if (heartbeat !== null) clearInterval(heartbeat);
    process.stdin.off("data", onInput);
    process.stdout.off("resize", onResize);
    process.stdin.setRawMode(previousRawMode);
    process.stdin.pause();
  });
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

function sendTerminalInput(socket: { send(data: string): void }, data: Buffer) {
  for (const chunk of chunkTerminalInput(data)) {
    socket.send(
      JSON.stringify({
        type: "input",
        dataBase64: chunk.toString("base64"),
      }),
    );
  }
}

const TERMINAL_WAIT_MATCH_WINDOW_CHARS = 256 * 1024;
const TERMINAL_WAIT_EXIT_TAIL_CHARS = 2000;

interface TerminalWaitResult {
  exitCode: number | null;
  matched: string;
  nextSeq: number;
  terminalId: string;
}

function describeTerminalExit(
  terminalId: string,
  exitCode: number | null,
): string {
  return exitCode === null
    ? `Terminal ${terminalId} exited`
    : `Terminal ${terminalId} exited with code ${exitCode}`;
}

function decodeChunks(chunks: readonly { dataBase64: string }[]): string {
  const scanner = createTerminalGridByteMarkerScanner();
  const parts = chunks.map((chunk) =>
    Buffer.from(scanner.push(Buffer.from(chunk.dataBase64, "base64")).bytes),
  );
  parts.push(Buffer.from(scanner.flush()));
  return Buffer.concat(parts).toString("utf8");
}

async function waitForTerminal(args: {
  baseUrl: string;
  opts: TerminalWaitOptions;
  terminalId: string;
}): Promise<TerminalWaitResult> {
  const hasContains = args.opts.contains !== undefined;
  const hasRegex = args.opts.regex !== undefined;
  const hasExit = args.opts.exit === true;
  if ([hasContains, hasRegex, hasExit].filter(Boolean).length !== 1) {
    throw new CliUsageError({
      code: "missing_required",
      hint: `For example: bb terminal wait ${args.terminalId} --exit, or --contains "ready".`,
      message: "Provide exactly one of --contains, --regex, or --exit",
    });
  }
  const sdk = createCliBbSdk(args.baseUrl);
  const timeoutMs = parseDurationMs({
    allowZero: false,
    defaultUnit: "s",
    label: "--timeout",
    value: args.opts.timeout ?? "30s",
  });
  const pollIntervalMs = parseDurationMs({
    allowZero: false,
    defaultUnit: "ms",
    label: "--poll-interval",
    value: args.opts.pollInterval ?? "500ms",
  });
  const deadline = Date.now() + timeoutMs;
  let nextSeq = args.opts.fromStart ? 0 : undefined;
  const regex =
    args.opts.regex === undefined ? null : new RegExp(args.opts.regex, "u");

  if (!hasExit && nextSeq === undefined) {
    const currentOutput = await sdk.terminals.output({
      terminalId: args.terminalId,
      limitChunks: 1,
      tailBytes: 1,
    });
    if (currentOutput.status === "exited") {
      throw new CliExitError(
        `${describeTerminalExit(args.terminalId, currentOutput.exitCode)} before this wait started, so no new output will arrive.`,
        TERMINAL_WAIT_TIMEOUT_EXIT_CODE,
        {
          code: "terminal_exited",
          hint: `Match its existing output with --from-start, or read it with \`bb terminal output ${args.terminalId}\`.`,
        },
      );
    }
    nextSeq = currentOutput.nextSeq;
  }

  let seen = "";
  while (Date.now() <= deadline) {
    if (hasExit) {
      const session = await sdk.terminals.get({ terminalId: args.terminalId });
      if (session.status === "exited") {
        return {
          exitCode: session.exitCode,
          matched: "exit",
          nextSeq: nextSeq ?? 0,
          terminalId: args.terminalId,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      continue;
    }

    const output = await sdk.terminals.output({
      terminalId: args.terminalId,
      ...terminalOutputQuery(args.opts),
      ...(nextSeq !== undefined ? { sinceSeq: nextSeq } : {}),
    });
    nextSeq = output.nextSeq;
    const searched = `${seen}${decodeChunks(output.chunks)}`;
    seen = searched.slice(-TERMINAL_WAIT_MATCH_WINDOW_CHARS);
    if (
      args.opts.contains !== undefined &&
      searched.includes(args.opts.contains)
    ) {
      return {
        exitCode: output.exitCode,
        matched: args.opts.contains,
        nextSeq,
        terminalId: args.terminalId,
      };
    }
    if (regex && regex.test(searched)) {
      return {
        exitCode: output.exitCode,
        matched: args.opts.regex ?? "",
        nextSeq,
        terminalId: args.terminalId,
      };
    }
    if (output.status === "exited") {
      const tail = seen.slice(-TERMINAL_WAIT_EXIT_TAIL_CHARS).trimEnd();
      throw new CliExitError(
        `${describeTerminalExit(args.terminalId, output.exitCode)} before the requested output matched`,
        TERMINAL_WAIT_TIMEOUT_EXIT_CODE,
        {
          code: "terminal_exited",
          hint:
            tail.length === 0
              ? `It printed nothing after this wait started. Read everything with \`bb terminal output ${args.terminalId}\`.`
              : `Last output:\n${tail}`,
        },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new CliExitError(
    `Timed out waiting for terminal ${args.terminalId}`,
    TERMINAL_WAIT_TIMEOUT_EXIT_CODE,
    {
      code: "timeout",
      hint: `Read what it has printed so far with \`bb terminal output ${args.terminalId} --tail-bytes 4000\`.`,
    },
  );
}
