import {
  forgetForwardedTerminalOutputSeq,
  listEvents,
  type DbConnection,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import {
  hostDaemonServerWsMessageSchema,
  type HostDaemonServerWsMessage,
} from "@bb/host-daemon-contract";
import {
  nativeTerminalLaunchSpecSchema,
  nativeTerminalThreadSchema,
  threadResponseSchema,
} from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_TOOL_CREDENTIAL_ENV,
  settlePendingNativeTerminalOpen,
} from "../../src/services/threads/native-terminal-threads.js";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

interface FakeDaemonSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  sentMessages: string[];
}

type TerminalOpenMessage = Extract<
  HostDaemonServerWsMessage,
  { type: "terminal.open" }
>;

const harnesses: TestAppHarness[] = [];
const migratedDbs: DbConnection[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.deps.terminalSessions.flushRetainedOutputBeforeClose();
    await harness.cleanup();
  }
  for (const db of migratedDbs.splice(0)) db.$client.close();
});

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

function daemonMessages(socket: FakeDaemonSocket): HostDaemonServerWsMessage[] {
  return socket.sentMessages.map((message) =>
    hostDaemonServerWsMessageSchema.parse(JSON.parse(message)),
  );
}

async function waitForTerminalOpen(
  socket: FakeDaemonSocket,
): Promise<TerminalOpenMessage> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const open = daemonMessages(socket).find(
      (message): message is TerminalOpenMessage =>
        message.type === "terminal.open",
    );
    if (open !== undefined) return open;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for terminal.open");
}

