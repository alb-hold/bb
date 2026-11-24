import { Buffer } from "node:buffer";
import {
  createNativeTerminalThread,
  createTerminalSession,
  awaitNativeTerminalSessionStart,
  getNativeTerminalThread,
  getThread,
  setNativeTerminalThreadTerminal,
  setNativeTerminalToolCredential,
} from "@bb/db";
import { createHash } from "node:crypto";
import {
  NATIVE_TERMINAL_SETUP_DELAY_MS,
  threadListEntrySchema,
  withEffectiveDisplayStatus,
} from "@bb/domain";
import { threadResponseSchema } from "@bb/server-contract";
import {
  NATIVE_STATUS_CONTRACT_CASES,
  type NativeStatusContractCase,
} from "@bb/test-helpers";
import { describe, expect, it, vi } from "vitest";
import {
  clearNativeTerminalStateOnExit,
  recordNativeTerminalActivity,
  recordNativeTerminalToolCallEvidence,
} from "../../../src/services/threads/native-terminal-activity.js";
import {
  recordNativeTerminalSession,
  takeNativeTerminalLaunchSpec,
} from "../../../src/services/threads/native-terminal-threads.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

async function withHarness(
  run: (harness: TestAppHarness) => Promise<void>,
): Promise<void> {
  const harness = await createTestAppHarness();
  try {
    await run(harness);
  } finally {
    await harness.cleanup();
  }
}

function seedContractCase(
  harness: TestAppHarness,
  contractCase: NativeStatusContractCase,
) {
  const now = Date.now();
  const { host, session } = seedHostSession(harness.deps, {
    id: `native-status-host-${contractCase.name}-${Math.random().toString(36).slice(2, 8)}`,
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/native-status-${contractCase.name}`,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/native-status-${contractCase.name}/worktree`,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: contractCase.providerId,
    status: contractCase.initialThreadStatus,
  });
  const terminal = createTerminalSession(harness.db, {
    cols: 120,
    daemonSessionId: session.id,
    environmentId: environment.id,
    hostId: host.id,
    initialCwd: environment.path ?? "/tmp/worktree",
    rows: 36,
    status: "running",
    threadId: thread.id,
    title: contractCase.displayName,
  });
  createNativeTerminalThread(harness.db, {
    threadId: thread.id,
    providerId: contractCase.providerId,
    nativeSessionId: contractCase.nativeSessionId,
    initialPrompt: null,
    initialImages: [],
    model: null,
  });
  setNativeTerminalThreadTerminal(harness.db, {
    threadId: thread.id,
    terminalSessionId: terminal.id,
  });
  if (contractCase.awaitingSessionStart) {
    awaitNativeTerminalSessionStart(harness.db, {
      threadId: thread.id,
      terminalSessionId: terminal.id,
    });
  }
  const createdAt = now - contractCase.terminalAgeMs;
  harness.db.$client
    .prepare(
      `UPDATE terminal_sessions
       SET status = ?, close_reason = ?, exit_code = ?, created_at = ?, updated_at = ?, last_user_input_at = NULL
       WHERE id = ?`,
    )
    .run(
      contractCase.terminalStatus,
      contractCase.terminalCloseReason,
      contractCase.terminalExitCode,
      createdAt,
      createdAt,
      terminal.id,
    );
  harness.db.$client
    .prepare(
      "UPDATE threads SET last_read_at = ?, latest_attention_at = ? WHERE id = ?",
    )
    .run(now + 60_000, now - 60_000, thread.id);
  return {
    createdAt,
    environmentId: environment.id,
    hostId: host.id,
    sessionId: session.id,
    threadId: thread.id,
    terminalId: terminal.id,
  };
}

