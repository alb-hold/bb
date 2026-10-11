import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { BbHttpError } from "@bb/sdk";
import type { NativeTerminalThread } from "@bb/server-contract";
import { action, CliExitError } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { requireThreadIdOrSelf } from "../../context-env.js";
import {
  findNativeSession,
  resolveNativeHarnessLaunch,
} from "../../native-harness.js";
import {
  defaultNativeHolderSocketPath,
  nativeTerminalClosedForGood,
  openNativeHolderConnection,
  pipeNativeHolderClient,
  runNativeHolder,
} from "../../native-holder.js";
import { outputJson } from "../helpers.js";
import { attachTerminal } from "../terminal.js";

const SESSION_DISCOVERY_INTERVAL_MS = 2_000;
const HOLDER_START_TIMEOUT_MS = 20_000;
const DETACHING_SIGNALS = ["SIGTERM", "SIGHUP"] as const;
const SWALLOWED_SIGNALS = ["SIGINT", "SIGQUIT"] as const;

interface NativeOpenOptions {
  attach?: boolean;
  json?: boolean;
  self?: boolean;
}

interface NativeRunOptions {
  json?: boolean;
  probe?: boolean;
}

interface NativeHoldOptions {
  json?: boolean;
  socket: string;
}

function describeNativeThread(view: NativeTerminalThread): string {
  const terminal =
    view.terminal === null
      ? "no terminal"
      : `terminal ${view.terminal.id} (${view.terminal.status})`;
  const session = view.nativeSessionId ?? "not yet known";
  return `${view.displayName} session ${session}, ${terminal}`;
}

function nativeHolderLogPath(socketPath: string): string {
  return socketPath.replace(/\.sock$/u, ".log");
}

function removeEmptyNativeHolderLog(socketPath: string): void {
  const logPath = nativeHolderLogPath(socketPath);
  try {
    if (statSync(logPath).size === 0) unlinkSync(logPath);
  } catch {
    return;
  }
}

function spawnNativeHolder(threadId: string, socketPath: string): void {
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const log = openSync(nativeHolderLogPath(socketPath), "a", 0o600);
  try {
    const script = process.argv[1];
    if (script === undefined) {
      throw new CliExitError(
        "Cannot locate the bb CLI to start the native terminal holder",
        1,
      );
    }
    const holder = spawn(
      process.execPath,
      [
        ...process.execArgv,
        script,
        "thread",
        "native-hold",
        threadId,
        "--socket",
        socketPath,
      ],
      {
        cwd: process.cwd(),
        detached: true,
        env: process.env,
        stdio: ["ignore", "ignore", log],
      },
    );
    holder.unref();
  } finally {
    closeSync(log);
  }
}

async function runNativeHarness(
  baseUrl: string,
  threadId: string,
): Promise<number> {
  const socketPath = defaultNativeHolderSocketPath(baseUrl, threadId);
  const connection = await openNativeHolderConnection({
    socketPath,
    reattachOnly: process.env.BB_NATIVE_TERMINAL_REATTACH === "1",
    startHolder: () => spawnNativeHolder(threadId, socketPath),
    startTimeoutMs: HOLDER_START_TIMEOUT_MS,
  });
  if (connection.kind === "ended") {
    process.stdout.write(
      "This thread's CLI ended while bb was disconnected from this machine. Open the terminal again to resume the session.\r\n",
    );
    return 0;
  }
  if (connection.kind === "did-not-start") {
    throw new CliExitError(
      `The native terminal holder did not start; see ${nativeHolderLogPath(socketPath)}`,
      1,
    );
  }
  const attached = connection.socket;
  for (const signal of SWALLOWED_SIGNALS) process.on(signal, () => {});
  for (const signal of DETACHING_SIGNALS) {
    process.on(signal, () => {
      attached.destroy();
    });
  }
  return await pipeNativeHolderClient(attached, {
    input: process.stdin,
    output: process.stdout,
    fallbackSize: { cols: 120, rows: 40 },
  });
}

