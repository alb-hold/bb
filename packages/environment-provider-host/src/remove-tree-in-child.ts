import { spawn } from "node:child_process";
import { z } from "zod";
import { removeTreeChildSource } from "./generated/remove-tree-child.js";
import {
  RetainedRecoveryError,
  type RemoveDirectoryTreeResult,
} from "./remove-directory-tree-core.js";
import {
  encodeChildRemovalOptions,
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
  }),
  z.object({
    type: z.literal("result"),
    result: z.object({
      status: z.enum(["removed", "retained"]),
      retainedPaths: z.array(z.string()),
      mountedPaths: z.array(z.string()),
      unanchoredPaths: z.array(z.string()),
      removalStarted: z.boolean(),
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
}

export interface ChildRemoval {
  result: RemoveDirectoryTreeResult;
  pid: number;
  ops: number;
  voluntaryContextSwitches: number;
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

export function removeDirectoryTreeInChild(
  root: string,
  options: ChildRemovalOptions & {
    onHeartbeat?: ((heartbeat: RemovalHeartbeat) => void) | undefined;
  },
): Promise<ChildRemoval> {
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
    let stderr = "";
    let startSent = false;
    let outcome:
      | { kind: "result"; removal: ChildRemoval }
      | { kind: "error"; error: Error }
      | undefined;
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
        const start: ParentMessage = {
          type: "start",
          root,
          options: encodeChildRemovalOptions(options),
        };
        child.send(start, (error) => {
          if (error !== null) fail(error);
        });
        return;
      }
      if (message.type === "heartbeat") {
        options.onHeartbeat?.({
          pid: child.pid!,
          ops: message.ops,
          entry: message.entry,
          removalStarted: message.removalStarted,
        });
        return;
      }
      if (outcome !== undefined) return;
      outcome =
        message.type === "result"
          ? {
              kind: "result",
              removal: {
                result: message.result,
                pid: child.pid!,
                ops: message.ops,
                voluntaryContextSwitches: message.voluntaryContextSwitches,
              },
            }
          : {
              kind: "error",
              error:
                message.name === "RetainedRecoveryError"
                  ? new RetainedRecoveryError(
                      message.message,
                      message.retainedPaths,
                    )
                  : new Error(message.message),
            };
    });
    child.on("exit", (code, signal) => {
      if (outcome?.kind === "result") resolve(outcome.removal);
      else if (outcome?.kind === "error") reject(outcome.error);
      else
        reject(
          new Error(
            `the tree removal process exited with ${signal ?? `code ${code}`} before it finished${stderr === "" ? "" : `: ${stderr.trim()}`}`,
          ),
        );
    });
    child.stdin!.end(removeTreeChildSource);
  });
}
