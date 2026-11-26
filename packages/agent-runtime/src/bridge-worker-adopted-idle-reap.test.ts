import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import {
  readBridgeWorkerEntries,
  type BridgeWorkerRegistryEntry,
} from "./bridge-worker-registry.js";
import { promptTextInput } from "./test/prompt-input.js";
import {
  createScriptedEchoRuntime,
  type LaunchBoundAgentRuntime,
  fullRuntimeOptions,
  scriptedEchoProcessEnv,
  waitForRuntimeState,
  waitForThreadTurnCompleted,
} from "./test/runtime-test-harness.js";
import type { AgentRuntimeBridgeWorkers } from "./types.js";

const PROVIDER_ID = "fake";
const WORKER_EXIT_TIMEOUT_MS = 30_000;
const IDLE_FOR_MS = 30 * 60 * 1000;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("idle reaping of adopted provider sessions", () => {
  let root: string;
  let workspacePath: string;
  let bridgeWorkers: AgentRuntimeBridgeWorkers;
  const startedPids = new Set<number>();
  const runtimes: LaunchBoundAgentRuntime[] = [];
  const env = scriptedEchoProcessEnv({ sessionRestorable: true });

  beforeEach(() => {
    root = mkdtempSync(
      join(process.platform === "win32" ? tmpdir() : "/tmp", "bba-"),
    );
    workspacePath = join(root, "ws");
    mkdirSync(workspacePath);
    bridgeWorkers = {
      dir: join(root, "bridge-workers"),
      environmentId: "env-1",
      workspace: {
        workspacePath,
        workspaceProvisionType: "unmanaged",
        personalWorkspaceRoot: null,
      },
    };
  });

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
    for (const pid of startedPids) {
      if (isPidAlive(pid)) process.kill(pid, "SIGKILL");
    }
    startedPids.clear();
    rmSync(root, { recursive: true, force: true });
  });

  function trackWorkers(): BridgeWorkerRegistryEntry[] {
    const entries = readBridgeWorkerEntries(bridgeWorkers.dir).entries;
    for (const entry of entries) startedPids.add(entry.pid);
    return entries;
  }

  function createRuntime(events: ThreadEvent[]): LaunchBoundAgentRuntime {
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath,
        bridgeWorkers,
        env,
        onInteractiveRequest: () => new Promise(() => {}),
        onEvent: (event, delivery) => {
          events.push(event);
          delivery?.onSettled();
        },
      },
    });
    runtimes.push(runtime);
    return runtime;
  }

  async function startPreSwapThread(events: ThreadEvent[]) {
    const before = createRuntime(events);
    const { providerThreadId } = await before.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: PROVIDER_ID,
      options: fullRuntimeOptions,
    });
    const [worker] = trackWorkers();
    if (worker === undefined) throw new Error("no registered worker");
    await before.detach();
    return { worker, providerThreadId };
  }

  function adoptAll(runtime: LaunchBoundAgentRuntime): void {
    const adopted = runtime.adoptBridgeWorkers({
      dir: bridgeWorkers.dir,
      entries: readBridgeWorkerEntries(bridgeWorkers.dir).entries,
    });
    expect(adopted.map((thread) => thread.threadId)).toEqual(["t1"]);
    runtime.completeBridgeWorkerAdoption(new Map([["t1", null]]));
  }

  it("reaps an adopted idle session, exits its worker, and resumes on a new worker", async () => {
    const events: ThreadEvent[] = [];
    const { worker, providerThreadId } = await startPreSwapThread(events);
    const after = createRuntime(events);
    adoptAll(after);
    expect(isPidAlive(worker.pid)).toBe(true);

    const result = await after.reapIdleProviderSessions({
      idleForMs: IDLE_FOR_MS,
      nowMs: Date.now() + IDLE_FOR_MS + 60_000,
    });

    expect(result.reapedSessions.map((session) => session.threadId)).toEqual([
      "t1",
    ]);
    await waitForRuntimeState({
      label: "adopted worker exited after reap",
      predicate: () => !isPidAlive(worker.pid),
      timeoutMs: WORKER_EXIT_TIMEOUT_MS,
    });
    expect(after.hasThread("t1")).toBe(false);

    await after.resumeThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: PROVIDER_ID,
      providerThreadId,
      options: fullRuntimeOptions,
    });
    await after.runTurn({
      clientRequestId: "creq_adptt66666",
      threadId: "t1",
      input: [promptTextInput({ text: "after the adopted reap" })],
      options: fullRuntimeOptions,
    });
    await waitForThreadTurnCompleted({ events, threadId: "t1" });
    const [fresh] = trackWorkers();
    expect(fresh?.id).not.toBe(worker.id);
    expect(fresh?.pid).not.toBe(worker.pid);
  }, WORKER_EXIT_TIMEOUT_MS);

  const neverReaped = [
    { name: "mid-turn", prompt: "hold_turn", clientRequestId: "creq_adptt77777" },
    {
      name: "waiting on a permission",
      prompt: "approve:command",
      clientRequestId: "creq_adptt88888",
    },
    {
      name: "waiting on a question",
      prompt: "ask_user",
      clientRequestId: "creq_adptt99999",
    },
  ];

  it.each(neverReaped)(
    "never reaps a session $name",
    async ({ prompt, clientRequestId }) => {
      const events: ThreadEvent[] = [];
      const runtime = createRuntime(events);
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: PROVIDER_ID,
        options: fullRuntimeOptions,
      });
      const [worker] = trackWorkers();
      await runtime.runTurn({
        clientRequestId,
        threadId: "t1",
        input: [promptTextInput({ text: prompt })],
        options: fullRuntimeOptions,
      });
      await waitForRuntimeState({
        label: "turn started",
        predicate: () => events.some((event) => event.type === "turn/started"),
        timeoutMs: WORKER_EXIT_TIMEOUT_MS,
      });

      const result = await runtime.reapIdleProviderSessions({
        idleForMs: 0,
        nowMs: Date.now() + IDLE_FOR_MS,
      });

      expect(result.reapedSessions).toEqual([]);
      expect(runtime.hasThread("t1")).toBe(true);
      expect(worker && isPidAlive(worker.pid)).toBe(true);
    },
    WORKER_EXIT_TIMEOUT_MS,
  );

  it("never reaps an idle session with a running background command", async () => {
    const events: ThreadEvent[] = [];
    const runtime = createRuntime(events);
    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: PROVIDER_ID,
      options: fullRuntimeOptions,
    });
    const [worker] = trackWorkers();
    await runtime.runTurn({
      clientRequestId: "creq_adptt3333b",
      threadId: "t1",
      input: [promptTextInput({ text: "bg_task" })],
      options: fullRuntimeOptions,
    });
    await waitForThreadTurnCompleted({ events, threadId: "t1" });
    expect(runtime.hasOpenBackgroundWork()).toBe(true);

    const result = await runtime.reapIdleProviderSessions({
      idleForMs: IDLE_FOR_MS,
      nowMs: Date.now() + IDLE_FOR_MS + 60_000,
    });

    expect(result.reapedSessions).toEqual([]);
    expect(runtime.hasThread("t1")).toBe(true);
    expect(worker && isPidAlive(worker.pid)).toBe(true);
  }, WORKER_EXIT_TIMEOUT_MS);
});
