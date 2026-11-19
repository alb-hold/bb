import { spawn } from "node:child_process";
import { z } from "zod";
import { removeTreeChildSource } from "./generated/remove-tree-child.js";
import {
  RetainedRecoveryError,
  type RemoveDirectoryTreeResult,
  type TreeMoveInspection,
} from "./remove-directory-tree-core.js";
import {
  REMOVE_EXIT_WAIT_MS,
  REMOVE_KILL_GRACE_MS,
  REMOVE_STALL_MS,
} from "./remove-timeout.js";
import {
  encodeChildRemovalOptions,
  type ChildInspectionOptions,
  type ChildRemovalOptions,
  type ParentMessage,
} from "./remove-tree-protocol.js";

const STDERR_LIMIT = 4096;

const CHILD_ENVIRONMENT_NAMES = [
  "ELECTRON_RUN_AS_NODE",
  "SystemRoot",
  "TMPDIR",
  "TEMP",
  "TMP",
] as const;

const childMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("heartbeat"),
    ops: z.number().int().nonnegative(),
    entry: z.string(),
    removalStarted: z.boolean(),
    directory: z.boolean(),
  }),
  z.object({
    type: z.literal("result"),
    result: z.object({
      status: z.enum(["removed", "retained"]),
      retainedPaths: z.array(z.string()),
      mountedPaths: z.array(z.string()),
      unanchoredPaths: z.array(z.string()),
      notRespondingPaths: z.array(z.string()),
      stoppedPaths: z.array(z.string()),
      removalStarted: z.boolean(),
    }),
    ops: z.number().int().nonnegative(),
    voluntaryContextSwitches: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal("inspection"),
    inspection: z.object({
      changed: z.boolean(),
      mountedPaths: z.array(z.string()),
      fingerprint: z.string(),
      stoppedAt: z.string().nullable(),
    }),
    ops: z.number().int().nonnegative(),
    voluntaryContextSwitches: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal("error"),
    name: z.string(),
    message: z.string(),
    retainedPaths: z.array(z.string()),
  }),
]);

export interface RemovalHeartbeat {
  pid: number;
  ops: number;
  entry: string;
  removalStarted: boolean;
  directory: boolean;
}

export type RemovalStopCause = "deadline" | "abort" | "stall";

export interface RemovalStop {
  cause: RemovalStopCause;
  killedDuring: string | null;
}

export interface ChildRemoval {
  result: RemoveDirectoryTreeResult;
  pid: number;
  ops: number;
  voluntaryContextSwitches: number;
  stop: RemovalStop | null;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  exited: Promise<void>;
}

export interface ChildRemovalControls {
  onHeartbeat?: ((heartbeat: RemovalHeartbeat) => void) | undefined;
  signal?: AbortSignal | undefined;
  deadline?: AbortSignal | undefined;
  stallMs?: number | undefined;
  graceMs?: number | undefined;
  exitWaitMs?: number | undefined;
  target?: string | undefined;
  killSignal?: NodeJS.Signals | undefined;
}

const stuckRemovals = new Map<string, number>();

export function stuckRemovalProcess(target: string): number | null {
  return stuckRemovals.get(target) ?? null;
}

export function stuckRemovalReason(pid: number): string {
  return `an earlier removal of this path is still stuck (process ${pid})`;
}

export async function removalChildExited(
  exited: Promise<void>,
  deadline: AbortSignal | undefined,
): Promise<boolean> {
  let release = () => {};
  const expired = new Promise<boolean>((resolve) => {
    if (deadline === undefined || deadline.aborted) {
      setImmediate(() => resolve(false));
      return;
    }
    const onAbort = () => resolve(false);
    deadline.addEventListener("abort", onAbort, { once: true });
    release = () => deadline.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([exited.then(() => true), expired]);
  } finally {
    release();
  }
}

export function removalChildEnvironment(
  environment: NodeJS.ProcessEnv,
  electron: boolean,
): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENVIRONMENT_NAMES) {
    const value = environment[name];
    if (value !== undefined) selected[name] = value;
  }
  if (electron) selected.ELECTRON_RUN_AS_NODE = "1";
  return selected;
}

type ChildMessageFromSchema = z.infer<typeof childMessageSchema>;

type FinishMessage = Extract<
  ChildMessageFromSchema,
  { type: "result" | "inspection" }
>;

interface TreeChildRun<T> {
  value: T;
  pid: number;
  ops: number;
  voluntaryContextSwitches: number;
  stop: RemovalStop | null;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  exited: Promise<void>;
}

