import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  events,
  getLatestThreadSequence,
  getNativeTerminalThread,
  getNextThreadPruningPolicy,
  getThread,
  listEvents,
  threadPruningWork,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { threadScope, turnScope } from "@bb/domain";
import {
  hostDaemonServerWsMessageSchema,
  type HostDaemonServerWsMessage,
} from "@bb/host-daemon-contract";
import {
  nativeTerminalLaunchSpecSchema,
  threadResponseSchema,
  threadTimelineResponseSchema,
  type TimelineRow,
} from "@bb/server-contract";
import { runThreadPruningSweep } from "../../src/services/system/thread-pruning-sweep.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import { waitForQueuedCommand } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

const PROVIDER_SESSION = "provider-session-before-archive";
const COMMAND_OUTPUT = "build output line\n".repeat(40);
const ASSISTANT_TEXT = "The build finished cleanly.";
const USER_TEXT = "Run the build";
const TURN_ID = "turn-before-archive";
const FILLER_EVENTS = 220;
const TOKENS = {
  totalTokens: 10,
  inputTokens: 5,
  cachedInputTokens: 0,
  outputTokens: 5,
  reasoningOutputTokens: 0,
};
const SWEEP_LIMITS = {
  elapsedBudgetMs: Number.POSITIVE_INFINITY,
  maxAdvances: 512,
};

const harnesses: TestAppHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
});

interface FakeDaemonSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  sentMessages: string[];
}

interface Fixture {
  environment: ReturnType<typeof seedEnvironment>;
  harness: TestAppHarness;
  hostId: string;
  projectId: string;
  sessionId: string;
  socket: FakeDaemonSocket;
}

function createFakeDaemonSocket(): FakeDaemonSocket {
  const sentMessages: string[] = [];
  return {
    close: vi.fn(),
    send: vi.fn((data: string) => {
      sentMessages.push(data);
    }),
    sentMessages,
  };
}

async function createFixture(options: {
  liveDaemon: boolean;
}): Promise<Fixture> {
  const db = createMigratedConnection();
  const harness = await createTestAppHarness({ db });
  harnesses.push(harness);
  const { host, session } = seedHostSession(harness.deps, {
    id: "resume-host",
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/resume-project",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    path: "/tmp/resume-workspace",
    projectId: project.id,
    status: "ready",
  });
  const socket = createFakeDaemonSocket();
  if (options.liveDaemon)
    harness.hub.registerDaemon(session.id, host.id, socket);
  return {
    environment,
    harness,
    hostId: host.id,
    projectId: project.id,
    sessionId: session.id,
    socket,
  };
}

