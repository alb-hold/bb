import { spawn } from "node:child_process";
import { mkdirSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import type { NativeTerminalThread } from "@bb/server-contract";
import { action, CliExitError } from "../../action.js";
import { cliFetch, createCliBbSdk } from "../../client.js";
import { createNodeBbSdk } from "@bb/sdk/node";
import {
  takeNativeToolCredentialFromEnv,
  withSocketCredential,
} from "../../native-tool-credential.js";
import { requireThreadIdOrSelf } from "../../context-env.js";
import { fillNativeTerminalTemplate } from "@bb/domain";
import { createSessionDiscoverer } from "../../native-session-discovery.js";
import {
  createNativeActivityPump,
  createNativeActivityWiring,
} from "../../native-activity-wiring.js";
import { createNativeActivityReporter } from "../../native-activity-reporter.js";
import { createNativeSessionStartedReporter } from "../../native-session-started.js";
import {
  prepareNativeSettings,
  removePinnedNativeSettings,
} from "../../native-settings-pin.js";
import {
  hookSpoolCandidates,
  openHookCapture,
  removeHookSpool,
  type HookCapture,
} from "../../native-hook-spool.js";
import {
  measureResumedTranscript,
  NativeActivityReader,
} from "../../native-activity-reader.js";
import {
  findNativeSession,
  nativeMcpArgs,
  resolveNativeHarnessLaunch,
} from "../../native-harness.js";
import {
  defaultNativeHolderSocketPath,
  formatNativeHolderBootProgress,
  nativeHolderProcessIsAlive,
  writeNativeHolderPidMarker,
  type NativeHolderWaitProgress,
  openNativeHolderConnection,
  ignoreNativeHolderSignals,
  logNativeHolderEvent,
  pipeNativeHolderClient,
  runNativeHolder,
} from "../../native-holder.js";
import { runNativeMcpServer } from "../../native-mcp.js";
import { checkNativeTerminal } from "../../native-terminal-check.js";
import {
  defaultNativeHolderAppDeps,
  loadNativeHolderEnvironment,
  startNativeHolderAsApp,
  type NativeHolderAppDeps,
} from "../../native-holder-app.js";
import { outputJson } from "../helpers.js";
import { attachTerminal } from "../terminal.js";

const SESSION_DISCOVERY_INTERVAL_MS = 2_000;
const ACTIVITY_POLL_INTERVAL_MS = 750;
const ACTIVITY_HEARTBEAT_INTERVAL_MS = 30_000;
const ACTIVITY_FLUSH_TIMEOUT_MS = 3_000;
const HOLDER_START_TIMEOUT_MS = 20_000;
const DETACHING_SIGNALS = ["SIGTERM", "SIGHUP"] as const;
const SWALLOWED_SIGNALS = ["SIGINT", "SIGQUIT"] as const;

interface NativeOpenOptions {
  attach?: boolean;
  chat?: boolean;
  convert?: boolean;
  json?: boolean;
  self?: boolean;
}

interface NativeRunOptions {
  json?: boolean;
  probe?: boolean;
  reattach?: boolean;
}

interface NativeHoldOptions {
  json?: boolean;
  markerGeneration?: string;
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

function nativeHolderArgv(
  threadId: string,
  socketPath: string,
  markerGeneration?: number,
): string[] {
  const script = process.argv[1];
  if (script === undefined) {
    throw new CliExitError(
      "Cannot locate the bb CLI to start the native terminal holder",
      1,
    );
  }
  return [
    process.execPath,
    ...process.execArgv,
    script,
    "thread",
    "native-hold",
    threadId,
    "--socket",
    socketPath,
    ...(markerGeneration !== undefined
      ? ["--marker-generation", String(markerGeneration)]
      : []),
  ];
}

function spawnDetachedNativeHolder(argv: string[]): void {
  spawn(process.execPath, argv.slice(1), {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: ["ignore", "ignore", "ignore"],
  }).unref();
}

function warnNativeHolderUnprotected(
  socketPath: string,
  reason: string,
  errorName: string | null,
): void {
  logNativeHolderEvent(socketPath, "holder-app-fallback", {
    reason,
    name: errorName,
  });
  process.stderr.write(
    `native holder started without swap protection (${reason}); a bb restart will end this session\n`,
  );
}

export function spawnNativeHolder(
  threadId: string,
  socketPath: string,
  app: NativeHolderAppDeps = defaultNativeHolderAppDeps(),
  markerGeneration?: number,
): string | null {
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const argv = nativeHolderArgv(threadId, socketPath, markerGeneration);
  const started = startNativeHolderAsApp(
    { argv, cwd: process.cwd(), environment: process.env, socketPath },
    app,
  );
  if (started.ok) return started.environmentFile;
  if (started.reason !== "not-darwin") {
    warnNativeHolderUnprotected(socketPath, started.reason, started.errorName);
  }
  spawnDetachedNativeHolder(argv);
  return null;
}

export function startNativeHolderFallback(
  threadId: string,
  socketPath: string,
  appEnvironmentFile: string,
  markerGeneration?: number,
): void {
  try {
    unlinkSync(appEnvironmentFile);
  } catch {}
  warnNativeHolderUnprotected(socketPath, "app-not-ready", null);
  spawnDetachedNativeHolder(
    nativeHolderArgv(threadId, socketPath, markerGeneration),
  );
}

function nativeBootProgressWriter(output: NodeJS.WriteStream): {
  onWaiting: (progress: NativeHolderWaitProgress) => void;
  clear: () => void;
} {
  let lastSecond = -1;
  let wrote = false;
  return {
    onWaiting: (progress) => {
      if (output.isTTY !== true) return;
      const second = Math.floor(progress.elapsedMs / 1_000);
      if (second === lastSecond) return;
      lastSecond = second;
      wrote = true;
      output.write(`\r\x1b[2K${formatNativeHolderBootProgress(progress)}`);
    },
    clear: () => {
      if (wrote) output.write("\r\x1b[2K");
    },
  };
}

async function runNativeHarness(
  baseUrl: string,
  threadId: string,
  reattachOnly: boolean,
): Promise<number> {
  const socketPath = defaultNativeHolderSocketPath(baseUrl, threadId);
  const credential = takeNativeToolCredentialFromEnv(process.env);
  let appEnvironmentFile: string | null = null;
  const progress = nativeBootProgressWriter(process.stdout);
  const connection = await openNativeHolderConnection({
    socketPath,
    reattachOnly,
    startHolder: (markerGeneration) => {
      appEnvironmentFile = spawnNativeHolder(
        threadId,
        socketPath,
        defaultNativeHolderAppDeps(),
        markerGeneration,
      );
    },
    startFallbackHolder: (markerGeneration) => {
      if (appEnvironmentFile === null) return;
      startNativeHolderFallback(
        threadId,
        socketPath,
        appEnvironmentFile,
        markerGeneration,
      );
    },
    holderHasStarted: () => nativeHolderProcessIsAlive(socketPath),
    onWaiting: progress.onWaiting,
    startTimeoutMs: HOLDER_START_TIMEOUT_MS,
  });
  progress.clear();
  if (connection.kind === "ended") {
    process.stdout.write(
      "The CLI for this thread ended while bb was disconnected from this machine. Open the terminal again to resume the session.\r\n",
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
    credential,
  });
}

interface NativeMcpOptions {
  credentialSocket: string;
  serverUrl?: string;
}

export interface HoldNativeHarnessOptions {
  activityPollIntervalMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  markerGeneration?: number;
  tmpDir?: string;
}

export async function holdNativeHarness(
  baseUrl: string,
  threadId: string,
  socketPath: string,
  options: HoldNativeHarnessOptions = {},
): Promise<number> {
  const holderMarkerGeneration = writeNativeHolderPidMarker(
    socketPath,
    process.pid,
    options.markerGeneration,
  );
  if (options.env === undefined) {
    try {
      loadNativeHolderEnvironment(process.env);
    } catch (error) {
      logNativeHolderEvent(socketPath, "environment-file-failed", {
        name: error instanceof Error ? error.name : "unknown",
      });
      return 1;
    }
  }
  let ownsSocket = false;
  const restoreSignals = ignoreNativeHolderSignals(
    process,
    socketPath,
    () => ownsSocket,
  );
  const onUncaughtException = (error: Error): void => {
    if (!ownsSocket) return;
    logNativeHolderEvent(socketPath, "uncaught-exception", {
      name: error.name,
    });
  };
  process.on("uncaughtExceptionMonitor", onUncaughtException);
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? os.homedir();
  const tmpDir = options.tmpDir ?? os.tmpdir();
  const activityPollIntervalMs =
    options.activityPollIntervalMs ?? ACTIVITY_POLL_INTERVAL_MS;
  try {
    const sdk = createCliBbSdk(baseUrl);
    const nodePty = await import("node-pty");
    let discovery: {
      cli: Parameters<typeof findNativeSession>[0]["cli"];
      launchedAtMs: number;
    } | null = null;
    const discoverer = createSessionDiscoverer({
      currentCredential: () => currentCredential(),
      discardUnsentReports: () => reporter.discardRetained(),
      find: () => {
        if (discovery === null) return null;
        try {
          const match = findNativeSession({
            cli: discovery.cli,
            cwd,
            env,
            launchedAtMs: discovery.launchedAtMs,
            nowMs: Date.now(),
          });
          return match.kind === "unique" ? match.sessionId : null;
        } catch {
          return null;
        }
      },
      log: (event, fields) => {
        if (ownsSocket) logNativeHolderEvent(socketPath, event, fields);
      },
      reader: () => reader,
      recordSession: (args) =>
        sdk.nativeTerminals.recordSession({ ...args, threadId }),
    });
    const discover = discoverer.discover;
    let reader: NativeActivityReader | null = null;
    let hookSpoolDirectory: string | null = null;
    let pinnedSettingsDirectory: string | null = null;
    const activityTimers: NodeJS.Timeout[] = [];
    let currentCredential: () => string | null = () => null;
    const reporter = createNativeActivityReporter({
      currentCredential: () => currentCredential(),
      log: (event, fields) => {
        if (ownsSocket) logNativeHolderEvent(socketPath, event, fields);
      },
      send: (args) => sdk.nativeTerminals.reportActivity(args),
      threadId,
    });
    const report = reporter.report;
    const wiring = createNativeActivityWiring({
      currentCredential: () => currentCredential(),
      log: (event, fields) => {
        if (ownsSocket) logNativeHolderEvent(socketPath, event, fields);
      },
      reader: () => reader,
      recordSession: (args) =>
        sdk.nativeTerminals.recordSession({ ...args, threadId }),
      report,
      retryReport: reporter.retry,
    });
    const sessionStarted = createNativeSessionStartedReporter({
      currentCredential: () => currentCredential(),
      log: (event, fields) => {
        if (ownsSocket) logNativeHolderEvent(socketPath, event, fields);
      },
      recordSession: (args) =>
        sdk.nativeTerminals.recordSession({ ...args, threadId }),
    });
    const readActivity = createNativeActivityPump({
      reader: () => reader,
      report,
      sessionStarted: sessionStarted.note,
    });
    const finishActivity = (): void => {
      report(reader?.finish() ?? null);
    };
    let pty: ReturnType<typeof nodePty.spawn> | null = null;
    const exitCode = await runNativeHolder({
      socketPath,
      holderMarkerGeneration,
      holderPid: process.pid,
      holderPgid: process.pid,
      holderSid: process.pid,
      cwd,
      env,
      onCredentialChanged: wiring.onCredentialChanged,
      prepare: async ({
        credential,
        credentialSocket,
        currentCredential: readCredential,
      }) => {
        currentCredential = readCredential;
        const spec = await sdk.nativeTerminals.launch({
          imagesAsArgv: true,
          reportsSessionStart: true,
          threadId,
        });
        const activity = spec.cli.activity;
        const hooks = activity?.hooks;
        const capture: HookCapture | null =
          hooks === undefined
            ? null
            : openHookCapture(
                hookSpoolCandidates({
                  env,
                  home,
                  tmpDir,
                }),
                threadId,
                {
                  appendFallback: () => {
                    if (ownsSocket) {
                      logNativeHolderEvent(
                        socketPath,
                        "activity-hook-spool-append-fallback",
                        {},
                      );
                    }
                  },
                  unsupported: () => {
                    if (ownsSocket) {
                      logNativeHolderEvent(
                        socketPath,
                        "activity-hook-spool-unsupported",
                        {},
                      );
                    }
                  },
                },
              );
        hookSpoolDirectory = capture?.directory ?? null;
        const source = capture?.source;
        const hookTarget =
          source === undefined ||
          (typeof source === "object" && "unavailable" in source)
            ? null
            : source;
        const settings = prepareNativeSettings({
          env,
          providerId: spec.providerId,
          sessionRootEnv: spec.cli.sessionRoot.env,
          hooks,
          hookTarget,
        });
        pinnedSettingsDirectory = settings?.directory ?? null;
        const activityArgs =
          hooks === undefined || settings === null
            ? []
            : hooks.args.map((arg) =>
                fillNativeTerminalTemplate(arg, { settings: settings.value }),
              );
        const script = process.argv[1];
        const mcpArgs =
          script === undefined || credential === null
            ? []
            : nativeMcpArgs(spec.cli, {
                command: process.execPath,
                args: [
                  ...process.execArgv,
                  script,
                  "thread",
                  "native-mcp",
                  threadId,
                  "--server-url",
                  baseUrl,
                  "--credential-socket",
                  credentialSocket,
                ],
              });
        const launch = resolveNativeHarnessLaunch(
          spec,
          env,
          activityArgs,
          mcpArgs,
          cwd,
        );
        discovery = { cli: spec.cli, launchedAtMs: Date.now() };
        discoverer.arm(launch.session.kind === "discover");
        reader = new NativeActivityReader(
          spec.cli,
          env,
          capture?.source ?? null,
          launch.session.kind === "resume"
            ? {
                ...launch.session,
                ...(await measureResumedTranscript(
                  spec.cli,
                  env,
                  launch.session.id,
                )),
              }
            : launch.session,
          (total) => {
            if (ownsSocket) {
              logNativeHolderEvent(socketPath, "activity-transcript-eviction", {
                count: total,
              });
            }
          },
          (reason, total) => {
            if (ownsSocket) {
              logNativeHolderEvent(
                socketPath,
                "activity-hook-identity-unconfirmed",
                {
                  reason,
                  count: total,
                },
              );
            }
          },
          wiring.onSessionAdopted,
        );
        if (activity !== undefined) {
          activityTimers.push(
            setInterval(readActivity, activityPollIntervalMs),
            setInterval(() => {
              wiring.onHeartbeatTick();
              sessionStarted.retry();
            }, ACTIVITY_HEARTBEAT_INTERVAL_MS),
          );
        }
        return { command: launch.command, args: launch.args };
      },
      spawnPty: (child, options) => {
        pty = nodePty.spawn(child.command, child.args, {
          name: env.TERM ?? "xterm-256color",
          cols: options.cols,
          rows: options.rows,
          cwd: options.cwd,
          env: options.env,
        });
        return pty;
      },
      tick: discover,
      tickIntervalMs: SESSION_DISCOVERY_INTERVAL_MS,
      onSocketReady: () => {
        ownsSocket = true;
      },
      onSocketClosed: () => {
        ownsSocket = false;
      },
      checkTerminal: () => checkNativeTerminal({ baseUrl, threadId }),
    });
    for (const timer of activityTimers) clearInterval(timer);
    await discover();
    readActivity();
    finishActivity();
    await Promise.race([
      Promise.all([
        reporter.settled(),
        wiring.settled(),
        sessionStarted.settled(),
      ]),
      new Promise((resolve) => setTimeout(resolve, ACTIVITY_FLUSH_TIMEOUT_MS)),
    ]);
    if (hookSpoolDirectory !== null) removeHookSpool(hookSpoolDirectory);
    if (pinnedSettingsDirectory !== null) {
      removePinnedNativeSettings(pinnedSettingsDirectory);
    }
    return exitCode;
  } finally {
    restoreSignals();
    process.off("uncaughtExceptionMonitor", onUncaughtException);
  }
}

export function registerNativeCommands(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("native [threadId]")
    .description(
      "Open a thread's native terminal (default when neither --convert nor --chat is given), resuming its provider CLI session if it has exited",
    )
    .option("--self", "Target the current thread (BB_THREAD_ID)")
    .option(
      "--convert",
      "Move a chat thread to its native terminal: stops its running turn and resumes the same session in claude or codex",
    )
    .option(
      "--chat",
      "Move a converted thread back to chat: closes its terminal and lets bb continue the same session",
    )
    .option("--attach", "Attach this terminal to the native session")
    .option("--json", "Print machine-readable JSON output without attaching")
    .addHelpText(
      "after",
      [
        "",
        "Default action: without --convert or --chat, opens (or resumes) the native terminal",
        "and prints its session and terminal status.",
        "Flag combinations: --attach combines with default open or --convert; --chat cannot",
        "be combined with --convert or --attach; --json prints metadata without attaching.",
      ].join("\n"),
    )
    .action(
      action(
        async (threadIdArg: string | undefined, opts: NativeOpenOptions) => {
          const threadId = requireThreadIdOrSelf(threadIdArg, {
            self: opts.self === true,
          });
          if (opts.chat && (opts.convert || opts.attach)) {
            throw new CliExitError(
              "--chat cannot be combined with --convert or --attach",
              1,
            );
          }
          const sdk = createCliBbSdk(getUrl());
          if (opts.chat) {
            const result = await sdk.nativeTerminals.switchMode({
              threadId,
              mode: "chat",
            });
            if (outputJson(opts, result)) return;
            console.log(`Thread ${threadId} is back in chat`);
            return;
          }
          const columns = process.stdout.columns;
          const rows = process.stdout.rows;
          const view = opts.convert
            ? await sdk.nativeTerminals.switchMode({
                threadId,
                mode: "terminal",
              })
            : await sdk.nativeTerminals.open({
                threadId,
                ...(columns ? { cols: columns } : {}),
                ...(rows ? { rows } : {}),
              });
          if (view === null) {
            throw new CliExitError("The native terminal did not open", 1);
          }
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
    .option(
      "--reattach",
      "Only attach to the thread's CLI if it is still running; never start it",
    )
    .option("--json", "Print the probe result as JSON")
    .action(
      action(async (threadId: string, opts: NativeRunOptions) => {
        if (opts.probe) {
          if (opts.json) console.log(JSON.stringify({ supported: true }));
          return;
        }
        process.exitCode = await runNativeHarness(
          getUrl(),
          threadId,
          opts.reattach === true,
        );
      }),
    );

  parent
    .command("native-mcp <threadId>", { hidden: true })
    .description(
      "Serve a native thread's bb tools to its provider CLI over stdio MCP (native-run passes this to the CLI)",
    )
    .option(
      "--server-url <url>",
      "bb server to serve the tools from; the provider CLI starts this command without bb's environment",
    )
    .requiredOption(
      "--credential-socket <path>",
      "Unix socket (mode 0600) on which the native terminal holder serves the terminal's tool credential",
    )
    .action(
      action(async (threadId: string, opts: NativeMcpOptions) => {
        const sdk = createNodeBbSdk({
          baseUrl: opts.serverUrl ?? getUrl(),
          fetch: withSocketCredential(cliFetch, opts.credentialSocket),
        });
        await runNativeMcpServer(
          {
            listTools: async () =>
              (await sdk.nativeTerminals.agentTools({ threadId })).tools,
            callTool: (call) =>
              sdk.nativeTerminals.callAgentTool({
                threadId,
                tool: call.tool,
                callId: call.callId,
                arguments: call.arguments,
                signal: call.signal,
              }),
          },
          { input: process.stdin, output: process.stdout },
        );
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
    .option(
      "--marker-generation <generation>",
      "Generation of the native holder pid marker claimed for this launch",
    )
    .option("--json", "Print the provider CLI's exit code as JSON when it ends")
    .action(
      action(async (threadId: string, opts: NativeHoldOptions) => {
        const markerGeneration =
          opts.markerGeneration !== undefined &&
          /^[1-9]\d*$/u.test(opts.markerGeneration)
            ? Number.parseInt(opts.markerGeneration, 10)
            : undefined;
        const exitCode = await holdNativeHarness(
          getUrl(),
          threadId,
          opts.socket,
          { markerGeneration },
        );
        removeEmptyNativeHolderLog(opts.socket);
        if (opts.json) console.log(JSON.stringify({ exitCode }));
        process.exitCode = exitCode;
      }),
    );
}
