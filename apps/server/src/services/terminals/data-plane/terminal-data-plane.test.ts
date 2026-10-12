import { fork, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import type {
  TerminalClientMessage,
  TerminalSession,
} from "@bb/server-contract";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ChildTerminalSocket } from "./child-terminal-socket.js";
import {
  startTerminalDataPlane,
  type TerminalDataPlane,
} from "./terminal-data-plane.js";

const childEntry = fileURLToPath(
  new URL("../../../terminal-data-plane/child-main.ts", import.meta.url),
);
const STEP_TIMEOUT_MS = 30_000;

const session: TerminalSession = {
  id: "term_1",
  threadId: null,
  environmentId: null,
  hostId: "host_1",
  title: "shell",
  initialCwd: "/tmp",
  cols: 80,
  rows: 24,
  status: "running",
  exitCode: null,
  closeReason: null,
  createdAt: 1,
  updatedAt: 1,
  lastUserInputAt: null,
};

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Fixture {
  children: ChildProcess[];
  detached: ChildTerminalSocket[];
  fallbackUpgrades: string[];
  inputActivity: string[];
  plane: TerminalDataPlane;
  port: number;
  received: TerminalClientMessage[];
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

async function createFixture(): Promise<Fixture> {
  const server: Server = createServer();
  const fallbackUpgrades: string[] = [];
  server.on("upgrade", (request, socket: Socket) => {
    fallbackUpgrades.push(request.url ?? "");
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
  });
  const children: ChildProcess[] = [];
  const detached: ChildTerminalSocket[] = [];
  const inputActivity: string[] = [];
  const received: TerminalClientMessage[] = [];
  const nextSeqBySocket = new Map<ChildTerminalSocket, number>();
  const plane = startTerminalDataPlane({
    guard: {
      config: { serverPort: 3001, appUrl: undefined, devAppPort: undefined },
    },
    lifecycle: {
      attach: ({ sinceSeq, socket }) => {
        nextSeqBySocket.set(socket, sinceSeq + 1);
        socket.send(
          JSON.stringify({
            type: "attached",
            session,
            replayStartSeq: sinceSeq,
            nextSeq: sinceSeq + 1,
          }),
        );
        socket.send(
          JSON.stringify({
            type: "output",
            chunk: { seq: sinceSeq, dataBase64: base64("replayed") },
          }),
        );
      },
      detach: ({ socket }) => {
        detached.push(socket);
      },
      handleMessage: ({ message, socket }) => {
        received.push(message);
        if (message.type !== "input") {
          return;
        }
        const seq = nextSeqBySocket.get(socket) ?? 0;
        nextSeqBySocket.set(socket, seq + 1);
        socket.send(
          JSON.stringify({
            type: "output",
            chunk: { seq, dataBase64: message.dataBase64 },
          }),
        );
      },
      recordInputActivity: (terminalId) => {
        inputActivity.push(terminalId);
      },
    },
    logger: { error: () => undefined, warn: () => undefined },
    resolveTerminal: (terminalId) =>
      terminalId === "term_1"
        ? { terminalId, daemonSessionId: "session_1" }
        : null,
    server,
    spawn: () => {
      const child = fork(childEntry, [], {
        execArgv: ["--conditions=source", "--import", "tsx"],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      children.push(child);
      return child;
    },
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(() => {
    plane.stop();
    for (const child of children) {
      child.kill("SIGKILL");
    }
    server.closeAllConnections();
    server.close();
  });
  return {
    children,
    detached,
    fallbackUpgrades,
    inputActivity,
    plane,
    port: (server.address() as AddressInfo).port,
    received,
  };
}

interface Client {
  closed(): boolean;
  frames: Array<Record<string, unknown>>;
  socket: WebSocket;
}

function connectClient(port: number, path: string): Client {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const frames: Array<Record<string, unknown>> = [];
  let closed = false;
  socket.on("message", (data) => {
    frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  socket.on("close", () => {
    closed = true;
  });
  socket.on("error", () => {
    closed = true;
  });
  cleanups.push(() => socket.terminate());
  return { closed: () => closed, frames, socket };
}

describe("terminal data plane", () => {
  it(
    "carries an authorized terminal through the child and leaves the rest to the server",
    async () => {
      const fixture = await createFixture();
      await until(() => fixture.plane.state === "ready", "the child");

      const client = connectClient(fixture.port, "/ws/terminals/term_1?sinceSeq=5");
      await until(() => client.frames.length >= 2, "the replay");
      client.socket.send(
        JSON.stringify({ type: "input", dataBase64: base64("typed") }),
      );
      await until(() => client.frames.length >= 3, "the echo");

      expect(client.frames).toEqual([
        { type: "attached", session, replayStartSeq: 5, nextSeq: 6 },
        { type: "output", chunk: { seq: 5, dataBase64: base64("replayed") } },
        { type: "output", chunk: { seq: 6, dataBase64: base64("typed") } },
      ]);
      expect(fixture.received).toEqual([
        { type: "input", dataBase64: base64("typed") },
      ]);
      expect(fixture.inputActivity).toEqual(["term_1"]);
      expect(fixture.plane.attachedSocketCount).toBe(1);
      expect(fixture.fallbackUpgrades).toEqual([]);

      const stranger = connectClient(fixture.port, "/ws/terminals/term_other");
      await until(() => stranger.closed(), "the unknown terminal to be refused");
      expect(fixture.fallbackUpgrades).toEqual(["/ws/terminals/term_other"]);

      client.socket.close();
      await until(() => fixture.detached.length === 1, "the detach");
      expect(fixture.plane.attachedSocketCount).toBe(0);
    },
    120_000,
  );

  it(
    "falls back to the server while the child is down and resumes after it respawns",
    async () => {
      const fixture = await createFixture();
      await until(() => fixture.plane.state === "ready", "the child");
      const client = connectClient(fixture.port, "/ws/terminals/term_1?sinceSeq=0");
      await until(() => client.frames.length >= 2, "the replay");

      fixture.children[0]?.kill("SIGKILL");
      await until(() => client.closed(), "the browser socket to drop");
      await until(() => fixture.detached.length === 1, "the detach");
      expect(fixture.plane.state).not.toBe("ready");

      const duringOutage = connectClient(
        fixture.port,
        "/ws/terminals/term_1?sinceSeq=2",
      );
      await until(() => duringOutage.closed(), "the in-process fallback");
      expect(fixture.fallbackUpgrades).toEqual(["/ws/terminals/term_1?sinceSeq=2"]);

      await until(() => fixture.plane.state === "ready", "the respawn");
      expect(fixture.children).toHaveLength(2);
      const afterRespawn = connectClient(
        fixture.port,
        "/ws/terminals/term_1?sinceSeq=2",
      );
      await until(() => afterRespawn.frames.length >= 2, "the replay after respawn");
      expect(afterRespawn.frames[0]).toMatchObject({
        type: "attached",
        replayStartSeq: 2,
        nextSeq: 3,
      });
      expect(afterRespawn.frames[1]).toEqual({
        type: "output",
        chunk: { seq: 2, dataBase64: base64("replayed") },
      });
    },
    120_000,
  );
});