function runTreeChild<T>(
  root: string,
  start: ParentMessage,
  options: ChildRemovalControls,
  finished: (message: FinishMessage) => T | null,
  killed: (killedDuring: string, notResponding: string | null) => T,
): Promise<TreeChildRun<T>> {
  const target = options.target ?? root;
  const stuck = stuckRemovalProcess(target);
  if (stuck !== null)
    return Promise.reject(new Error(stuckRemovalReason(stuck)));
  const stallMs = options.stallMs ?? REMOVE_STALL_MS;
  const graceMs = options.graceMs ?? REMOVE_KILL_GRACE_MS;
  const exitWaitMs = options.exitWaitMs ?? REMOVE_EXIT_WAIT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-"], {
      stdio: ["pipe", "ignore", "pipe", "ipc"],
      env: removalChildEnvironment(
        process.env,
        process.versions.electron !== undefined,
      ),
      serialization: "json",
      windowsHide: true,
    });
    const exited = new Promise<void>((resolveExit) => {
      child.once("exit", () => resolveExit());
    });
    let stderr = "";
    let startSent = false;
    let settled = false;
    let lastEntry: string | null = null;
    let lastDirectory: string | null = null;
    let stop: RemovalStop | null = null;
    let notResponding: string | null = null;
    let stallTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let exitTimer: NodeJS.Timeout | undefined;
    let outcome:
      | {
          kind: "result";
          value: T;
          ops: number;
          voluntaryContextSwitches: number;
        }
      | { kind: "error"; error: Error }
      | undefined;

    const clearTimers = () => {
      clearTimeout(stallTimer);
      clearTimeout(graceTimer);
      clearTimeout(exitTimer);
    };
    const detach = () => {
      options.signal?.removeEventListener("abort", onAbort);
      options.deadline?.removeEventListener("abort", onDeadline);
    };
    const settle = (
      exit: { code: number | null; signal: NodeJS.Signals | null } | null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimers();
      detach();
      if (outcome?.kind === "error") {
        reject(outcome.error);
        return;
      }
      if (outcome?.kind === "result") {
        resolve({
          value: outcome.value,
          pid: child.pid!,
          ops: outcome.ops,
          voluntaryContextSwitches: outcome.voluntaryContextSwitches,
          stop,
          exit,
          exited,
        });
        return;
      }
      if (stop !== null && stop.killedDuring !== null) {
        resolve({
          value: killed(stop.killedDuring, notResponding),
          pid: child.pid!,
          ops: 0,
          voluntaryContextSwitches: 0,
          stop,
          exit,
          exited,
        });
        return;
      }
      reject(
        new Error(
          `the tree removal process exited with ${exit?.signal ?? `code ${exit?.code}`} before it finished${stderr === "" ? "" : `: ${stderr.trim()}`}`,
        ),
      );
    };
    const kill = (during: string) => {
      if (stop !== null) stop.killedDuring = during;
      clearTimeout(stallTimer);
      clearTimeout(graceTimer);
      child.kill(options.killSignal ?? "SIGKILL");
      exitTimer = setTimeout(() => {
        if (child.pid !== undefined) stuckRemovals.set(target, child.pid);
        child.unref();
        child.channel?.unref();
        child.stdin?.destroy();
        child.stderr?.destroy();
        settle(null);
      }, exitWaitMs);
    };
    const armStall = () => {
      clearTimeout(stallTimer);
      if (stop !== null) return;
      stallTimer = setTimeout(() => {
        stop = { cause: "stall", killedDuring: null };
        notResponding = lastDirectory ?? root;
        kill(lastEntry ?? root);
      }, stallMs);
    };
    const sendStop = () => {
      const message: ParentMessage = { type: "stop" };
      if (child.connected) child.send(message, () => {});
    };
    const requestStop = (cause: "deadline" | "abort") => {
      if (stop !== null || settled) return;
      stop = { cause, killedDuring: null };
      clearTimeout(stallTimer);
      if (startSent) sendStop();
      graceTimer = setTimeout(() => kill(lastEntry ?? root), graceMs);
    };
    function onAbort() {
      requestStop("abort");
    }
    function onDeadline() {
      requestStop("deadline");
    }
    const fail = (error: Error) => {
      outcome ??= { kind: "error", error };
      child.kill("SIGKILL");
    };

    child.stdin!.on("error", () => {});
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      if (stderr.length < STDERR_LIMIT)
        stderr = `${stderr}${chunk}`.slice(0, STDERR_LIMIT);
    });
    child.on("error", fail);
    child.on("message", (raw: unknown) => {
      const parsed = childMessageSchema.safeParse(raw);
      if (!parsed.success) {
        fail(new Error("the tree removal process sent an unreadable message"));
        return;
      }
      const message = parsed.data;
      if (message.type === "ready") {
        if (startSent) return;
        startSent = true;
        child.send(start, (error) => {
          if (error !== null) fail(error);
        });
        if (stop !== null) sendStop();
        else armStall();
        return;
      }
      if (message.type === "heartbeat") {
        lastEntry = message.entry;
        if (message.directory) lastDirectory = message.entry;
        armStall();
        options.onHeartbeat?.({
          pid: child.pid!,
          ops: message.ops,
          entry: message.entry,
          removalStarted: message.removalStarted,
          directory: message.directory,
        });
        return;
      }
      if (outcome !== undefined) return;
      clearTimeout(stallTimer);
      clearTimeout(graceTimer);
      if (message.type === "error") {
        outcome = {
          kind: "error",
          error:
            message.name === "RetainedRecoveryError"
              ? new RetainedRecoveryError(
                  message.message,
                  message.retainedPaths,
                )
              : new Error(message.message),
        };
        return;
      }
      const value = finished(message);
      if (value === null) {
        fail(
          new Error(
            "the tree removal process answered a different request than it was sent",
          ),
        );
        return;
      }
      outcome = {
        kind: "result",
        value,
        ops: message.ops,
        voluntaryContextSwitches: message.voluntaryContextSwitches,
      };
    });
    child.on("exit", (code, signal) => {
      if (stuckRemovals.get(target) === child.pid) stuckRemovals.delete(target);
      settle({ code, signal });
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    options.deadline?.addEventListener("abort", onDeadline, { once: true });
    if (options.signal?.aborted) requestStop("abort");
    else if (options.deadline?.aborted) requestStop("deadline");
    child.stdin!.end(removeTreeChildSource);
  });
}