function seedCompletedTurnHistory(
  fixture: Fixture,
  args: { providerThreadId: string; sequenceStart: number; threadId: string },
): void {
  const { deps } = fixture.harness;
  const base = {
    environmentId: fixture.environment.id,
    providerThreadId: args.providerThreadId,
    threadId: args.threadId,
  };
  const turn = { ...base, scope: turnScope(TURN_ID) };
  let sequence = args.sequenceStart;
  const next = () => sequence++;
  seedEvent(deps, {
    ...turn,
    sequence: next(),
    type: "turn/started",
    data: {},
  });
  seedEvent(deps, {
    ...turn,
    sequence: next(),
    type: "item/started",
    data: {
      item: {
        type: "commandExecution",
        id: "cmd-build",
        command: "pnpm build",
        cwd: "/tmp",
        status: "pending",
        approvalStatus: null,
      },
    },
  });
  for (let index = 0; index < 30; index += 1)
    seedEvent(deps, {
      ...turn,
      sequence: next(),
      type: "item/commandExecution/outputDelta",
      data: { itemId: "cmd-build", delta: `build output line ${index}\n` },
    });
  seedEvent(deps, {
    ...turn,
    sequence: next(),
    type: "item/completed",
    data: {
      item: {
        type: "commandExecution",
        id: "cmd-build",
        command: "pnpm build",
        cwd: "/tmp",
        status: "completed",
        approvalStatus: null,
        exitCode: 0,
        aggregatedOutput: COMMAND_OUTPUT,
      },
    },
  });
  seedEvent(deps, {
    ...turn,
    sequence: next(),
    type: "item/started",
    data: { item: { type: "agentMessage", id: "msg-done", text: "" } },
  });
  for (const delta of ["The build ", "finished ", "cleanly."])
    seedEvent(deps, {
      ...turn,
      sequence: next(),
      type: "item/agentMessage/delta",
      data: { itemId: "msg-done", delta },
    });
  seedEvent(deps, {
    ...turn,
    sequence: next(),
    type: "item/completed",
    data: {
      item: { type: "agentMessage", id: "msg-done", text: ASSISTANT_TEXT },
    },
  });
  for (let index = 0; index < 3; index += 1) {
    seedEvent(deps, {
      ...turn,
      sequence: next(),
      type: "thread/tokenUsage/updated",
      data: {
        tokenUsage: { total: TOKENS, last: TOKENS, modelContextWindow: 200000 },
      },
    });
    seedEvent(deps, {
      ...turn,
      sequence: next(),
      type: "turn/diff/updated",
      data: { diff: `diff --git a/x b/x ${index}` },
    });
  }
  seedEvent(deps, {
    ...turn,
    sequence: next(),
    type: "turn/completed",
    data: { status: "completed" },
  });
  for (let index = 0; index < FILLER_EVENTS; index += 1)
    seedEvent(deps, {
      ...base,
      scope: threadScope(),
      sequence: next(),
      type: "provider/rateLimits/updated",
      data: {
        rateLimits: {
          providerId: "codex",
          status: "allowed",
          kind: "subscription-window",
          windows: [],
          reachedReason: null,
          overageStatus: null,
          overageReason: null,
        },
      },
    });
}

function eventTypeCounts(harness: TestAppHarness, threadId: string) {
  const counts = new Map<string, number>();
  for (const event of listEvents(harness.db, { threadId }))
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  return counts;
}

async function postThread(
  harness: TestAppHarness,
  threadId: string,
  action: "archive-all" | "unarchive",
) {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/${action}`,
    { method: "POST" },
  );
  expect(response.status).toBe(200);
}

async function drainArchivedThread(harness: TestAppHarness, threadId: string) {
  for (let sweeps = 0; sweeps < 20; sweeps += 1) {
    await runThreadPruningSweep(harness.deps, SWEEP_LIMITS);
    const pending = harness.db
      .select()
      .from(threadPruningWork)
      .where(eq(threadPruningWork.threadId, threadId))
      .all();
    if (
      pending.length === 0 &&
      getNextThreadPruningPolicy(harness.db, new Set()) === null
    )
      return;
  }
  throw new Error("Pruning work for the archived thread never drained");
}

function flattenRows(rows: readonly TimelineRow[]): TimelineRow[] {
  return rows.flatMap((row) => [
    row,
    ...flattenRows(
      row.kind === "turn"
        ? (row.children ?? [])
        : row.kind === "work" && row.workKind === "delegation"
          ? (row.childRows ?? [])
          : [],
    ),
  ]);
}

async function expectEarlierTurnsStillReadable(
  harness: TestAppHarness,
  threadId: string,
) {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/timeline?includeNestedRows=true`,
  );
  if (response.status !== 200)
    throw new Error(`timeline ${response.status}: ${await response.text()}`);
  const rows = flattenRows(
    threadTimelineResponseSchema.parse(await readJson(response)).rows,
  );
  const conversation = rows.flatMap((row) =>
    row.kind === "conversation" ? [`${row.role}: ${row.text}`] : [],
  );
  expect(conversation).toContain(`user: ${USER_TEXT}`);
  expect(conversation).toContain(`assistant: ${ASSISTANT_TEXT}`);
  const commandOutputs = rows.flatMap((row) =>
    row.kind === "work" &&
    row.workKind === "command" &&
    row.command === "pnpm build"
      ? [row.output]
      : [],
  );
  expect(commandOutputs).toEqual([COMMAND_OUTPUT]);
}

