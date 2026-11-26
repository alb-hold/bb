import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import {
  bridgeCapabilitiesSchema,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
} from "@bb/provider-bridge-protocol";
import { BRIDGE_SOCKET_TRANSPORT_VERSION } from "@bb/provider-bridge-protocol/bridge-kit";
import {
  BRIDGE_WORKER_REGISTRY_FORMAT_VERSION,
  readBridgeWorkerEntries,
  readProcessIdentityAsync,
  writeBridgeWorkerEntry,
  type BridgeWorkerRegistryEntry,
} from "./bridge-worker-registry.js";
import { allocateBridgeWorkerPaths } from "./bridge-worker-socket.js";
import { promptTextInput } from "./test/prompt-input.js";
import {
  createScriptedEchoLaunch,
  createScriptedEchoProcessLog,
  createScriptedEchoRuntime,
  type LaunchBoundAgentRuntime,
  fullRuntimeOptions,
  scriptedEchoBridgeModulePath,
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

const LEGACY_V2_WORKER_SOURCE = `
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";

const [modulePath, pluginId, dataDir, socketPath] = process.argv.slice(2);
let current = null;
let resumed = false;
let nextWseq = 1;
const frames = [];

function writeFrame(line) {
  const wseq = nextWseq++;
  const raw = \`\${wseq}\\t\${line}\\n\`;
  frames.push({ wseq, raw });
  if (current && resumed && current.writable) {
    current.write(raw);
  }
}

process.stdout.write = (chunk) => {
  const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  for (const line of text.split("\\n")) {
    if (line.length > 0) writeFrame(line);
  }
  return true;
};

const mod = await import(pathToFileURL(modulePath).href);
const bridge = mod.experimental_providerBridge;
bridge.start?.({ pluginId, dataDir, tempDir: dataDir });

const server = createServer((socket) => {
  if (current) current.destroy();
  current = socket;
  resumed = false;
  let buf = "";
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx = buf.indexOf("\\n");
    while (idx !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      idx = buf.indexOf("\\n");
      if (!line) continue;
      let parsed = null;
      try { parsed = JSON.parse(line); } catch {}
      if (parsed && parsed.method === "bridge/shutdown") {
        server.close();
        bridge.onClose?.();
        process.exit(0);
      }
      if (parsed && parsed.method === "bridge/resume") {
        const afterWseq = parsed.params?.afterWseq ?? 0;
        for (const f of frames) {
          if (f.wseq > afterWseq) socket.write(f.raw);
        }
        resumed = true;
        continue;
      }
      if (parsed && parsed.method === "bridge/ack") {
        const through = parsed.params?.through ?? 0;
        const keep = new Set(parsed.params?.keep ?? []);
        for (let i = frames.length - 1; i >= 0; i -= 1) {
          if (frames[i].wseq <= through && !keep.has(frames[i].wseq)) {
            frames.splice(i, 1);
          }
        }
        continue;
      }
      bridge.handleLine(line);
    }
  });
});

server.listen(socketPath);
`;

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

  function createRuntime(
    events: ThreadEvent[],
    extraEnv?: Record<string, string>,
  ): LaunchBoundAgentRuntime {
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath,
        bridgeWorkers,
        env: { ...env, ...extraEnv },
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

  async function startPreSwapThread(
    events: ThreadEvent[],
    extraEnv?: Record<string, string>,
  ) {
    const before = createRuntime(events, extraEnv);
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

  function mutateStoredThreadEntry(
    mutator: (thread: Record<string, unknown>) => void,
  ): void {
    const [entry] = readBridgeWorkerEntries(bridgeWorkers.dir).entries;
    if (entry === undefined) throw new Error("no registered worker");
    const rawThread = { ...entry.threads.t1 } as Record<string, unknown>;
    mutator(rawThread);
    writeBridgeWorkerEntry(bridgeWorkers.dir, {
      ...entry,
      threads: { t1: rawThread as BridgeWorkerRegistryEntry["threads"][string] },
    });
  }

  async function spawnLegacyUnansweredWorker(args: {
    pluginId: string;
    providerId?: string;
    transportVersion?: number;
    openBackgroundWorkCount?: number;
  }): Promise<{ pid: number; providerThreadId: string }> {
    const providerId = args.providerId ?? PROVIDER_ID;
    const scriptPath = join(root, `legacy-worker-${args.pluginId}.mjs`);
    writeFileSync(scriptPath, LEGACY_V2_WORKER_SOURCE, "utf8");
    const launch = createScriptedEchoLaunch({ pluginId: args.pluginId });
    const paths = allocateBridgeWorkerPaths(bridgeWorkers.dir);
    const child = spawn(
      process.execPath,
      [scriptPath, scriptedEchoBridgeModulePath, args.pluginId, launch.dataDir, paths.socketPath],
      {
        cwd: workspacePath,
        detached: true,
        env: { ...process.env, ...env },
        stdio: "ignore",
      },
    );
    child.unref();
    const pid = child.pid;
    if (pid === undefined) throw new Error("legacy worker did not spawn");
    startedPids.add(pid);

    await waitForRuntimeState({
      label: "legacy worker socket listening",
      predicate: () => existsSync(paths.socketPath),
      timeoutMs: WORKER_EXIT_TIMEOUT_MS,
    });

    const providerThreadId = await new Promise<string>((resolve, reject) => {
      const sock = connect(paths.socketPath);
      let buf = "";
      sock.on("error", reject);
      sock.on("connect", () => {
        sock.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "bridge/resume", params: { afterWseq: 0 } })}\n`,
        );
        sock.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
              client: { name: "test", version: "0.0.1" },
              grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
            },
          })}\n`,
        );
        sock.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "thread/start",
            params: {
              threadId: "t1",
              cwd: workspacePath,
              instructionMode: "append",
              options: {
                model: fullRuntimeOptions.model,
                serviceTier: fullRuntimeOptions.serviceTier,
                reasoningLevel: fullRuntimeOptions.reasoningLevel,
                providerOptions: {},
                permissionMode: fullRuntimeOptions.permissionMode,
                permissionScope: fullRuntimeOptions.permissionScope,
                approvalReviewer: null,
                permissionEscalation: null,
              },
            },
          })}\n`,
        );
      });
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let idx = buf.indexOf("\n");
        while (idx !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          idx = buf.indexOf("\n");
          const tab = raw.indexOf("\t");
          if (tab <= 0) continue;
          const wseq = Number(raw.slice(0, tab));
          const msg = JSON.parse(raw.slice(tab + 1)) as {
            id?: number;
            result?: { providerThreadId?: string };
          };
          if (msg.id === 2 && msg.result?.providerThreadId) {
            sock.write(
              `${JSON.stringify({ jsonrpc: "2.0", method: "bridge/ack", params: { through: wseq, keep: [] } })}\n`,
            );
            const found = msg.result.providerThreadId;
            setTimeout(() => {
              sock.destroy();
              resolve(found);
            }, 25);
          }
        }
      });
    });

    const processIdentity = await readProcessIdentityAsync(pid);
    if (processIdentity === null) {
      throw new Error("legacy worker exited before registration");
    }

    const entry: BridgeWorkerRegistryEntry = {
      id: paths.id,
      formatVersion: BRIDGE_WORKER_REGISTRY_FORMAT_VERSION,
      pid,
      processIdentity,
      socketPath: paths.socketPath,
      pluginId: args.pluginId,
      providerId,
      processKey: `${providerId}:${args.pluginId}`,
      environmentId: bridgeWorkers.environmentId,
      bridgeProtocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      transportVersion: args.transportVersion ?? 2,
      capabilities: bridgeCapabilitiesSchema.parse({
        sessionRestore: true,
        threadArchive: true,
        threadRename: true,
        threadGoalClear: true,
        fork: "checkpoint",
        approvalEnforcedBy: "runtime",
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
        steerMode: "inject",
        skills: { configure: true },
      }),
      capabilitiesSource: "negotiated",
      startedAt: new Date().toISOString(),
      workspace: bridgeWorkers.workspace,
      threads: {
        t1: {
          providerThreadId,
          activeTurnId: null,
          activeProviderTurnId: null,
          ...(args.openBackgroundWorkCount === undefined
            ? {}
            : { openBackgroundWorkCount: args.openBackgroundWorkCount }),
          config: {
            bridgeLaunch: launch,
            skillRoots: [],
            contributedEnv: [],
            environmentId: bridgeWorkers.environmentId,
            envVars: {},
            instructionMode: "append",
            options: fullRuntimeOptions,
            processKey: `${providerId}:${args.pluginId}`,
            projectId: "p1",
            providerId,
            sessionRestorable: true,
          },
        },
      },
    };
    writeBridgeWorkerEntry(bridgeWorkers.dir, entry);
    return { pid, providerThreadId };
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

  it("reaps an adopted worker with no open work even when openBackgroundWorkCount is missing from the registry", async () => {
    const events: ThreadEvent[] = [];
    const { worker } = await startPreSwapThread(events);
    mutateStoredThreadEntry((thread) => {
      delete thread.openBackgroundWorkCount;
    });

    const after = createRuntime(events);
    adoptAll(after);

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
  }, WORKER_EXIT_TIMEOUT_MS);

  it.each([
    { label: "backgroundTask", prompt: "bg_task", clientRequestId: "creq_adptt4444c" },
    { label: "background delegation", prompt: "bg_delegation", clientRequestId: "creq_adptt4444d" },
  ])(
    "never reaps an adopted worker that reports open $label at adoption even if the registry says 0",
    async ({ prompt, clientRequestId }) => {
      const events: ThreadEvent[] = [];
      const before = createRuntime(events);
      await before.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: PROVIDER_ID,
        options: fullRuntimeOptions,
      });
      const [worker] = trackWorkers();
      if (worker === undefined) throw new Error("no registered worker");
      await before.runTurn({
        clientRequestId,
        threadId: "t1",
        input: [promptTextInput({ text: prompt })],
        options: fullRuntimeOptions,
      });
      await waitForThreadTurnCompleted({ events, threadId: "t1" });
      expect(before.hasOpenBackgroundWork()).toBe(true);
      await before.detach();

      mutateStoredThreadEntry((thread) => {
        thread.openBackgroundWorkCount = 0;
      });

      const after = createRuntime(events);
      adoptAll(after);
      const result = await after.reapIdleProviderSessions({
        idleForMs: IDLE_FOR_MS,
        nowMs: Date.now() + IDLE_FOR_MS + 60_000,
      });

      expect(result.reapedSessions).toEqual([]);
      expect(after.hasThread("t1")).toBe(true);
      expect(isPidAlive(worker.pid)).toBe(true);
    },
    WORKER_EXIT_TIMEOUT_MS,
  );

  it("reaps an adopted session once background work that was still open at adoption settles, after a fresh idle window", async () => {
    const events: ThreadEvent[] = [];
    const processLog = createScriptedEchoProcessLog();
    const before = createRuntime(events, processLog.env);
    await before.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: PROVIDER_ID,
      options: fullRuntimeOptions,
    });
    const [worker] = trackWorkers();
    if (worker === undefined) throw new Error("no registered worker");
    await before.runTurn({
      clientRequestId: "creq_adptt5555c",
      threadId: "t1",
      input: [promptTextInput({ text: "bg_task_ms:600" })],
      options: fullRuntimeOptions,
    });
    await waitForThreadTurnCompleted({ events, threadId: "t1" });
    expect(before.hasOpenBackgroundWork()).toBe(true);
    await before.detach();

    const after = createRuntime(events, processLog.env);
    adoptAll(after);
    const whileOpen = await after.reapIdleProviderSessions({
      idleForMs: IDLE_FOR_MS,
      nowMs: Date.now() + IDLE_FOR_MS + 60_000,
    });
    expect(whileOpen.reapedSessions).toEqual([]);
    expect(after.hasOpenBackgroundWork()).toBe(true);

    await waitForRuntimeState({
      label: "adopted background work settled on new runtime",
      predicate: () => !after.hasOpenBackgroundWork(),
      timeoutMs: WORKER_EXIT_TIMEOUT_MS,
    });

    const beforeWindow = await after.reapIdleProviderSessions({
      idleForMs: IDLE_FOR_MS,
      nowMs: Date.now() + IDLE_FOR_MS - 5_000,
    });
    expect(beforeWindow.reapedSessions).toEqual([]);

    const afterWindow = await after.reapIdleProviderSessions({
      idleForMs: IDLE_FOR_MS,
      nowMs: Date.now() + IDLE_FOR_MS + 60_000,
    });
    expect(afterWindow.reapedSessions.map((session) => session.threadId)).toEqual([
      "t1",
    ]);
    await waitForRuntimeState({
      label: "adopted worker exited after post-adoption settle reap",
      predicate: () => !isPidAlive(worker.pid),
      timeoutMs: WORKER_EXIT_TIMEOUT_MS,
    });
  }, WORKER_EXIT_TIMEOUT_MS);

  it("stops blocking reaping once work that settled while the daemon was down is reported by the worker", async () => {
    const events: ThreadEvent[] = [];
    const processLog = createScriptedEchoProcessLog();
    const before = createRuntime(events, processLog.env);
    await before.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: PROVIDER_ID,
      options: fullRuntimeOptions,
    });
    const [worker] = trackWorkers();
    if (worker === undefined) throw new Error("no registered worker");
    await before.runTurn({
      clientRequestId: "creq_adptt5555b",
      threadId: "t1",
      input: [promptTextInput({ text: "bg_task_ms:150" })],
      options: fullRuntimeOptions,
    });
    await waitForThreadTurnCompleted({ events, threadId: "t1" });
    expect(before.hasOpenBackgroundWork()).toBe(true);
    await before.detach();

    const [detachedEntry] = readBridgeWorkerEntries(bridgeWorkers.dir).entries;
    expect(detachedEntry?.threads.t1?.openBackgroundWorkCount).toBe(1);

    await waitForRuntimeState({
      label: "background task settled while daemon was detached",
      predicate: () =>
        processLog.read().some((line) => line.startsWith("bg_task/closed:")),
      timeoutMs: WORKER_EXIT_TIMEOUT_MS,
    });

    const after = createRuntime(events, processLog.env);
    adoptAll(after);
    const result = await after.reapIdleProviderSessions({
      idleForMs: IDLE_FOR_MS,
      nowMs: Date.now() + IDLE_FOR_MS + 60_000,
    });

    expect(result.reapedSessions.map((session) => session.threadId)).toEqual([
      "t1",
    ]);
    await waitForRuntimeState({
      label: "adopted worker exited after gap-settled reap",
      predicate: () => !isPidAlive(worker.pid),
      timeoutMs: WORKER_EXIT_TIMEOUT_MS,
    });
  }, WORKER_EXIT_TIMEOUT_MS);

  it.each([
    { label: "legacy transport", transportVersion: 2 },
    { label: "unanswered current transport", transportVersion: BRIDGE_SOCKET_TRANSPORT_VERSION },
  ])(
    "never reaps an old worker ($label) that cannot answer the open-work query",
    async ({ transportVersion }) => {
      const events: ThreadEvent[] = [];
      const { pid } = await spawnLegacyUnansweredWorker({
        pluginId: "provider-scripted-echo",
        transportVersion,
        openBackgroundWorkCount: 0,
      });

      const after = createRuntime(events);
      adoptAll(after);
      const result = await after.reapIdleProviderSessions({
        idleForMs: IDLE_FOR_MS,
        nowMs: Date.now() + IDLE_FOR_MS + 60_000,
      });

      expect(result.reapedSessions).toEqual([]);
      expect(after.hasThread("t1")).toBe(true);
      expect(isPidAlive(pid)).toBe(true);
    },
    WORKER_EXIT_TIMEOUT_MS,
  );

  it.each(["provider-codex", "provider-acp", "provider-pi"])(
    "reaps a legacy %s worker whose adapter never emits background-scoped items",
    async (pluginId) => {
      const events: ThreadEvent[] = [];
      const { pid } = await spawnLegacyUnansweredWorker({
        pluginId,
      });

      const after = createRuntime(events);
      adoptAll(after);
      const result = await after.reapIdleProviderSessions({
        idleForMs: IDLE_FOR_MS,
        nowMs: Date.now() + IDLE_FOR_MS + 60_000,
      });

      expect(result.reapedSessions.map((session) => session.threadId)).toEqual([
        "t1",
      ]);
      await waitForRuntimeState({
        label: `legacy ${pluginId} worker exited after reap`,
        predicate: () => !isPidAlive(pid),
        timeoutMs: WORKER_EXIT_TIMEOUT_MS,
      });
    },
    WORKER_EXIT_TIMEOUT_MS,
  );

  it("never reaps a legacy claude-code worker", async () => {
    const events: ThreadEvent[] = [];
    const { pid } = await spawnLegacyUnansweredWorker({
      pluginId: "provider-claude-code",
      openBackgroundWorkCount: 0,
    });

    const after = createRuntime(events);
    adoptAll(after);
    const result = await after.reapIdleProviderSessions({
      idleForMs: IDLE_FOR_MS,
      nowMs: Date.now() + IDLE_FOR_MS + 60_000,
    });

    expect(result.reapedSessions).toEqual([]);
    expect(after.hasThread("t1")).toBe(true);
    expect(isPidAlive(pid)).toBe(true);
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

  it("never reaps an adopted session whose background command was still running at detach", async () => {
    const events: ThreadEvent[] = [];
    const before = createRuntime(events);
    await before.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: PROVIDER_ID,
      options: fullRuntimeOptions,
    });
    const [worker] = trackWorkers();
    if (worker === undefined) throw new Error("no registered worker");
    await before.runTurn({
      clientRequestId: "creq_adptt4444b",
      threadId: "t1",
      input: [promptTextInput({ text: "bg_task" })],
      options: fullRuntimeOptions,
    });
    await waitForThreadTurnCompleted({ events, threadId: "t1" });
    expect(before.hasOpenBackgroundWork()).toBe(true);
    await before.detach();

    const after = createRuntime(events);
    adoptAll(after);
    const result = await after.reapIdleProviderSessions({
      idleForMs: IDLE_FOR_MS,
      nowMs: Date.now() + IDLE_FOR_MS + 60_000,
    });

    expect(result.reapedSessions).toEqual([]);
    expect(after.hasThread("t1")).toBe(true);
    expect(isPidAlive(worker.pid)).toBe(true);
  }, WORKER_EXIT_TIMEOUT_MS);

  it("keeps blocking reaping across a second restart until the background command settles", async () => {
    const events: ThreadEvent[] = [];
    const first = createRuntime(events);
    await first.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: PROVIDER_ID,
      options: fullRuntimeOptions,
    });
    const [worker] = trackWorkers();
    if (worker === undefined) throw new Error("no registered worker");
    await first.runTurn({
      clientRequestId: "creq_adptt7777b",
      threadId: "t1",
      input: [promptTextInput({ text: "bg_task" })],
      options: fullRuntimeOptions,
    });
    await waitForThreadTurnCompleted({ events, threadId: "t1" });
    await first.detach();

    const second = createRuntime(events);
    adoptAll(second);
    await second.detach();

    const third = createRuntime(events);
    adoptAll(third);
    const result = await third.reapIdleProviderSessions({
      idleForMs: IDLE_FOR_MS,
      nowMs: Date.now() + IDLE_FOR_MS + 60_000,
    });

    expect(result.reapedSessions).toEqual([]);
    expect(isPidAlive(worker.pid)).toBe(true);
  }, WORKER_EXIT_TIMEOUT_MS);

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