async function holdNativeHarness(
  baseUrl: string,
  threadId: string,
  socketPath: string,
): Promise<number> {
  for (const signal of ["SIGHUP", "SIGINT", "SIGQUIT"] as const) {
    process.on(signal, () => {});
  }
  const sdk = createCliBbSdk(baseUrl);
  const nodePty = await import("node-pty");
  const cwd = process.cwd();
  let discovery: {
    cli: Parameters<typeof findNativeSession>[0]["cli"];
    launchedAtMs: number;
  } | null = null;
  let recorded = true;
  const discover = async (): Promise<void> => {
    if (recorded || discovery === null) return;
    let match: ReturnType<typeof findNativeSession>;
    try {
      match = findNativeSession({
        cli: discovery.cli,
        cwd,
        env: process.env,
        launchedAtMs: discovery.launchedAtMs,
        nowMs: Date.now(),
      });
    } catch {
      return;
    }
    if (match.kind !== "unique") return;
    recorded = true;
    try {
      await sdk.nativeTerminals.recordSession({
        threadId,
        nativeSessionId: match.sessionId,
      });
    } catch {
      recorded = false;
    }
  };
  let pty: ReturnType<typeof nodePty.spawn> | null = null;
  process.on("SIGTERM", () => {
    pty?.kill("SIGHUP");
  });
  const exitCode = await runNativeHolder({
    socketPath,
    cwd,
    env: process.env,
    prepare: async () => {
      const spec = await sdk.nativeTerminals.launch({ threadId });
      const launch = resolveNativeHarnessLaunch(spec, process.env);
      discovery = { cli: spec.cli, launchedAtMs: Date.now() };
      recorded = !launch.discoverSession;
      return { command: launch.command, args: launch.args };
    },
    spawnPty: (child, options) => {
      pty = nodePty.spawn(child.command, child.args, {
        name: process.env.TERM ?? "xterm-256color",
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env,
      });
      return pty;
    },
    tick: discover,
    tickIntervalMs: SESSION_DISCOVERY_INTERVAL_MS,
    terminalClosedForGood: async () => {
      try {
        return nativeTerminalClosedForGood(
          await sdk.nativeTerminals.get({ threadId }),
        );
      } catch (error) {
        return error instanceof BbHttpError && error.status === 404;
      }
    },
  });
  await discover();
  return exitCode;
}

export function registerNativeCommands(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("native [threadId]")
    .description(
      "Open the native terminal of a thread created with `bb thread spawn --native`, resuming its native CLI session when it has exited",
    )
    .option("--self", "Target the current thread (BB_THREAD_ID)")
    .option("--attach", "Attach this terminal to the native session")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (threadIdArg: string | undefined, opts: NativeOpenOptions) => {
          const threadId = requireThreadIdOrSelf(threadIdArg, {
            self: opts.self === true,
          });
          const columns = process.stdout.columns;
          const rows = process.stdout.rows;
          const view = await createCliBbSdk(getUrl()).nativeTerminals.open({
            threadId,
            ...(columns ? { cols: columns } : {}),
            ...(rows ? { rows } : {}),
          });
          if (outputJson(opts, view)) return;
          if (opts.attach) {
            if (view.terminal === null) {
              throw new CliExitError("The native terminal did not open", 1);
            }
            await attachTerminal({
              baseUrl: getUrl(),
              terminalId: view.terminal.id,
            });
            return;
          }
          console.log(describeNativeThread(view));
        },
      ),
    );

  parent
    .command("native-run <threadId>", { hidden: true })
    .description(
      "Run a native thread's provider CLI in this terminal (bb launches this inside the thread's terminal)",
    )
    .option("--probe", "Exit successfully without running anything")
    .option("--json", "Print the probe result as JSON")
    .action(
      action(async (threadId: string, opts: NativeRunOptions) => {
        if (opts.probe) {
          if (opts.json) console.log(JSON.stringify({ supported: true }));
          return;
        }
        process.exitCode = await runNativeHarness(getUrl(), threadId);
      }),
    );

  parent
    .command("native-hold <threadId>", { hidden: true })
    .description(
      "Hold a native thread's provider CLI in a detached terminal that outlives the bb terminal and host daemon (native-run starts this)",
    )
    .requiredOption(
      "--socket <path>",
      "Unix socket the native terminal attaches through",
    )
    .option("--json", "Print the provider CLI's exit code as JSON when it ends")
    .action(
      action(async (threadId: string, opts: NativeHoldOptions) => {
        const exitCode = await holdNativeHarness(
          getUrl(),
          threadId,
          opts.socket,
        );
        removeEmptyNativeHolderLog(opts.socket);
        if (opts.json) console.log(JSON.stringify({ exitCode }));
        process.exitCode = exitCode;
      }),
    );
}