function expectArchivedPruningRanAndSparedResumeState(
  before: Map<string, number>,
  after: Map<string, number>,
) {
  expect(before.get("item/commandExecution/outputDelta")).toBe(30);
  expect(
    after.get("item/commandExecution/outputDelta") ?? 0,
  ).toBeLessThanOrEqual(1);
  expect(after.get("item/agentMessage/delta") ?? 0).toBeLessThanOrEqual(1);
  expect(after.get("turn/diff/updated") ?? 0).toBe(0);
  expect(after.get("provider/rateLimits/updated") ?? 0).toBeLessThan(
    before.get("provider/rateLimits/updated") ?? 0,
  );
  for (const type of [
    "item/started",
    "item/completed",
    "thread/identity",
    "client/turn/requested",
    "turn/started",
    "turn/completed",
  ])
    expect(after.get(type), type).toBe(before.get(type));
}

interface ChatResumeArgs {
  afterDrain?: (harness: TestAppHarness, threadId: string) => void;
  fixture: Fixture;
  threadId: string;
}

function seedChatThread(fixture: Fixture) {
  const thread = seedThread(fixture.harness.deps, {
    environmentId: fixture.environment.id,
    projectId: fixture.projectId,
    status: "idle",
  });
  seedThreadRuntimeState(fixture.harness.deps, {
    environmentId: fixture.environment.id,
    inputText: USER_TEXT,
    providerThreadId: PROVIDER_SESSION,
    threadId: thread.id,
  });
  seedCompletedTurnHistory(fixture, {
    providerThreadId: PROVIDER_SESSION,
    sequenceStart: 10,
    threadId: thread.id,
  });
  return thread;
}

async function archiveDrainUnarchiveAndSendToChatThread(args: ChatResumeArgs) {
  const { fixture, threadId } = args;
  const { harness } = fixture;
  await expectEarlierTurnsStillReadable(harness, threadId);
  const before = eventTypeCounts(harness, threadId);
  await postThread(harness, threadId, "archive-all");
  await drainArchivedThread(harness, threadId);
  expectArchivedPruningRanAndSparedResumeState(
    before,
    eventTypeCounts(harness, threadId),
  );
  args.afterDrain?.(harness, threadId);
  await postThread(harness, threadId, "unarchive");
  const thread = getThread(harness.db, threadId);
  if (!thread) throw new Error("Thread vanished");
  await sendThreadMessage(harness.deps, {
    environment: fixture.environment,
    payload: {
      input: textInput("continue after the archive"),
      mode: "start",
      model: "gpt-5",
      permissionMode: "full",
      reasoningLevel: "medium",
      serviceTier: "default",
    },
    thread,
    trigger: "user",
  });
  const queued = await waitForQueuedCommand(
    harness,
    (candidate) =>
      candidate.command.type === "turn.submit" &&
      candidate.command.threadId === threadId,
  );
  expect(queued.command).toMatchObject({
    type: "turn.submit",
    resumeContext: { providerThreadId: PROVIDER_SESSION },
  });
  await expectEarlierTurnsStillReadable(harness, threadId);
}

function deleteStoredEvents(
  harness: TestAppHarness,
  threadId: string,
  type: string,
) {
  const rows = harness.db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.threadId, threadId))
    .all();
  expect(rows.length).toBeGreaterThan(0);
  harness.db.$client
    .prepare("DELETE FROM events WHERE thread_id = ? AND type = ?")
    .run(threadId, type);
}