describe("native terminal thread mirror state", () => {
  it("returns prompt, output state, and final reply from side tables without writing new events", async () => {
    const db = createMigratedConnection();
    migratedDbs.push(db);
    const harness = await createTestAppHarness({ db });
    harnesses.push(harness);

    const seeded = seedHostSession(harness.deps, { id: "mirror-host" });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: seeded.host.id,
      path: "/tmp/mirror-project",
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: seeded.host.id,
      path: "/tmp/mirror-workspace",
      projectId: project.id,
      status: "ready",
    });
    const socket = createFakeDaemonSocket();
    harness.hub.registerDaemon(seeded.session.id, seeded.host.id, socket);

    let sameTickHasOutput: Promise<boolean | undefined> | null = null;
    const terminalChangeNotifications: string[] = [];
    harness.hub.onChangedMessage((message) => {
      if (
        message.entity === "thread" &&
        message.changes.includes("terminals-changed")
      ) {
        terminalChangeNotifications.push(message.id);
        if (sameTickHasOutput === null && message.id === threadIdForListener) {
          sameTickHasOutput = Promise.resolve(
            harness.app.request(`/api/v1/threads/${message.id}/native-terminal`),
          ).then(async (res) =>
            nativeTerminalThreadSchema.parse(await readJson(res)).hasOutput,
          );
        }
      }
    });
    let threadIdForListener: string | null = null;

    const promptText = "Summarize the failing migration in packages/db";
    const createRes = await harness.app.request("/api/v1/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        providerId: "claude-code",
        origin: "cli",
        nativeTerminal: true,
        input: textInput(promptText),
        environment: {
          type: "reuse",
          environmentId: environment.id,
        },
      }),
    });
    expect(createRes.status).toBe(201);
    const thread = threadResponseSchema.parse(await readJson(createRes));

    const open = await waitForTerminalOpen(socket);
    const credential = open.contributedEnv.find(
      (entry) => entry.name === NATIVE_TOOL_CREDENTIAL_ENV,
    )?.value;
    expect(credential).toBeTruthy();

    harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: seeded.host.id,
      sessionId: seeded.session.id,
      message: {
        type: "terminal.opened",
        requestId: open.requestId,
        terminalId: open.terminalId,
        shell: "/bin/zsh",
        title: "Claude Code",
        initialCwd: environment.path ?? "/tmp/mirror-workspace",
        cols: open.cols,
        rows: open.rows,
      },
    });

    const initialViewRes = await harness.app.request(
      `/api/v1/threads/${thread.id}/native-terminal`,
    );
    expect(initialViewRes.status).toBe(200);
    const initialView = nativeTerminalThreadSchema.parse(
      await readJson(initialViewRes),
    );
    expect(initialView.prompt).toBe(promptText);
    expect(initialView.hasOutput).toBe(false);
    expect(initialView.reply).toBeNull();

    const launchRes = await harness.app.request(
      `/api/v1/threads/${thread.id}/native-terminal/launch`,
      { method: "POST" },
    );
    expect(launchRes.status).toBe(200);
    const launchSpec = nativeTerminalLaunchSpecSchema.parse(
      await readJson(launchRes),
    );
    expect(launchSpec.initialPrompt).toBe(promptText);

    const eventsBeforeOutputAndReply = listEvents(db, { threadId: thread.id });

    const afterLaunchRes = await harness.app.request(
      `/api/v1/threads/${thread.id}/native-terminal`,
    );
    expect(afterLaunchRes.status).toBe(200);
    const afterLaunchView = nativeTerminalThreadSchema.parse(
      await readJson(afterLaunchRes),
    );
    expect(afterLaunchView.prompt).toBe(promptText);
    expect(afterLaunchView.hasOutput).toBe(false);
    expect(afterLaunchView.reply).toBeNull();

    terminalChangeNotifications.length = 0;
    threadIdForListener = thread.id;
    harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: seeded.host.id,
      sessionId: seeded.session.id,
      message: {
        type: "terminal.output",
        terminalId: open.terminalId,
        chunk: {
          seq: 0,
          dataBase64: Buffer.from("Claude Code ready\r\n", "utf8").toString(
            "base64",
          ),
        },
      },
    });
    expect(terminalChangeNotifications).toContain(thread.id);
    expect(sameTickHasOutput).not.toBeNull();
    expect(await sameTickHasOutput).toBe(true);
    threadIdForListener = null;

    await harness.deps.terminalSessions.readTerminalScreen({
      terminalId: open.terminalId,
      query: {},
    });
    harness.deps.terminalSessions.flushAllRetainedOutput();
    forgetForwardedTerminalOutputSeq(open.terminalId);

    const afterRestartRes = await harness.app.request(
      `/api/v1/threads/${thread.id}/native-terminal`,
    );
    expect(afterRestartRes.status).toBe(200);
    const afterRestartView = nativeTerminalThreadSchema.parse(
      await readJson(afterRestartRes),
    );
    expect(afterRestartView.prompt).toBe(promptText);
    expect(afterRestartView.hasOutput).toBe(true);
    expect(afterRestartView.reply).toBeNull();

    terminalChangeNotifications.length = 0;
    const replyText = "Found the root cause in **migrate.ts**.\n\n- Fixed column check.";
    const activityRes = await harness.app.request(
      `/api/v1/threads/${thread.id}/native-terminal/activity`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify({
          state: "idle",
          lastAssistantText: replyText,
        }),
      },
    );
    expect(activityRes.status).toBe(200);
    expect(terminalChangeNotifications).toContain(thread.id);

    const afterReplyRes = await harness.app.request(
      `/api/v1/threads/${thread.id}/native-terminal`,
    );
    expect(afterReplyRes.status).toBe(200);
    const afterReplyView = nativeTerminalThreadSchema.parse(
      await readJson(afterReplyRes),
    );
    expect(afterReplyView.prompt).toBe(promptText);
    expect(afterReplyView.hasOutput).toBe(true);
    expect(afterReplyView.reply).toEqual({
      text: replyText,
      recordedAt: expect.any(Number),
    });

    const eventsAfter = listEvents(db, { threadId: thread.id });
    expect(eventsAfter).toEqual(eventsBeforeOutputAndReply);
  });

  it("emits terminals-changed with hasOutput: true in the same tick when first output arrives via terminal replay", async () => {
    const db = createMigratedConnection();
    migratedDbs.push(db);
    const harness = await createTestAppHarness({ db });
    harnesses.push(harness);

    const seeded = seedHostSession(harness.deps, { id: "replay-host" });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: seeded.host.id,
      path: "/tmp/replay-project",
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: seeded.host.id,
      path: "/tmp/replay-workspace",
      projectId: project.id,
      status: "ready",
    });
    const socket = createFakeDaemonSocket();
    harness.hub.registerDaemon(seeded.session.id, seeded.host.id, socket);

    const createRes = await harness.app.request("/api/v1/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        providerId: "claude-code",
        origin: "cli",
        nativeTerminal: true,
        input: textInput("Check replay first output"),
        environment: {
          type: "reuse",
          environmentId: environment.id,
        },
      }),
    });
    expect(createRes.status).toBe(201);
    const thread = threadResponseSchema.parse(await readJson(createRes));

    const open = await waitForTerminalOpen(socket);
    harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: seeded.host.id,
      sessionId: seeded.session.id,
      message: {
        type: "terminal.opened",
        requestId: open.requestId,
        terminalId: open.terminalId,
        shell: "/bin/zsh",
        title: "Claude Code",
        initialCwd: environment.path ?? "/tmp/replay-workspace",
        cols: open.cols,
        rows: open.rows,
      },
    });
    await settlePendingNativeTerminalOpen(thread.id);

    let sameTickHasOutput: Promise<boolean | undefined> | null = null;
    harness.hub.onChangedMessage((message) => {
      if (
        message.entity === "thread" &&
        message.id === thread.id &&
        message.changes.includes("terminals-changed") &&
        sameTickHasOutput === null
      ) {
        sameTickHasOutput = Promise.resolve(
          harness.app.request(`/api/v1/threads/${thread.id}/native-terminal`),
        ).then(async (res) =>
          nativeTerminalThreadSchema.parse(await readJson(res)).hasOutput,
        );
      }
    });

    const browserSocket = {
      close: vi.fn(),
      send: vi.fn(),
    };
    harness.deps.terminalSessions.attachBrowserTerminal({
      terminalId: open.terminalId,
      socket: browserSocket,
      sinceSeq: 0,
      outputAcks: false,
      resizeAcks: false,
    });
    const attach = daemonMessages(socket).find(
      (message) => message.type === "terminal.attach",
    );
    expect(attach).toBeDefined();

    await harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: seeded.host.id,
      sessionId: seeded.session.id,
      message: {
        type: "terminal.replay",
        requestId: attach!.requestId,
        terminalId: open.terminalId,
        replayStartSeq: 0,
        nextSeq: 1,
        chunks: [
          {
            seq: 0,
            dataBase64: Buffer.from("Replayed output\r\n", "utf8").toString(
              "base64",
            ),
          },
        ],
      },
    });

    expect(sameTickHasOutput).not.toBeNull();
    expect(await sameTickHasOutput).toBe(true);
  });

  it("emits terminals-changed with hasOutput: true in the same tick when first output arrives via catch-up replay", async () => {
    const db = createMigratedConnection();
    migratedDbs.push(db);
    const harness = await createTestAppHarness({ db });
    harnesses.push(harness);

    const seeded = seedHostSession(harness.deps, { id: "catchup-host" });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: seeded.host.id,
      path: "/tmp/catchup-project",
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: seeded.host.id,
      path: "/tmp/catchup-workspace",
      projectId: project.id,
      status: "ready",
    });
    const socket = createFakeDaemonSocket();
    harness.hub.registerDaemon(seeded.session.id, seeded.host.id, socket);

    const createRes = await harness.app.request("/api/v1/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        providerId: "claude-code",
        origin: "cli",
        nativeTerminal: true,
        input: textInput("Check catch-up first output"),
        environment: {
          type: "reuse",
          environmentId: environment.id,
        },
      }),
    });
    expect(createRes.status).toBe(201);
    const thread = threadResponseSchema.parse(await readJson(createRes));

    const open = await waitForTerminalOpen(socket);
    harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: seeded.host.id,
      sessionId: seeded.session.id,
      message: {
        type: "terminal.opened",
        requestId: open.requestId,
        terminalId: open.terminalId,
        shell: "/bin/zsh",
        title: "Claude Code",
        initialCwd: environment.path ?? "/tmp/catchup-workspace",
        cols: open.cols,
        rows: open.rows,
      },
    });
    await settlePendingNativeTerminalOpen(thread.id);

    const browserSocket = {
      close: vi.fn(),
      send: vi.fn(),
    };
    harness.deps.terminalSessions.attachBrowserTerminal({
      terminalId: open.terminalId,
      socket: browserSocket,
      sinceSeq: 0,
      outputAcks: false,
      resizeAcks: false,
    });
    const initialAttach = daemonMessages(socket).find(
      (message) => message.type === "terminal.attach",
    );
    expect(initialAttach).toBeDefined();

    await harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: seeded.host.id,
      sessionId: seeded.session.id,
      message: {
        type: "terminal.replay",
        requestId: initialAttach!.requestId,
        terminalId: open.terminalId,
        replayStartSeq: 0,
        nextSeq: 0,
        chunks: [],
      },
    });

    harness.deps.terminalSessions.handleDaemonSessionClosed({
      sessionId: seeded.session.id,
    });
    await harness.deps.terminalSessions.reconcileDisconnectedHostTerminals({
      hostId: seeded.host.id,
      daemonSessionId: seeded.session.id,
    });

    const catchUpAttach = daemonMessages(socket)
      .filter((message) => message.type === "terminal.attach")
      .at(-1);
    expect(catchUpAttach).toBeDefined();
    expect(catchUpAttach!.requestId).not.toBe(initialAttach!.requestId);

    let sameTickHasOutput: Promise<boolean | undefined> | null = null;
    harness.hub.onChangedMessage((message) => {
      if (
        message.entity === "thread" &&
        message.id === thread.id &&
        message.changes.includes("terminals-changed") &&
        sameTickHasOutput === null
      ) {
        sameTickHasOutput = Promise.resolve(
          harness.app.request(`/api/v1/threads/${thread.id}/native-terminal`),
        ).then(async (res) =>
          nativeTerminalThreadSchema.parse(await readJson(res)).hasOutput,
        );
      }
    });

    await harness.deps.terminalSessions.handleDaemonTerminalMessage({
      hostId: seeded.host.id,
      sessionId: seeded.session.id,
      message: {
        type: "terminal.replay",
        requestId: catchUpAttach!.requestId,
        terminalId: open.terminalId,
        replayStartSeq: 0,
        nextSeq: 1,
        chunks: [
          {
            seq: 0,
            dataBase64: Buffer.from("Catch-up output\r\n", "utf8").toString(
              "base64",
            ),
          },
        ],
      },
    });

    expect(sameTickHasOutput).not.toBeNull();
    expect(await sameTickHasOutput).toBe(true);
  });
});