export async function removeDirectoryTreeInChild(
  root: string,
  options: ChildRemovalOptions & ChildRemovalControls,
): Promise<ChildRemoval> {
  const { value, ...run } = await runTreeChild<RemoveDirectoryTreeResult>(
    root,
    { type: "start", root, options: encodeChildRemovalOptions(options) },
    options,
    (message) => (message.type === "result" ? message.result : null),
    (killedDuring, notResponding) => ({
      status: "retained",
      retainedPaths: [root],
      mountedPaths: [],
      unanchoredPaths: [],
      notRespondingPaths: notResponding === null ? [] : [notResponding],
      stoppedPaths: notResponding === null ? [killedDuring] : [],
      removalStarted: true,
    }),
  );
  return { result: value, ...run };
}

export type ChildInspectionOutcome =
  | { status: "inspected"; inspection: TreeMoveInspection }
  | { status: "stopped"; result: RemoveDirectoryTreeResult };

export interface ChildInspection {
  outcome: ChildInspectionOutcome;
  pid: number;
  stop: RemovalStop | null;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  exited: Promise<void>;
}

function stoppedInspection(
  notRespondingPaths: string[],
  stoppedPaths: string[],
): ChildInspectionOutcome {
  return {
    status: "stopped",
    result: {
      status: "retained",
      retainedPaths: [],
      mountedPaths: [],
      unanchoredPaths: [],
      notRespondingPaths,
      stoppedPaths,
      removalStarted: false,
    },
  };
}

export async function inspectTreeBeforeMoveInChild(
  root: string,
  options: ChildInspectionOptions & ChildRemovalControls,
): Promise<ChildInspection> {
  const run = await runTreeChild<ChildInspectionOutcome>(
    root,
    {
      type: "inspect",
      root,
      options: {
        startedAt: options.startedAt,
        rootMetadata: options.rootMetadata,
      },
    },
    options,
    (message) =>
      message.type !== "inspection"
        ? null
        : message.inspection.stoppedAt === null
          ? { status: "inspected", inspection: message.inspection }
          : stoppedInspection([], [message.inspection.stoppedAt]),
    (killedDuring, notResponding) =>
      notResponding === null
        ? stoppedInspection([], [killedDuring])
        : stoppedInspection([notResponding], []),
  );
  return {
    outcome: run.value,
    pid: run.pid,
    stop: run.stop,
    exit: run.exit,
    exited: run.exited,
  };
}
