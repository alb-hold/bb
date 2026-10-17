import { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createTerminalSession, getRetainedTerminalOutput } from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import {
  TerminalDataPlaneChild,
  type TerminalDataPlaneSocket,
} from "../../terminal-data-plane/data-plane-child.js";
import {
  TERMINAL_DATA_PLANE_IPC_VERSION,
  type TerminalDataPlaneChildMessage,
  type TerminalDataPlaneMainMessage,
} from "../../terminal-data-plane/ipc-contract.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../../test/helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../../../test/helpers/test-app.js";

const V = TERMINAL_DATA_PLANE_IPC_VERSION;
const harnesses: TestAppHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.cleanup();
  }
});

class FakeSocket implements TerminalDataPlaneSocket {
  bufferedAmount = 0;
  private messageListeners: Array<(data: unknown) => void> = [];

  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(
    event: "close" | "error" | "message",
    listener:
      | (() => void)
      | ((error: Error) => void)
      | ((data: unknown) => void),
  ): unknown {
    if (event === "message") {
      this.messageListeners.push(listener as (data: unknown) => void);
    }
    return this;
  }

  close(): void {}

  send(): void {}

  terminate(): void {}

  receive(message: unknown): void {
    const data =
      typeof message === "string" ? message : JSON.stringify(message);
    for (const listener of this.messageListeners) {
      listener(data);
    }
  }
}

function outputChunks(): Array<{ seq: number; dataBase64: string }> {
  return Array.from({ length: 8 }, (_, seq) => ({
    seq,
    dataBase64: Buffer.from(`R-${seq + 1}\n`).toString("base64"),
  }));
}

function textFrom(chunks: Array<{ dataBase64: string }>): string {
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
  ).toString("utf8");
}

async function setup() {
  const harness = await createTestAppHarness({
    db: createMigratedConnection(),
  });
  harnesses.push(harness);
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const thread = seedThread(harness.deps, { projectId: project.id });
  const terminal = createTerminalSession(harness.db, {
    cols: 80,
    environmentId: null,
    hostId: host.id,
    daemonSessionId: session.id,
    initialCwd: "/tmp",
    rows: 24,
    status: "running",
    threadId: thread.id,
    title: "Unwatched output",
  });
  const daemonSocket = new FakeSocket();
  const childMessages: TerminalDataPlaneChildMessage[] = [];
  const child = new TerminalDataPlaneChild({
    exit: () => undefined,
    rssBytes: () => 1,
    sendToMain: (message, onSent) => {
      childMessages.push(message);
      if (message.type === "terminal.output-batch") {
        harness.deps.terminalSessions.recordDirectTerminalOutputBatch(message);
      }
      onSent();
    },
    upgrade: async () => daemonSocket,
  });
  child.handleMainMessage(
    {
      v: V,
      type: "daemon.attach",
      daemonSessionId: session.id,
      request: { url: "/terminal-data", headers: [], headBase64: "" },
    },
    new Socket(),
  );
  await Promise.resolve();
  await Promise.resolve();
  const sendMain = (message: TerminalDataPlaneMainMessage) =>
    child.handleMainMessage(message, undefined);
  sendMain({
    v: V,
    type: "terminal.route",
    terminalId: terminal.id,
    daemonSessionId: session.id,
    mode: "data-socket",
  });
  return {
    child,
    childMessages,
    daemonSocket,
    db: harness.db,
    host,
    hub: harness.hub,
    sendMain,
    session,
    terminal,
    terminalSessions: harness.deps.terminalSessions,
  };
}

describe("terminal output retained from the data plane", () => {
  it("persists live data-socket output without a browser and reads it after exit", async () => {
    const fixture = await setup();
    for (const chunk of outputChunks()) {
      fixture.daemonSocket.receive({
        type: "terminal.output",
        terminalId: fixture.terminal.id,
        chunk,
      });
    }
    fixture.sendMain({
      v: V,
      type: "terminal.unroute",
      terminalId: fixture.terminal.id,
    });

    expect(
      fixture.childMessages.filter(
        (message) => message.type === "terminal.output-batch",
      ),
    ).toHaveLength(1);
    expect(
      getRetainedTerminalOutput(fixture.db, {
        hostId: fixture.host.id,
        terminalSessionId: fixture.terminal.id,
        now: Date.now(),
      }),
    ).toEqual(outputChunks());

    fixture.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: fixture.terminal.id,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });

    const output = await fixture.terminalSessions.readTerminalOutput({
      terminalId: fixture.terminal.id,
      query: {},
    });
    const lastLines = await fixture.terminalSessions.readTerminalOutput({
      terminalId: fixture.terminal.id,
      query: { lines: 3 },
    });
    expect(textFrom(output.chunks)).toBe(
      "R-1\nR-2\nR-3\nR-4\nR-5\nR-6\nR-7\nR-8\n",
    );
    expect(textFrom(lastLines.chunks)).toBe("R-6\nR-7\nR-8\n");
    fixture.child.shutdown();
  });

  it("replays the daemon's final chunk before marking a direct-output terminal exited", async () => {
    const fixture = await setup();
    fixture.terminalSessions.setDaemonSessionDirectOutput({
      daemonSessionId: fixture.session.id,
      enabled: true,
    });
    for (const chunk of outputChunks()) {
      fixture.daemonSocket.receive({
        type: "terminal.output",
        terminalId: fixture.terminal.id,
        chunk,
      });
    }
    fixture.hub.registerDaemon(fixture.session.id, fixture.host.id, {
      close() {},
      send(data: string) {
        const message = JSON.parse(data) as {
          requestId: string;
          terminalId: string;
          type: string;
        };
        if (message.type !== "terminal.attach") {
          return;
        }
        fixture.terminalSessions.handleDaemonTerminalMessage({
          hostId: fixture.host.id,
          sessionId: fixture.session.id,
          message: {
            type: "terminal.replay",
            requestId: message.requestId,
            terminalId: fixture.terminal.id,
            replayStartSeq: 0,
            nextSeq: 8,
            chunks: outputChunks(),
          },
        });
      },
    });

    fixture.terminalSessions.handleDaemonTerminalMessage({
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      message: {
        type: "terminal.exited",
        terminalId: fixture.terminal.id,
        exitCode: 0,
        closeReason: "process-exit",
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    fixture.sendMain({
      v: V,
      type: "terminal.unroute",
      terminalId: fixture.terminal.id,
    });

    const output = await fixture.terminalSessions.readTerminalOutput({
      terminalId: fixture.terminal.id,
      query: {},
    });
    expect(textFrom(output.chunks)).toBe(
      "R-1\nR-2\nR-3\nR-4\nR-5\nR-6\nR-7\nR-8\n",
    );
    fixture.child.shutdown();
    fixture.hub.unregisterDaemon(fixture.session.id);
  });
});