describe("an archived chat thread after its pruning work has drained", () => {
  it("resumes into the same provider session and still shows the earlier turns", async () => {
    const fixture = await createFixture({ liveDaemon: false });
    const thread = seedChatThread(fixture);
    await archiveDrainUnarchiveAndSendToChatThread({
      fixture,
      threadId: thread.id,
    });
  });

  it("fails when the provider-thread-id event is lost", async () => {
    const fixture = await createFixture({ liveDaemon: false });
    const thread = seedChatThread(fixture);
    await expect(
      archiveDrainUnarchiveAndSendToChatThread({
        afterDrain: (harness, threadId) =>
          deleteStoredEvents(harness, threadId, "thread/identity"),
        fixture,
        threadId: thread.id,
      }),
    ).rejects.toThrow("Timed out waiting for queued command");
  });

  it("fails when an earlier item/completed is lost", async () => {
    const fixture = await createFixture({ liveDaemon: false });
    const thread = seedChatThread(fixture);
    await expect(
      archiveDrainUnarchiveAndSendToChatThread({
        afterDrain: (harness, threadId) =>
          deleteStoredEvents(harness, threadId, "item/completed"),
        fixture,
        threadId: thread.id,
      }),
    ).rejects.toThrow("to include 'assistant: The build finished cleanly.'");
  });
});

type TerminalOpenMessage = Extract<
  HostDaemonServerWsMessage,
  { type: "terminal.open" }
>;

function daemonMessages(socket: FakeDaemonSocket): HostDaemonServerWsMessage[] {
  return socket.sentMessages.map((message) =>
    hostDaemonServerWsMessageSchema.parse(JSON.parse(message)),
  );
}

async function waitForTerminalOpen(
  socket: FakeDaemonSocket,
  skip: number,
): Promise<TerminalOpenMessage> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const open = daemonMessages(socket).filter(
      (message): message is TerminalOpenMessage =>
        message.type === "terminal.open",
    )[skip];
    if (open !== undefined) return open;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for terminal.open");
}

function acknowledgeOpen(fixture: Fixture, open: TerminalOpenMessage): void {
  fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
    hostId: fixture.hostId,
    sessionId: fixture.sessionId,
    message: {
      type: "terminal.opened",
      requestId: open.requestId,
      terminalId: open.terminalId,
      shell: "/bin/zsh",
      title: "zsh",
      initialCwd: "/tmp/resume-workspace",
      cols: open.cols,
      rows: open.rows,
    },
  });
}

