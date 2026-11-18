import {
  RetainedRecoveryError,
  removeDirectoryTree,
} from "./remove-directory-tree-core.js";
import {
  decodeChildRemovalOptions,
  type ChildMessage,
  type ParentMessage,
} from "./remove-tree-protocol.js";

const HEARTBEAT_INTERVAL_MS = 10;
const parentPid = process.ppid;
let started = false;
let stopRequested = false;
let ops = 0;
let lastHeartbeat = 0;

function parentGone(): boolean {
  return !process.connected || process.ppid !== parentPid;
}

function send(message: ChildMessage, then?: () => void): void {
  if (parentGone()) process.exit(1);
  process.send!(message, undefined, {}, () => then?.());
}

async function entryBoundary(
  entry: string,
  removalStarted: boolean,
): Promise<boolean> {
  ops += 1;
  const now = performance.now();
  if (now - lastHeartbeat < HEARTBEAT_INTERVAL_MS) return !stopRequested;
  lastHeartbeat = now;
  send({ type: "heartbeat", ops, entry, removalStarted });
  await new Promise(setImmediate);
  if (parentGone()) process.exit(1);
  return !stopRequested;
}

async function run(
  message: Extract<ParentMessage, { type: "start" }>,
): Promise<void> {
  let outcome: ChildMessage;
  try {
    const result = await removeDirectoryTree(message.root, {
      ...decodeChildRemovalOptions(message.options),
      entryBoundary,
    });
    outcome = {
      type: "result",
      result,
      ops,
      voluntaryContextSwitches: process.resourceUsage().voluntaryContextSwitches,
    };
  } catch (error) {
    outcome = {
      type: "error",
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      retainedPaths:
        error instanceof RetainedRecoveryError ? error.retainedPaths : [],
    };
  }
  send(outcome, () => process.disconnect());
}

process.on("message", (message: ParentMessage) => {
  if (message.type === "stop") {
    stopRequested = true;
    return;
  }
  if (started) return;
  started = true;
  void run(message);
});

send({ type: "ready" });