describe("V5 server: shared native terminal status contract", () => {
  it.each(NATIVE_STATUS_CONTRACT_CASES)(
    "serves consistent API detail and list runtime for $name",
    async (contractCase) => {
      await withHarness(async (harness) => {
        const { threadId } = seedContractCase(harness, contractCase);

        const detailResponse = await harness.app.request(
          `/api/v1/threads/${threadId}`,
        );
        expect(detailResponse.status).toBe(200);
        const detail = threadResponseSchema.parse(await detailResponse.json());
        const cliDetail = withEffectiveDisplayStatus(detail);

        expect(detail.status).toBe(contractCase.expectedStatus);
        expect(detail.runtime).toEqual(contractCase.expectedRuntime);
        expect(cliDetail.status).toBe(contractCase.expectedStatus);
        expect(cliDetail.runtime).toEqual(contractCase.expectedRuntime);

        const listResponse = await harness.app.request(
          `/api/v1/threads?threadIds=${threadId}`,
        );
        expect(listResponse.status).toBe(200);
        const list = (await listResponse.json()).map((row: unknown) =>
          threadListEntrySchema.parse(row),
        );
        const listEntry = list.find(
          (entry: { id: string }) => entry.id === threadId,
        );
        expect(listEntry).toBeDefined();
        expect(listEntry?.status).toBe(contractCase.expectedStatus);
        expect(listEntry?.runtime).toEqual(contractCase.expectedRuntime);
        expect(listEntry?.listIndicator).toBe(
          contractCase.expectedListIndicator,
        );
        expect(getThread(harness.db, threadId)?.status).toBe(
          contractCase.expectedStatus,
        );
      });
    },
  );

  it("clears a pre-assigned session's Needs input when the started signal arrives, and only then", async () => {
    await withHarness(async (harness) => {
      const awaitingCase = NATIVE_STATUS_CONTRACT_CASES.find(
        (entry) => entry.name === "preassigned-awaiting-start",
      )!;
      const { threadId, terminalId } = seedContractCase(harness, awaitingCase);
      const read = async () =>
        threadResponseSchema.parse(
          await (
            await harness.app.request(`/api/v1/threads/${threadId}`)
          ).json(),
        );
      expect((await read()).runtime.nativeSetupWaiting).toBe(true);

      const secret = "test-native-credential-token";
      setNativeTerminalToolCredential(harness.db, {
        threadId,
        terminalSessionId: terminalId,
        credentialHash: createHash("sha256").update(secret).digest("hex"),
      });
      const notifySpy = vi.spyOn(harness.deps.hub, "notifyThread");
      recordNativeTerminalSession(harness.deps, {
        authorization: `Bearer ${secret}`,
        nativeSessionId: awaitingCase.nativeSessionId!,
        threadId,
      });
      expect(notifySpy).toHaveBeenCalledWith(threadId, [
        "terminals-changed",
        "status-changed",
      ]);
      expect((await read()).runtime.nativeSetupWaiting).toBeUndefined();
    });
  });

  it("clears a pre-assigned session's Needs input when the session id is rebound", async () => {
    await withHarness(async (harness) => {
      const awaitingCase = NATIVE_STATUS_CONTRACT_CASES.find(
        (entry) => entry.name === "preassigned-awaiting-start",
      )!;
      const { threadId, terminalId } = seedContractCase(harness, awaitingCase);
      const read = async () =>
        threadResponseSchema.parse(
          await (
            await harness.app.request(`/api/v1/threads/${threadId}`)
          ).json(),
        );
      expect((await read()).runtime.nativeSetupWaiting).toBe(true);

      const secret = "test-native-rebind-credential";
      setNativeTerminalToolCredential(harness.db, {
        threadId,
        terminalSessionId: terminalId,
        credentialHash: createHash("sha256").update(secret).digest("hex"),
      });
      const notifySpy = vi.spyOn(harness.deps.hub, "notifyThread");
      recordNativeTerminalSession(harness.deps, {
        authorization: `Bearer ${secret}`,
        nativeSessionId: "claude-rotated-session",
        replacesNativeSessionId: awaitingCase.nativeSessionId!,
        threadId,
      });
      expect(notifySpy).toHaveBeenCalledWith(threadId, [
        "terminals-changed",
        "status-changed",
      ]);
      expect(
        getNativeTerminalThread(harness.db, threadId)?.awaitingSessionStart,
      ).toBe(false);
      expect((await read()).runtime.nativeSetupWaiting).toBeUndefined();
    });
  });

  it("clears Needs input on holder activity evidence without SessionStart and stays cleared after returning to idle", async () => {
    await withHarness(async (harness) => {
      const awaitingCase = NATIVE_STATUS_CONTRACT_CASES.find(
        (entry) => entry.name === "preassigned-awaiting-start",
      )!;
      const { threadId, terminalId } = seedContractCase(harness, awaitingCase);
      const read = async () =>
        threadResponseSchema.parse(
          await (
            await harness.app.request(`/api/v1/threads/${threadId}`)
          ).json(),
        );
      expect((await read()).runtime.nativeSetupWaiting).toBe(true);

      const secret = "test-native-activity-credential";
      setNativeTerminalToolCredential(harness.db, {
        threadId,
        terminalSessionId: terminalId,
        credentialHash: createHash("sha256").update(secret).digest("hex"),
      });
      const notifySpy = vi.spyOn(harness.deps.hub, "notifyThread");
      recordNativeTerminalActivity(harness.deps, {
        authorization: `Bearer ${secret}`,
        confirms: true,
        state: "working",
        threadId,
      });
      expect(
        getNativeTerminalThread(harness.db, threadId)?.awaitingSessionStart,
      ).toBe(false);
      expect(notifySpy).toHaveBeenCalledWith(
        threadId,
        ["status-changed"],
        expect.anything(),
      );

      recordNativeTerminalActivity(harness.deps, {
        authorization: `Bearer ${secret}`,
        confirms: true,
        state: "idle",
        threadId,
      });
      const afterIdle = await read();
      expect(afterIdle.status).toBe("idle");
      expect(afterIdle.runtime.nativeSetupWaiting).toBeUndefined();
    });
  });

  it("clears Needs input on tool-call evidence without SessionStart", async () => {
    await withHarness(async (harness) => {
      const awaitingCase = NATIVE_STATUS_CONTRACT_CASES.find(
        (entry) => entry.name === "preassigned-awaiting-start",
      )!;
      const { threadId, terminalId } = seedContractCase(harness, awaitingCase);
      const read = async () =>
        threadResponseSchema.parse(
          await (
            await harness.app.request(`/api/v1/threads/${threadId}`)
          ).json(),
        );
      expect((await read()).runtime.nativeSetupWaiting).toBe(true);

      const notifySpy = vi.spyOn(harness.deps.hub, "notifyThread");
      recordNativeTerminalToolCallEvidence(harness.deps, {
        terminalSessionId: terminalId,
        threadId,
      });
      expect(notifySpy).toHaveBeenCalledWith(
        threadId,
        ["status-changed"],
        expect.anything(),
      );
      expect(
        getNativeTerminalThread(harness.db, threadId)?.awaitingSessionStart,
      ).toBe(false);
      expect((await read()).runtime.nativeSetupWaiting).toBeUndefined();
    });
  });

  it("clears Needs input on post-launch transcript evidence without SessionStart, and keeps it for pre-launch transcript records", async () => {
    await withHarness(async (harness) => {
      const awaitingCase = NATIVE_STATUS_CONTRACT_CASES.find(
        (entry) => entry.name === "preassigned-awaiting-start",
      )!;
      const { createdAt, threadId } = seedContractCase(harness, awaitingCase);

      const staleTranscript = JSON.stringify({
        type: "system",
        subtype: "stop_hook_summary",
        hasOutput: false,
        isSidechain: false,
        timestamp: new Date(createdAt - 60_000).toISOString(),
      });
      const staleResponsePromise = harness.app.request(
        `/api/v1/threads/${threadId}`,
      );
      const staleQueued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "native_terminal.read_transcript_tail",
      );
      await reportQueuedCommandSuccess(harness, staleQueued, {
        outcome: "available",
        contentBase64: Buffer.from(staleTranscript).toString("base64"),
        sizeBytes: Buffer.byteLength(staleTranscript),
        truncated: false,
      });
      const staleBody = threadResponseSchema.parse(
        await (await staleResponsePromise).json(),
      );
      expect(
        getNativeTerminalThread(harness.db, threadId)?.awaitingSessionStart,
      ).toBe(true);
      expect(staleBody.runtime.nativeSetupWaiting).toBe(true);

      const freshCase = seedContractCase(harness, {
        ...awaitingCase,
        nativeSessionId: "claude-preassigned-fresh-transcript",
      });
      const freshTranscript = JSON.stringify({
        type: "system",
        subtype: "stop_hook_summary",
        hasOutput: false,
        isSidechain: false,
        timestamp: new Date(freshCase.createdAt + 1_000).toISOString(),
      });
      const freshResponsePromise = harness.app.request(
        `/api/v1/threads/${freshCase.threadId}`,
      );
      const freshQueued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "native_terminal.read_transcript_tail" &&
          command.sessionId === "claude-preassigned-fresh-transcript",
      );
      await reportQueuedCommandSuccess(harness, freshQueued, {
        outcome: "available",
        contentBase64: Buffer.from(freshTranscript).toString("base64"),
        sizeBytes: Buffer.byteLength(freshTranscript),
        truncated: false,
      });
      const freshBody = threadResponseSchema.parse(
        await (await freshResponsePromise).json(),
      );
      expect(
        getNativeTerminalThread(harness.db, freshCase.threadId)
          ?.awaitingSessionStart,
      ).toBe(false);
      expect(freshBody.runtime.nativeSetupWaiting).toBeUndefined();
    });
  });

  it("does not leave Needs input after terminal replacement or terminal exit", async () => {
    await withHarness(async (harness) => {
      const awaitingCase = NATIVE_STATUS_CONTRACT_CASES.find(
        (entry) => entry.name === "preassigned-awaiting-start",
      )!;
      const { environmentId, hostId, sessionId, threadId, terminalId } =
        seedContractCase(harness, awaitingCase);
      const read = async () =>
        threadResponseSchema.parse(
          await (
            await harness.app.request(`/api/v1/threads/${threadId}`)
          ).json(),
        );
      expect((await read()).runtime.nativeSetupWaiting).toBe(true);

      const replacement = createTerminalSession(harness.db, {
        cols: 120,
        daemonSessionId: sessionId,
        environmentId,
        hostId,
        initialCwd: "/tmp/worktree",
        rows: 36,
        status: "running",
        threadId,
        title: awaitingCase.displayName,
      });
      const oldCreatedAt = Date.now() - awaitingCase.terminalAgeMs;
      harness.db.$client
        .prepare(
          "UPDATE terminal_sessions SET created_at = ?, updated_at = ?, last_user_input_at = NULL WHERE id = ?",
        )
        .run(oldCreatedAt, oldCreatedAt, replacement.id);
      setNativeTerminalThreadTerminal(harness.db, {
        threadId,
        terminalSessionId: replacement.id,
      });
      expect(
        getNativeTerminalThread(harness.db, threadId)?.awaitingSessionStart,
      ).toBe(false);
      expect((await read()).runtime.nativeSetupWaiting).toBeUndefined();

      awaitNativeTerminalSessionStart(harness.db, {
        threadId,
        terminalSessionId: replacement.id,
      });
      expect((await read()).runtime.nativeSetupWaiting).toBe(true);

      harness.db.$client
        .prepare(
          "UPDATE terminal_sessions SET status = 'exited', close_reason = 'process-exit', exit_code = 0 WHERE id = ?",
        )
        .run(replacement.id);
      clearNativeTerminalStateOnExit(harness.deps, {
        closeReason: "process-exit",
        id: replacement.id,
        threadId,
      });
      expect(
        getNativeTerminalThread(harness.db, threadId)?.awaitingSessionStart,
      ).toBe(false);
      const afterExit = await read();
      expect(afterExit.runtime.nativeSetupWaiting).toBeUndefined();
      expect(afterExit.runtime.nativeSessionExit).toBe("clean");
      expect(terminalId).not.toBe(replacement.id);
    });
  });

  it.each([
    { reportsSessionStart: true, expected: true },
    { reportsSessionStart: false, expected: undefined },
  ])(
    "arms the started-signal wait from the launch request (reportsSessionStart=$reportsSessionStart)",
    async ({ reportsSessionStart, expected }) => {
      await withHarness(async (harness) => {
        const awaitingCase = NATIVE_STATUS_CONTRACT_CASES.find(
          (entry) => entry.name === "preassigned-awaiting-start",
        )!;
        const { threadId } = seedContractCase(harness, {
          ...awaitingCase,
          awaitingSessionStart: false,
        });
        takeNativeTerminalLaunchSpec(harness.deps, {
          imagesAsArgv: true,
          reportsSessionStart,
          threadId,
        });
        const response = threadResponseSchema.parse(
          await (
            await harness.app.request(`/api/v1/threads/${threadId}`)
          ).json(),
        );
        expect(response.runtime.nativeSetupWaiting).toBe(expected);
      });
    },
  );

  it("does not hold a holder that never asked for the started signal in Needs input", async () => {
    await withHarness(async (harness) => {
      const awaitingCase = NATIVE_STATUS_CONTRACT_CASES.find(
        (entry) => entry.name === "preassigned-awaiting-start",
      )!;
      const { threadId } = seedContractCase(harness, {
        ...awaitingCase,
        awaitingSessionStart: false,
      });
      const response = threadResponseSchema.parse(
        await (await harness.app.request(`/api/v1/threads/${threadId}`)).json(),
      );
      expect(response.runtime.nativeSetupWaiting).toBeUndefined();
    });
  });

  it("clears server nativeSetupWaiting on user input and session binding and notifies status-changed", async () => {
    await withHarness(async (harness) => {
      const setupCase = NATIVE_STATUS_CONTRACT_CASES.find(
        (entry) => entry.name === "setup-wait",
      )!;
      const { threadId, terminalId } = seedContractCase(harness, setupCase);
      const before = threadResponseSchema.parse(
        await (await harness.app.request(`/api/v1/threads/${threadId}`)).json(),
      );
      expect(before.runtime.nativeSetupWaiting).toBe(true);

      const now = Date.now();
      harness.db.$client
        .prepare(
          "UPDATE terminal_sessions SET last_user_input_at = ? WHERE id = ?",
        )
        .run(now, terminalId);
      const afterInput = threadResponseSchema.parse(
        await (await harness.app.request(`/api/v1/threads/${threadId}`)).json(),
      );
      expect(afterInput.runtime.nativeSetupWaiting).toBeUndefined();

      harness.db.$client
        .prepare(
          "UPDATE terminal_sessions SET last_user_input_at = ? WHERE id = ?",
        )
        .run(now - NATIVE_TERMINAL_SETUP_DELAY_MS - 1_000, terminalId);
      const waitingAgain = threadResponseSchema.parse(
        await (await harness.app.request(`/api/v1/threads/${threadId}`)).json(),
      );
      expect(waitingAgain.runtime.nativeSetupWaiting).toBe(true);

      const secret = "test-native-credential-token";
      setNativeTerminalToolCredential(harness.db, {
        threadId,
        terminalSessionId: terminalId,
        credentialHash: createHash("sha256").update(secret).digest("hex"),
      });
      const notifySpy = vi.spyOn(harness.deps.hub, "notifyThread");
      recordNativeTerminalSession(harness.deps, {
        authorization: `Bearer ${secret}`,
        nativeSessionId: "codex-session-bound",
        threadId,
      });
      expect(notifySpy).toHaveBeenCalledWith(threadId, [
        "terminals-changed",
        "status-changed",
      ]);

      const afterBind = threadResponseSchema.parse(
        await (await harness.app.request(`/api/v1/threads/${threadId}`)).json(),
      );
      expect(afterBind.runtime.nativeSetupWaiting).toBeUndefined();
    });
  });
});
