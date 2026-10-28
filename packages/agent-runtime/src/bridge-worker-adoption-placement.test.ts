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
  createScriptedEchoProcessLog,
  createScriptedEchoRequestRecord,
  createScriptedEchoRuntime,
  fullRuntimeOptions,
  scriptedEchoProcessEnv,
  waitForRuntimeState,
  waitForThreadAgentMessageText,
  waitForThreadTurnCompleted,
} from "./test/runtime-test-harness.js";
import type {
  AgentRuntime,
  AgentRuntimeBridgeWorkers,
  AgentRuntimeProcessExitInfo,
} from "./types.js";

const PROVIDER_ID = "fake";
const ADOPTED_EXIT_DETECTION_TIMEOUT_MS = 30_000;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("new provider sessions never land on an adopted bridge worker", () => {
  let root: string;
  let workspacePath: string;
  let bridgeWorkers: AgentRuntimeBridgeWorkers;
  const startedPids = new Set<number>();
  const runtimes: AgentRuntime[] = [];

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

  function createRuntime(args: {
    env?: Record<string, string>;
    events: ThreadEvent[];
    exits?: AgentRuntimeProcessExitInfo[];
  }) {
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath,
        bridgeWorkers,
        env: args.env ?? scriptedEchoProcessEnv({}),
        onEvent: (event, delivery) => {
          args.events.push(event);
          delivery?.onSettled();
        },
        onProcessExit: (info) => args.exits?.push(info),
      },
    });
    runtimes.push(runtime);
    return runtime;
  }

  async function startPreSwapThread(args: {
    earlierThreadIds?: string[];
    env?: Record<string, string>;
    events: ThreadEvent[];
  }) {
    const before = createRuntime(args);
    for (const threadId of args.earlierThreadIds ?? []) {
      await before.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "p1",
        providerId: PROVIDER_ID,
        options: fullRuntimeOptions,
      });
    }
    const { providerThreadId } = await before.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: PROVIDER_ID,
      options: fullRuntimeOptions,
    });
    const [entry] = trackWorkers();
    if (entry === undefined) throw new Error("no registered worker");
    await before.detach();
    return { adoptedWorker: entry, providerThreadId };
  }

  function adoptAll(runtime: AgentRuntime, threadIds: string[] = ["t1"]): void {
    const adopted = runtime.adoptBridgeWorkers({
      dir: bridgeWorkers.dir,
      entries: readBridgeWorkerEntries(bridgeWorkers.dir).entries,
    });
    expect(adopted.map((thread) => thread.threadId).sort()).toEqual(threadIds);
    runtime.completeBridgeWorkerAdoption(
      new Map(threadIds.map((threadId) => [threadId, null])),
    );
  }

  function workerHosting(threadId: string): BridgeWorkerRegistryEntry {
    const hosts = readBridgeWorkerEntries(bridgeWorkers.dir).entries.filter(
      (entry) => threadId in entry.threads,
    );
    expect(hosts).toHaveLength(1);
    const [host] = hosts;
    if (host === undefined) throw new Error(`no worker hosts ${threadId}`);
    return host;
  }

  it("starts a thread created after adoption on a fresh worker", async () => {
    const events: ThreadEvent[] = [];
    const { adoptedWorker } = await startPreSwapThread({ events });

    const after = createRuntime({ events });
    adoptAll(after);
    await after.startThread({
      environmentId: "env-1",
      threadId: "t2",
      projectId: "p1",
      providerId: PROVIDER_ID,
      options: fullRuntimeOptions,
    });
    trackWorkers();

    const host = workerHosting("t2");
    expect(host.id).not.toBe(adoptedWorker.id);
    expect(host.pid).not.toBe(adoptedWorker.pid);
    expect(Object.keys(workerHosting("t1").threads)).toEqual(["t1"]);
    expect(workerHosting("t1").id).toBe(adoptedWorker.id);
  });

  it("keeps serving the existing thread on the adopted worker while it is alive", async () => {
    const events: ThreadEvent[] = [];
    const { adoptedWorker } = await startPreSwapThread({ events });

    const after = createRuntime({ events });
    adoptAll(after);
    await after.startThread({
      environmentId: "env-1",
      threadId: "t2",
      projectId: "p1",
      providerId: PROVIDER_ID,
      options: fullRuntimeOptions,
    });
    await after.runTurn({
      clientRequestId: "creq_adptt22222",
      threadId: "t1",
      input: [promptTextInput({ text: "still on the adopted worker" })],
      options: fullRuntimeOptions,
    });
    await waitForThreadTurnCompleted({ events, threadId: "t1" });
    trackWorkers();

    expect(workerHosting("t1").id).toBe(adoptedWorker.id);
    expect(isPidAlive(adoptedWorker.pid)).toBe(true);
  });

  it(
    "resumes an adopted thread on a fresh worker when its adopted worker exits before acknowledging a turn",
    async () => {
      const events: ThreadEvent[] = [];
      const exits: AgentRuntimeProcessExitInfo[] = [];
      const record = createScriptedEchoRequestRecord();
      const processLog = createScriptedEchoProcessLog();
      const env = {
        ...record.env,
        ...processLog.env,
        ...scriptedEchoProcessEnv({
          exitBeforeTurnStartAckRequestNumbers: [1],
          sessionRestorable: true,
        }),
      };
      const { adoptedWorker, providerThreadId } = await startPreSwapThread({
        env,
        events,
      });

      const after = createRuntime({ env, events, exits });
      adoptAll(after);
      await after.runTurn({
        clientRequestId: "creq_adptt33333",
        threadId: "t1",
        input: [promptTextInput({ text: "survive the adopted worker exit" })],
        options: fullRuntimeOptions,
      });
      await waitForThreadAgentMessageText({
        events,
        providerId: PROVIDER_ID,
        runtime: after,
        text: "survive the adopted worker exit",
        threadId: "t1",
      });
      trackWorkers();

      expect(
        exits.filter((exit) => exit.bridgeWorker?.id === adoptedWorker.id),
      ).toHaveLength(1);
      expect(workerHosting("t1").id).not.toBe(adoptedWorker.id);
      expect(workerHosting("t1").processKey).toBe(adoptedWorker.processKey);
      expect(workerHosting("t1").processKey).not.toContain("#adopted:");
      expect(record.last("thread/resume")?.params?.providerThreadId).toBe(
        providerThreadId,
      );
      expect(record.last("turn/start")?.params?.clientRequestId).toBe(
        "creq_adptt33333",
      );
    },
    ADOPTED_EXIT_DETECTION_TIMEOUT_MS,
  );

  it(
    "reports an adopted worker killed while idle and lets the thread resume on a fresh worker",
    async () => {
      const events: ThreadEvent[] = [];
      const exits: AgentRuntimeProcessExitInfo[] = [];
      const { adoptedWorker, providerThreadId } = await startPreSwapThread({
        events,
      });

      const after = createRuntime({ events, exits });
      adoptAll(after);
      process.kill(adoptedWorker.pid, "SIGKILL");
      await waitForRuntimeState({
        label: "adopted worker exit reported",
        predicate: () =>
          exits.some((exit) => exit.bridgeWorker?.id === adoptedWorker.id),
        timeoutMs: ADOPTED_EXIT_DETECTION_TIMEOUT_MS,
      });

      await after.resumeThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: PROVIDER_ID,
        providerThreadId,
        options: fullRuntimeOptions,
      });
      await after.runTurn({
        clientRequestId: "creq_adptt44444",
        threadId: "t1",
        input: [promptTextInput({ text: "after the idle exit" })],
        options: fullRuntimeOptions,
      });
      await waitForThreadTurnCompleted({ events, threadId: "t1" });
      trackWorkers();

      expect(workerHosting("t1").id).not.toBe(adoptedWorker.id);
      expect(workerHosting("t1").processKey).toBe(adoptedWorker.processKey);
      expect(workerHosting("t1").processKey).not.toContain("#adopted:");
    },
    ADOPTED_EXIT_DETECTION_TIMEOUT_MS,
  );

  it(
    "joins the worker already serving another thread when an adopted worker exits, and retires nothing",
    async () => {
      const events: ThreadEvent[] = [];
      const exits: AgentRuntimeProcessExitInfo[] = [];
      const { adoptedWorker, providerThreadId } = await startPreSwapThread({
        earlierThreadIds: ["t0"],
        events,
      });

      const after = createRuntime({ events, exits });
      adoptAll(after, ["t0", "t1"]);
      await after.startThread({
        environmentId: "env-1",
        threadId: "t2",
        projectId: "p1",
        providerId: PROVIDER_ID,
        options: fullRuntimeOptions,
      });
      trackWorkers();
      const normalWorker = workerHosting("t2");
      expect(normalWorker.processKey).toBe(adoptedWorker.processKey);

      process.kill(adoptedWorker.pid, "SIGKILL");
      await waitForRuntimeState({
        label: "adopted worker exit reported",
        predicate: () =>
          exits.some((exit) => exit.bridgeWorker?.id === adoptedWorker.id),
        timeoutMs: ADOPTED_EXIT_DETECTION_TIMEOUT_MS,
      });
      await after.resumeThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: PROVIDER_ID,
        providerThreadId,
        options: fullRuntimeOptions,
      });
      await after.runTurn({
        clientRequestId: "creq_adptt55555",
        threadId: "t1",
        input: [promptTextInput({ text: "join the normal worker" })],
        options: fullRuntimeOptions,
      });
      await waitForThreadTurnCompleted({ events, threadId: "t1" });
      trackWorkers();

      const entries = readBridgeWorkerEntries(bridgeWorkers.dir).entries;
      expect(entries.map((entry) => entry.id)).toEqual([normalWorker.id]);
      expect(Object.keys(workerHosting("t1").threads).sort()).toEqual([
        "t1",
        "t2",
      ]);
      expect(workerHosting("t1").id).toBe(normalWorker.id);
      expect(workerHosting("t1").processKey).toBe(adoptedWorker.processKey);
      expect(isPidAlive(normalWorker.pid)).toBe(true);
      expect(
        exits.filter((exit) => exit.bridgeWorker?.id === normalWorker.id),
      ).toEqual([]);
    },
    ADOPTED_EXIT_DETECTION_TIMEOUT_MS,
  );
});
