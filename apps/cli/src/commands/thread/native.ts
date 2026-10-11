import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import type { NativeTerminalThread } from "@bb/server-contract";
import { action, CliExitError } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { requireThreadIdOrSelf } from "../../context-env.js";
import { fillNativeTerminalTemplate } from "@bb/domain";
import {
  classifyHookRecord,
  classifyTranscriptRecord,
  JsonlTail,
  nativeActivityHookSettings,
  NativeActivityTracker,
  type NativeActivityReport,
} from "../../native-activity.js";
import {
  findNativeSession,
  findNativeSessionFile,
  resolveNativeHarnessLaunch,
} from "../../native-harness.js";
import { outputJson } from "../helpers.js";
import { attachTerminal } from "../terminal.js";

const SESSION_DISCOVERY_INTERVAL_MS = 2_000;
const ACTIVITY_POLL_INTERVAL_MS = 750;
const ACTIVITY_HEARTBEAT_INTERVAL_MS = 30_000;
const ACTIVITY_FLUSH_TIMEOUT_MS = 3_000;
const FORWARDED_SIGNALS = ["SIGTERM", "SIGHUP"] as const;
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
}

function describeNativeThread(view: NativeTerminalThread): string {
  const terminal =
    view.terminal === null
      ? "no terminal"
      : `terminal ${view.terminal.id} (${view.terminal.status})`;
  const session = view.nativeSessionId ?? "not yet known";
  return `${view.displayName} session ${session}, ${terminal}`;
}

async function runNativeHarness(
  baseUrl: string,
  threadId: string,
): Promise<number> {
  const sdk = createCliBbSdk(baseUrl);
  const spec = await sdk.nativeTerminals.launch({ threadId });
  const activity = spec.cli.activity;
  const hooks = activity?.hooks;
  const eventsFile =
    hooks === undefined
      ? null
      : path.join(
          os.tmpdir(),
          `bb-native-activity-${threadId}-${process.pid}.jsonl`,
        );
  if (eventsFile !== null) writeFileSync(eventsFile, "", { mode: 0o600 });
  const activityArgs =
    hooks === undefined || eventsFile === null
      ? []
      : hooks.args.map((arg) =>
          fillNativeTerminalTemplate(arg, {
            settings: nativeActivityHookSettings(hooks, eventsFile),
          }),
        );
  const launch = resolveNativeHarnessLaunch(spec, process.env, activityArgs);
  const resuming = !launch.discoverSession && spec.nativeSessionId !== null;
  const cwd = process.cwd();
  const launchedAtMs = Date.now();
  const child = spawn(launch.command, launch.args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  for (const signal of SWALLOWED_SIGNALS) process.on(signal, () => {});
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }

  let sessionId = spec.nativeSessionId;
  let recorded = !launch.discoverSession;
  const discover = async (): Promise<void> => {
    if (recorded) return;
    let match: ReturnType<typeof findNativeSession>;
    try {
      match = findNativeSession({
        cli: spec.cli,
        cwd,
        env: process.env,
        launchedAtMs,
        nowMs: Date.now(),
      });
    } catch {
      return;
    }
    if (match.kind !== "unique") return;
    recorded = true;
    sessionId = match.sessionId;
    try {
      await sdk.nativeTerminals.recordSession({
        threadId,
        nativeSessionId: match.sessionId,
      });
    } catch {
      recorded = false;
    }
  };
  const timer = launch.discoverSession
    ? setInterval(() => {
        discover().catch(() => undefined);
      }, SESSION_DISCOVERY_INTERVAL_MS)
    : null;

  const tracker = new NativeActivityTracker();
  const hookTail = new JsonlTail(false);
  const transcriptTail = new JsonlTail(resuming);
  let transcriptFile: string | null = null;
  let reporting: Promise<void> = Promise.resolve();
  const report = (next: NativeActivityReport | null): void => {
    if (next === null) return;
    reporting = reporting.then(() =>
      sdk.nativeTerminals
        .reportActivity({
          threadId,
          state: next.state,
          ...(next.prompt === null ? {} : { prompt: next.prompt }),
        })
        .then(
          () => undefined,
          () => undefined,
        ),
    );
  };
  const readActivity = (): void => {
    if (activity === undefined) return;
    if (hooks !== undefined && eventsFile !== null) {
      for (const record of hookTail.readRecords(eventsFile)) {
        report(tracker.apply(classifyHookRecord(hooks, record)));
      }
    }
    if (activity.transcript === undefined) return;
    if (transcriptFile === null && sessionId !== null) {
      try {
        transcriptFile = findNativeSessionFile(
          spec.cli,
          process.env,
          sessionId,
        );
      } catch {
        transcriptFile = null;
      }
    }
    if (transcriptFile === null) return;
    for (const record of transcriptTail.readRecords(transcriptFile)) {
      report(
        tracker.apply(classifyTranscriptRecord(activity.transcript, record)),
      );
    }
  };
  const activityTimer =
    activity === undefined
      ? null
      : setInterval(readActivity, ACTIVITY_POLL_INTERVAL_MS);
  const heartbeatTimer =
    activity === undefined
      ? null
      : setInterval(
          () => report(tracker.heartbeat()),
          ACTIVITY_HEARTBEAT_INTERVAL_MS,
        );

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 128));
    });
  });
  if (timer !== null) clearInterval(timer);
  if (activityTimer !== null) clearInterval(activityTimer);
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
  await discover();
  readActivity();
  report(tracker.finish());
  await Promise.race([
    reporting,
    new Promise((resolve) => setTimeout(resolve, ACTIVITY_FLUSH_TIMEOUT_MS)),
  ]);
  if (eventsFile !== null) rmSync(eventsFile, { force: true });
  return exitCode;
}

export function registerNativeCommands(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("native [threadId]")
    .description(
      "Open a thread's native terminal, resuming its provider CLI session when it has exited. --convert moves a claude-code or codex chat thread to its terminal on the same session; --chat moves it back",
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
    .option("--json", "Print machine-readable JSON output")
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
}