async function postJson(fixture: Fixture, path: string, body: unknown) {
  return fixture.harness.app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitForThreadStatus(
  fixture: Fixture,
  threadId: string,
  status: string,
) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (getThread(fixture.harness.db, threadId)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Thread ${threadId} never reached ${status}`);
}

function composerScreen(pasted: string): string {
  const words = pasted.split(" ");
  return `\u001b[2K\u001b[1G\u203a ${words.join("\u001b[1C")}\u001b[0m`;
}

function startComposerCli(fixture: Fixture, terminalId: string) {
  const output: { seq: number; dataBase64: string }[] = [];
  let nextSeq = 7;
  let handled = 0;
  const draw = (text: string) => {
    output.push({
      seq: nextSeq,
      dataBase64: Buffer.from(text, "utf8").toString("base64"),
    });
    nextSeq += 1;
  };
  const timer = setInterval(() => {
    const messages = daemonMessages(fixture.socket);
    for (const message of messages.slice(handled)) {
      if (
        message.type === "terminal.input" &&
        message.terminalId === terminalId
      ) {
        const text = Buffer.from(message.dataBase64, "base64").toString("utf8");
        const match = /^\u001b\[200~([\s\S]*)\u001b\[201~$/u.exec(text);
        if (match !== null) draw(composerScreen(match[1] ?? ""));
      }
      if (
        message.type === "terminal.attach" &&
        message.terminalId === terminalId
      )
        fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
          hostId: fixture.hostId,
          sessionId: fixture.sessionId,
          message: {
            type: "terminal.replay",
            requestId: message.requestId,
            terminalId,
            chunks: output.filter((chunk) => chunk.seq >= message.sinceSeq),
            replayStartSeq: message.sinceSeq,
            nextSeq,
          },
        });
    }
    handled = messages.length;
  }, 5);
  return {
    inputs: () =>
      daemonMessages(fixture.socket).flatMap((message) =>
        message.type === "terminal.input" && message.terminalId === terminalId
          ? [Buffer.from(message.dataBase64, "base64").toString("utf8")]
          : [],
      ),
    stop: () => clearInterval(timer),
  };
}

async function archiveDrainUnarchiveAndSendToNativeThread(args: {
  afterDrain?: (harness: TestAppHarness, threadId: string) => void;
  fixture: Fixture;
}) {
  const { fixture } = args;
  const { harness } = fixture;
  seedPrimaryHost(harness.deps, fixture.hostId);
  const created = threadResponseSchema.parse(
    await readJson(
      await postJson(fixture, "/threads", {
        projectId: fixture.projectId,
        providerId: "claude-code",
        origin: "cli",
        input: [],
        environment: { type: "reuse", environmentId: fixture.environment.id },
        nativeTerminal: true,
      }),
    ),
  );
  const firstOpen = await waitForTerminalOpen(fixture.socket, 0);
  acknowledgeOpen(fixture, firstOpen);
  await waitForThreadStatus(fixture, created.id, "idle");
  const nativeSessionId = getNativeTerminalThread(
    harness.db,
    created.id,
  )?.nativeSessionId;
  if (!nativeSessionId) throw new Error("Native thread has no session id");
  seedThreadRuntimeState(harness.deps, {
    environmentId: fixture.environment.id,
    inputText: USER_TEXT,
    providerThreadId: nativeSessionId,
    sequenceStart:
      getLatestThreadSequence(harness.db, { threadId: created.id }) + 1,
    threadId: created.id,
  });
  seedCompletedTurnHistory(fixture, {
    providerThreadId: nativeSessionId,
    sequenceStart:
      getLatestThreadSequence(harness.db, { threadId: created.id }) + 1,
    threadId: created.id,
  });
  await expectEarlierTurnsStillReadable(harness, created.id);
  const before = eventTypeCounts(harness, created.id);

  harness.hub.unregisterDaemon(fixture.sessionId);
  await postThread(harness, created.id, "archive-all");
  await drainArchivedThread(harness, created.id);
  expectArchivedPruningRanAndSparedResumeState(
    before,
    eventTypeCounts(harness, created.id),
  );
  args.afterDrain?.(harness, created.id);
  harness.hub.registerDaemon(fixture.sessionId, fixture.hostId, fixture.socket);
  await postThread(harness, created.id, "unarchive");

  const reopen = await waitForTerminalOpen(fixture.socket, 1);
  expect(reopen.threadId).toBe(created.id);
  expect(reopen.start).toMatchObject({
    mode: "command",
    command: expect.not.stringContaining("--reattach"),
  });
  acknowledgeOpen(fixture, reopen);
  await expect
    .poll(() => getNativeTerminalThread(harness.db, created.id))
    .toMatchObject({
      nativeSessionId,
      terminalSessionId: reopen.terminalId,
    });
  const launch = nativeTerminalLaunchSpecSchema.parse(
    await readJson(
      await postJson(
        fixture,
        `/threads/${created.id}/native-terminal/launch`,
        {},
      ),
    ),
  );
  expect(launch.nativeSessionId).toBe(nativeSessionId);

  const cli = startComposerCli(fixture, reopen.terminalId);
  try {
    const response = await postJson(fixture, `/threads/${created.id}/send`, {
      input: textInput("continue after the archive"),
      mode: "auto",
    });
    expect(response.status).toBe(200);
    expect(cli.inputs()).toEqual([
      "\u001b[200~continue after the archive\u001b[201~",
      "\r",
    ]);
  } finally {
    cli.stop();
  }
  await expectEarlierTurnsStillReadable(harness, created.id);
}

describe("an archived native-terminal thread after its pruning work has drained", () => {
  it("reopens into the same native session, accepts a new turn and still shows the earlier turns", async () => {
    await archiveDrainUnarchiveAndSendToNativeThread({
      fixture: await createFixture({ liveDaemon: true }),
    });
  });

  it("fails when an earlier item/completed is lost", async () => {
    await expect(
      archiveDrainUnarchiveAndSendToNativeThread({
        afterDrain: (harness, threadId) =>
          deleteStoredEvents(harness, threadId, "item/completed"),
        fixture: await createFixture({ liveDaemon: true }),
      }),
    ).rejects.toThrow("to include 'assistant: The build finished cleanly.'");
  });
});
